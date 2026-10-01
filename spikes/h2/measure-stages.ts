import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Browser, CDPSession } from "@playwright/test";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import { decodePng } from "../h/png";
import { analyzeTrace } from "./trace-processor";
import {
  atomicWriteJson,
  type CellStatus,
  cellPath,
  closePage,
  CELL_TIMEOUT_MS,
  SCENE_TEXT_PIXEL_THRESHOLD,
  SCROLL_EXPECTED_FINAL_OFFSET,
  EventRunTimedOutError,
  preparePage,
  type PageState,
  RESULT_DIR,
  type RuntimeMetrics,
  RUNS,
  scenarioEntry,
  shortScenario,
  setupCamera,
  stageLine,
  TimedRunError,
  ValidationGestureError,
  withBrowser,
  runEventsWithCap,
  wait,
  type Renderer,
} from "./measure-shared";
import { captureScene, createTextMask } from "./measure-capture";
import {
  atlasGestureViolationCounter,
  buildTextMask,
  countTextOutsideWidgetGaps,
  dilateMask,
  gestureSpeedReason,
  bestShiftIoU,
  TEXT_MASK_MAX_SHIFT_PX,
  TEXT_MASK_IOU_THRESHOLD,
} from "./pure";
import type { Scenario } from "../../perf/scenarios/schema";

export async function validateCell(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  url: string,
  renderer: Renderer,
  scenarioKey: string,
  smoke: boolean,
): Promise<Omit<CellStatus, "elapsedMs">> {
  const entry = scenarioEntry(scenarioKey);
  const page = await preparePage(context, url, renderer, "validation=1");
  try {
    await setupCamera(page, entry.camera);
    await wait(250);
    const before = (await page.evaluate(
      () => window.__spikeH2?.getMetrics() ?? {},
    )) as RuntimeMetrics;
    const restValidation = await page.evaluate(() =>
      window.__spikeH2?.getValidation(),
    );
    await page.evaluate(() => window.__spikeH2?.disableValidationLint());
    const cdp = await context.newCDPSession(page);
    const gesture = await runEventsWithCap(cdp, shortScenario(entry), 10_000);
    await page.evaluate(() => window.__spikeH2?.endGesture());
    await wait(150);
    if (renderer !== "atlas") {
      const expectedArea = await page.evaluate(
        () => window.__spikeH2?.getValidation().expectedTileArea ?? 0,
      );
      await waitForTileReplacement(page, scenarioKey, expectedArea);
    } else {
      // The atlas now pre-builds widget buffers in bounded (<=2ms) frame
      // slices instead of synchronously in-frame; give the queue time to
      // catch up on the visible set before reading the glyph count.
      const expectedGlyphs = await page.evaluate(
        () => window.__spikeH2?.getValidation().expectedGlyphs ?? 0,
      );
      await waitForAtlasText(page, expectedGlyphs);
    }
    const validation = await page.evaluate(() =>
      window.__spikeH2?.getValidation(),
    );
    const runtime = (await page.evaluate(
      () => window.__spikeH2?.getMetrics() ?? {},
    )) as RuntimeMetrics;
    const pngPath = resolve(
      RESULT_DIR,
      smoke ? "smoke" : "validate",
      `${renderer}-${scenarioKey}.png`,
    );
    const scene = await captureScene(page, pngPath);
    const sceneMask = createTextMask(scene);
    if (!validation || !restValidation)
      throw new Error("validation-api-unavailable");
    const state = (await page.evaluate(() =>
      window.__spikeH2?.getState(),
    )) as unknown as PageState;
    // The gap invariant needs the colour text actually added, not a fixed
    // distance from the two reference backgrounds (that false-positives on
    // compositor noise/screenshot-edge pixels that are present either way):
    // force the same camera to a no-text frame and diff against it.
    await page.evaluate(() => window.__spikeH2?.setForceFlat(true));
    await wait(50);
    const flatScene = await captureScene(
      page,
      pngPath.replace(/\.png$/u, "-flat.png"),
    );
    await page.evaluate(() => window.__spikeH2?.setForceFlat(false));
    const textOutsideWidgetPixels = countTextOutsideWidgetGaps(
      scene,
      flatScene,
      state.cameraX,
      state.cameraY,
      state.zoom,
      state.devicePixelRatio,
    );
    const speedReason = gestureSpeedReason(
      gesture.elapsedMs,
      shortScenario(entry).durationMs,
    );
    const plannedZoom = shortScenario(entry).steps.reduce(
      (product, step) =>
        step.kind === "pinch" ? product * step.scaleFactor : product,
      entry.camera[2],
    );
    const finalZoom = state.zoom;
    const zoomReason =
      Math.abs(finalZoom / plannedZoom - 1) > 0.02
        ? "validation-final-zoom-mismatch"
        : undefined;
    const validationEvidence = {
      ...validation,
      nonBackgroundPixels: sceneMask.count,
      expectedTextOutsideWidgetPixels: 0,
      actualTextOutsideWidgetPixels: textOutsideWidgetPixels,
    };
    const atlasCounter =
      renderer === "atlas"
        ? atlasGestureViolationCounter(before, runtime)
        : undefined;
    const reason =
      speedReason ??
      zoomReason ??
      (validation.glError
        ? "validation-webgl-error"
        : sceneMask.count < SCENE_TEXT_PIXEL_THRESHOLD
          ? "validation-pixels-below-threshold"
          : validation.actualGlyphs <= 0
            ? "validation-glyph-count-zero"
            : renderer === "atlas" &&
                validation.actualGlyphs !== validation.expectedGlyphs
              ? "validation-glyph-count-mismatch"
              : renderer !== "atlas" &&
                  Math.abs(
                    validation.actualTileArea - validation.expectedTileArea,
                  ) > 1
                ? "validation-tile-area-mismatch"
                : textOutsideWidgetPixels > 0
                  ? "validation-text-outside-widget"
                  : renderer === "atlas" &&
                      (atlasCounter !== undefined ||
                        (runtime.atlasGestureViolations ?? 0) > 0)
                    ? "validation-atlas-gesture-invariant"
                    : renderer !== "atlas" &&
                        scenarioKey === "zoom" &&
                        (runtime.tilesRasterizedDuringGesture ?? 0) >
                          (before.tilesRasterizedDuringGesture ?? 0)
                      ? "validation-tile-raster-during-zoom"
                      : renderer !== "atlas" &&
                          (runtime.atlasTextureCreations ?? 0) !== 0
                        ? "validation-tile-atlas-recreated"
                        : scenarioKey === "density" &&
                            runtime.detailLevel !== "text"
                          ? "validation-detail-not-text"
                          : renderer !== "atlas" &&
                              scenarioKey === "zoom" &&
                              typeof runtime.timeToSharpMs !== "number"
                            ? "validation-time-to-sharp-missing"
                            : scenarioKey === "scroll" &&
                                Math.abs(
                                  state.scrollOffset -
                                    SCROLL_EXPECTED_FINAL_OFFSET,
                                ) > DEFAULT_CODE_FONT.lineHeight
                              ? "validation-scroll-offset-mismatch"
                              : undefined);
    if (reason)
      throw new ValidationGestureError(
        reason,
        gesture.elapsedMs,
        gesture.stepReached,
        runtime,
        validationEvidence,
        atlasCounter,
      );
    return {
      stage: smoke ? "smoke" : "validate",
      renderer,
      scenario: scenarioKey,
      status: "pass",
      runtime,
      stepReached: "capture",
      gestureElapsedMs: gesture.elapsedMs,
      validation: {
        ...validationEvidence,
      },
    };
  } finally {
    await closePage(page);
  }
}

export async function timedCell(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  url: string,
  renderer: Renderer,
  scenarioKey: string,
): Promise<Omit<CellStatus, "elapsedMs">> {
  const entry = scenarioEntry(scenarioKey);
  const page = await preparePage(context, url, renderer, "timing=1");
  try {
    const cdp = await context.newCDPSession(page);
    const runs: RuntimeMetrics[] = [];
    const runWallTimesMs: number[] = [];
    try {
      for (let run = 0; run <= RUNS; run += 1) {
        await setupCamera(page, entry.camera);
        const gesture = await runEventsWithCap(
          cdp,
          entry.scenario,
          CELL_TIMEOUT_MS,
        );
        await page.evaluate(() => window.__spikeH2?.endGesture());
        if (renderer !== "atlas") {
          // timeToSharpMs is only set once replacement tiles finish
          // uploading after settle; reading metrics right after endGesture()
          // always raced that. For "zoom" specifically, waitForTileCoverage
          // is not a safe proxy for "raced": it is satisfied by the stale
          // fallback tiles draw() keeps showing while the replacement is
          // still in flight (see waitForTimeToSharp's comment), so it must
          // poll the real signal instead.
          const expectedArea = await page.evaluate(
            () => window.__spikeH2?.getValidation().expectedTileArea ?? 0,
          );
          await waitForTileReplacement(page, scenarioKey, expectedArea);
        }
        runWallTimesMs.push(gesture.elapsedMs);
        const speedReason = gestureSpeedReason(
          gesture.elapsedMs,
          entry.scenario.durationMs,
        );
        if (speedReason)
          throw new TimedRunError(
            speedReason,
            runs,
            gesture.stepReached,
            runWallTimesMs,
          );
        if (run > 0)
          runs.push(
            await page.evaluate(() => window.__spikeH2?.getMetrics() ?? {}),
          );
      }
    } catch (error: unknown) {
      if (error instanceof TimedRunError) throw error;
      throw new TimedRunError(
        error instanceof Error ? error.message : String(error),
        runs,
        error instanceof EventRunTimedOutError ? error.stepReached : "gesture",
        runWallTimesMs,
      );
    }
    const worst =
      runs
        .slice()
        .sort(
          (left, right) =>
            Number(right.jsFrameP99Ms ?? 0) - Number(left.jsFrameP99Ms ?? 0),
        )[0] ?? {};
    return {
      stage: "time",
      renderer,
      scenario: scenarioKey,
      status: "pass",
      runtime: { ...worst, runs },
      stepReached: "gesture",
      runWallTimesMs,
    };
  } finally {
    await closePage(page);
  }
}

async function readTracingStream(
  cdp: CDPSession,
  handle: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let complete = false;
  while (!complete) {
    const part = await cdp.send("IO.read", { handle });
    const data = typeof part.data === "string" ? part.data : "";
    chunks.push(
      part.base64Encoded === true
        ? Buffer.from(data, "base64")
        : Buffer.from(data),
    );
    complete = part.eof;
  }
  await cdp.send("IO.close", { handle });
  return Buffer.concat(chunks);
}

async function waitForTileCoverage(
  page: import("@playwright/test").Page,
  expectedArea: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const covered = await page.evaluate(
      () => window.__spikeH2?.getMetrics().coveredTileArea ?? 0,
    );
    if (Math.abs(covered - expectedArea) <= 1) return;
    await wait(50);
  }
}

// Root cause (task H2 round 10, item 3): waitForTileCoverage is satisfied by
// the STALE fallback tiles the zoom scenario keeps showing while a
// replacement is still rasterizing (tiles.ts draw()'s coverageTiles reads
// from the fallback set whenever one is active) — and because the zoom
// scenario's camera returns close to its starting position, those fallback
// tiles already cover close to expectedArea within the first poll, well
// before TileRenderer.replacementReadyAt is ever set. Two earlier fixes both
// adjusted *when* metrics were read against that same proxy condition, which
// cannot fix a proxy that is satisfied by data from before the replacement
// even starts. Polling the real signal (timeToSharpMs becoming a number)
// instead of the coverage proxy is the actual fix.
async function waitForTimeToSharp(
  page: import("@playwright/test").Page,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await page.evaluate(
      () => window.__spikeH2?.getMetrics().timeToSharpMs,
    );
    if (typeof value === "number") return;
    await wait(50);
  }
}

async function waitForTileReplacement(
  page: import("@playwright/test").Page,
  scenarioKey: string,
  expectedArea: number,
): Promise<void> {
  if (scenarioKey === "zoom") {
    await waitForTimeToSharp(page);
    return;
  }
  await waitForTileCoverage(page, expectedArea);
}

async function waitForAtlasText(
  page: import("@playwright/test").Page,
  expectedGlyphs: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const actual = await page.evaluate(
      () => window.__spikeH2?.getValidation().actualGlyphs ?? 0,
    );
    if (actual >= expectedGlyphs) return;
    await wait(50);
  }
}

async function recordProtoTrace(
  cdp: CDPSession,
  scenario: Scenario,
  tracePath: string,
): Promise<Record<string, unknown>> {
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    streamFormat: "proto",
    traceConfig: {
      includedCategories: [
        "cc",
        "viz",
        "gpu",
        "benchmark",
        "disabled-by-default-devtools.timeline.frame",
        "devtools.timeline",
        "v8",
        "v8.execute",
        "disabled-by-default-v8.cpu_profiler",
        "disabled-by-default-v8.gc",
      ],
    },
  });
  const complete = new Promise<{ stream: string }>(
    (resolveComplete, rejectComplete) =>
      cdp.once("Tracing.tracingComplete", (event) => {
        if (event.stream) resolveComplete({ stream: event.stream });
        else
          rejectComplete(
            new Error("TRACE FAILED: tracingComplete had no stream"),
          );
      }),
  );
  try {
    await runEventsWithCap(cdp, scenario, CELL_TIMEOUT_MS);
  } finally {
    await cdp.send("Tracing.end");
  }
  const result = await complete;
  const bytes = await readTracingStream(cdp, result.stream);
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, bytes);
  return analyzeTrace(tracePath) as unknown as Record<string, unknown>;
}

export async function traceCell(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  url: string,
  renderer: Renderer,
  scenario: string,
): Promise<Omit<CellStatus, "elapsedMs">> {
  const page = await preparePage(context, url, renderer);
  try {
    const entry = scenarioEntry(scenario);
    const cdp = await context.newCDPSession(page);
    await setupCamera(page, entry.camera);
    const tracePath = resolve(
      RESULT_DIR,
      "trace",
      `${renderer}-${scenario}.pftrace`,
    );
    const trace = await recordProtoTrace(cdp, entry.scenario, tracePath);
    const runtime = (await page.evaluate(
      () => window.__spikeH2?.getMetrics() ?? {},
    )) as RuntimeMetrics;
    return {
      stage: "trace",
      renderer,
      scenario,
      status: "pass",
      tracePath,
      trace,
      runtime,
      stepReached: "capture",
    };
  } finally {
    await closePage(page);
  }
}

async function readCellTextMask(
  renderer: Renderer,
  scenario: string,
): Promise<{ readonly mask: Uint8Array; readonly width: number } | undefined> {
  const base = resolve(RESULT_DIR, "validate", `${renderer}-${scenario}`);
  try {
    const [withText, withoutText] = await Promise.all([
      readFile(`${base}.png`),
      readFile(`${base}-flat.png`),
    ]);
    const captured = decodePng(withText);
    const flat = decodePng(withoutText);
    const mask = dilateMask(
      buildTextMask(captured, flat),
      captured.width,
      captured.height,
    );
    return { mask, width: captured.width };
  } catch {
    return undefined; // The cell did not validate (no capture to compare).
  }
}

// Runs after every cell of the validate stage is written: the atlas is the
// renderer-independent reference (its drawn glyph count matches the expected
// count exactly), so a tile renderer whose text mask no longer overlaps it
// is a real rendering defect, not just a counter mismatch.
export async function runCrossRendererCheck(
  scenarios: readonly string[],
): Promise<void> {
  for (const scenario of scenarios) {
    const atlas = await readCellTextMask("atlas", scenario);
    if (!atlas) continue;
    for (const renderer of ["tiles-main", "tiles-worker"] as const) {
      const tile = await readCellTextMask(renderer, scenario);
      if (!tile?.width || tile.width !== atlas.width) continue;
      const aligned = bestShiftIoU(
        atlas.mask,
        tile.mask,
        atlas.width,
        TEXT_MASK_MAX_SHIFT_PX,
      );
      const iou = aligned.iou;
      const path = cellPath("validate", renderer, scenario);
      let existing: CellStatus;
      try {
        existing = JSON.parse(await readFile(path, "utf8")) as CellStatus;
      } catch {
        continue; // The tile cell itself never wrote a result; nothing to annotate.
      }
      const belowThreshold = iou < TEXT_MASK_IOU_THRESHOLD;
      await atomicWriteJson(path, {
        ...existing,
        textMaskIoU: iou,
        textMaskShiftPx: [aligned.dx, aligned.dy],
        ...(belowThreshold && existing.status === "pass"
          ? { status: "fail", reason: "validation-differs-from-atlas" }
          : {}),
      });
      stageLine(
        "validate",
        renderer,
        scenario,
        belowThreshold ? "fail" : existing.status,
        0,
      );
    }
  }
}

export async function runCells(
  stage: "smoke" | "validate" | "time",
  renderers: readonly Renderer[],
  scenarios: readonly string[],
  resume: boolean,
): Promise<number> {
  let failures = 0;
  for (const renderer of renderers)
    for (const scenario of scenarios) {
      const path = cellPath(stage, renderer, scenario);
      if (resume) {
        try {
          await readFile(path, "utf8");
          stageLine(stage, renderer, scenario, "resumed", 0);
          continue;
        } catch {
          // The cell is not complete yet.
        }
      }
      const started = performance.now();
      let result: Omit<CellStatus, "elapsedMs">;
      try {
        result = await withBrowser(async (context, url) =>
          stage === "time"
            ? timedCell(context, url, renderer, scenario)
            : validateCell(context, url, renderer, scenario, stage === "smoke"),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof EventRunTimedOutError;
        const timedRun = error instanceof TimedRunError ? error : undefined;
        const validationGesture =
          error instanceof ValidationGestureError ? error : undefined;
        const stepReached =
          timedRun?.stepReached ??
          validationGesture?.stepReached ??
          (timedOut && error instanceof EventRunTimedOutError
            ? error.stepReached
            : undefined);
        result = {
          stage,
          renderer,
          scenario,
          status: timedOut ? "timed-out" : "fail",
          reason: message,
          stepReached: stepReached ?? "load",
          ...(validationGesture?.runtime
            ? { runtime: validationGesture.runtime }
            : {}),
          ...(validationGesture?.validation
            ? { validation: validationGesture.validation }
            : {}),
          ...(validationGesture?.atlasGestureViolationCounter
            ? {
                atlasGestureViolationCounter:
                  validationGesture.atlasGestureViolationCounter,
              }
            : {}),
          ...(validationGesture
            ? { gestureElapsedMs: validationGesture.elapsedMs }
            : {}),
          ...(timedRun ? { runWallTimesMs: timedRun.runWallTimesMs } : {}),
          ...(timedRun ? { runtime: { runs: timedRun.completedRuns } } : {}),
        };
        failures += 1;
      }
      const elapsedMs = performance.now() - started;
      await atomicWriteJson(path, { ...result, elapsedMs });
      stageLine(stage, renderer, scenario, result.status, elapsedMs);
    }
  return failures;
}

export async function runTrace(
  renderers: readonly Renderer[],
  scenarios: readonly string[],
): Promise<number> {
  let failures = 0;
  await withBrowser(async (context, url) => {
    for (const renderer of renderers)
      for (const scenario of scenarios) {
        const started = performance.now();
        let result: Omit<CellStatus, "elapsedMs">;
        try {
          result = await traceCell(context, url, renderer, scenario);
        } catch (error: unknown) {
          failures += 1;
          result = {
            stage: "trace",
            renderer,
            scenario,
            status: "fail",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        const elapsedMs = performance.now() - started;
        await atomicWriteJson(cellPath("trace", renderer, scenario), {
          ...result,
          elapsedMs,
        });
        stageLine("trace", renderer, scenario, result.status, elapsedMs);
      }
  });
  return failures;
}
