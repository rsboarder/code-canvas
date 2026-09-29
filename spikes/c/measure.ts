import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { gzipSync, inflateSync } from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { chromium, type Page } from "@playwright/test";
import { build } from "vite";

import {
  analyzeTraceEvents,
  loadTraceEvents,
  type TraceAnalysis,
} from "./trace-analysis.mjs";

interface BodyRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ScrollState {
  readonly webglFirstVisibleLine: number;
  readonly webglOffsetCssPx: number;
  readonly monacoFirstVisibleLine: number | null;
  readonly monacoOffsetCssPx: number | null;
}

interface SampleCategory {
  readonly category: "ascii" | "cjkEmoji" | "tabs";
  readonly lineNumber: number;
  readonly text: string;
  readonly glyphs: readonly SampleGlyph[];
}

interface SampleGlyph {
  readonly column: number;
  readonly xOffsetCssPx: number;
  readonly advanceCssPx: number;
}

interface WideGlyphMeasurement {
  readonly glyph: string;
  readonly codePoint: number;
  readonly advanceRatio: number;
  readonly deltaCssPx: number;
  readonly deviationFromDoubleWidthCssPx: number;
}

interface TabStopMeasurement {
  readonly probeText: string;
  readonly tabSizeCells: number;
  readonly ruleLeftCssPx: readonly number[];
  readonly monacoLeftCssPx: readonly number[];
  readonly maxDeviationCssPx: number;
}

interface BaselineMeasurement {
  readonly measuredCssPx: number | null;
  readonly formulaCssPx: number;
  readonly usedCssPx: number;
  readonly lineHeightCssPx: number;
}

interface LayoutRule {
  readonly tabSizeCells: number;
  readonly advanceCssPx: number;
  readonly gutterWidthCssPx: number;
  readonly wideGlyphs: readonly WideGlyphMeasurement[];
  readonly tabStops: TabStopMeasurement;
  readonly baseline: BaselineMeasurement;
}

interface AtlasSelfCheckResult {
  readonly glyph: string;
  readonly slug: string;
  readonly verdict: "match" | "mismatch" | "error";
  readonly detail: string;
  readonly gpuCentroidFraction: number | null;
  readonly referenceCentroidFraction: number | null;
  readonly gpuPngDataUrl: string | null;
  readonly referencePngDataUrl: string | null;
}

interface SpikePageApi {
  readonly datasetSourceCheck: {
    readonly relativePath: string;
    readonly length: number;
    readonly prefix: string;
  };
  readonly datasetCount: number;
  readonly layoutRule: LayoutRule;
  readonly atlasSelfCheck: readonly AtlasSelfCheckResult[];
  readonly sample: {
    readonly cellWidthCssPx: number;
    readonly contentLeftCssPx: number;
    readonly lineHeightCssPx: number;
    readonly lineHeightIsWholeCssPx: boolean;
    readonly categories: readonly SampleCategory[];
  };
  prepareZoom(targetZoom: number): Promise<{
    readonly requestedZoom: number;
    readonly snappedZoom: number;
    readonly lineHeightCssPx: number;
    readonly lineHeightIsWholeCssPx: boolean;
    readonly widgetBody: BodyRect;
  }>;
  enterEditing(): Promise<SwapMeasurement>;
  exitEditing(): Promise<SwapMeasurement>;
  startAction(action: string): void;
  finishAction(): ActionMetrics;
  paste500Lines(): Promise<void>;
  undo(): Promise<void>;
  switchModels(): Promise<void>;
  getState(): {
    readonly editing: boolean;
    readonly webglVisible: boolean;
    readonly zoom: number;
    readonly lineHeightCssPx: number;
    readonly scroll: ScrollState;
  };
}

interface SpikeWindow extends Window {
  spikeC?: SpikePageApi;
}

interface SwapMeasurement {
  readonly direction: "enter" | "exit";
  readonly frameMs: number;
  readonly snappedZoom: number;
  readonly lineHeightCssPx: number;
}

interface ActionMetrics {
  readonly action: string;
  readonly elapsedMs: number;
  readonly longTasks: readonly number[];
  readonly eventDurations: readonly number[];
  readonly maxTaskDurationMs: number;
  readonly tasksOver833Ms: number;
  readonly inputToNextPaintMs: number | null;
}

interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface ColumnMeasurement {
  readonly line: number;
  readonly column: number;
  readonly webglXDevicePx: number;
  readonly monacoXDevicePx: number;
  readonly deltaXDevicePx: number;
  readonly baselineOffsetDevicePx: number;
}

interface PixelComparison {
  readonly columnsMeasured: number;
  readonly maxXDeviationDevicePx: number;
  readonly p95XDeviationDevicePx: number;
  readonly maxBaselineDeviationDevicePx: number;
  readonly p95BaselineDeviationDevicePx: number;
  readonly meanColorDelta: number;
  readonly maxColorDelta: number;
  readonly columns: readonly ColumnMeasurement[];
}

interface TraceSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  once(event: string, listener: (params: unknown) => void): void;
}

const root = process.cwd();
const spikeRoot = join(root, "spikes", "c");
const resultsDirectory = join(spikeRoot, "results");
const zooms = [0.8, 1, 1.37, 2] as const;
const typedText = "const spikeTypingMarker = 'responsive';\n".repeat(6);
const pasteText = "// pasted line with JSX <Widget value={42} />\n".repeat(500);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await closeServer(server);
  if (port === 0) {
    throw new Error("Could not allocate a free port");
  }
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForServer(
  url: string,
  process: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `Vite exited before startup with code ${String(process.exitCode)}`,
      );
    }
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // The preview process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function buildProduction(outDir: string): Promise<void> {
  console.log(`[spike-c] building production page in ${outDir}`);
  await build({
    root: spikeRoot,
    configFile: join(root, "vite.config.ts"),
    build: { outDir, emptyOutDir: true },
  });
  console.log("[spike-c] production build complete");
}

function startPreview(port: number, outDir: string): ChildProcess {
  return spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--outDir",
      outDir,
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
}

async function waitForDataset(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const status = document.getElementById("status")?.textContent ?? "";
        return (
          status.startsWith("Dataset ready:") ||
          status.startsWith("Spike setup failed:")
        );
      },
      undefined,
      { timeout: 120_000 },
    );
  } catch (error) {
    let status = "<unavailable>";
    try {
      status =
        (await page.locator("#status").textContent({ timeout: 1_000 })) ??
        "<empty>";
    } catch {
      // Preserve the original timeout.
    }
    console.log(`PAGE: dataset wait timeout; status=${status}`);
    throw error;
  }
  const status = await page.locator("#status").textContent({ timeout: 30_000 });
  if (!status?.startsWith("Dataset ready:")) {
    throw new Error(status ?? "Dataset did not load");
  }
}

async function pageApi(
  page: Page,
): Promise<
  Pick<
    SpikePageApi,
    | "datasetSourceCheck"
    | "datasetCount"
    | "sample"
    | "layoutRule"
    | "atlasSelfCheck"
  >
> {
  return page.evaluate(() => {
    const api = (window as SpikeWindow).spikeC;
    if (!api) {
      throw new Error("Spike C API is not available");
    }
    return api;
  });
}

async function verifyDatasetSource(page: Page): Promise<void> {
  const api = await pageApi(page);
  if (api.datasetCount !== 200) {
    throw new Error(
      `Expected 200 dataset files, got ${String(api.datasetCount)}`,
    );
  }
  const prefix = "/fixtures/reference-dataset/";
  if (!api.datasetSourceCheck.relativePath.startsWith(prefix)) {
    throw new Error(
      `Unexpected dataset path: ${api.datasetSourceCheck.relativePath}`,
    );
  }
  const relativePath = api.datasetSourceCheck.relativePath.slice(prefix.length);
  const diskText = await readFile(
    join(root, "fixtures", "reference-dataset", relativePath),
    "utf8",
  );
  if (
    diskText.length !== api.datasetSourceCheck.length ||
    !diskText.startsWith(api.datasetSourceCheck.prefix)
  ) {
    throw new Error(`Raw dataset source mismatch for ${relativePath}`);
  }
  console.log(
    `[spike-c] verified raw dataset source: ${relativePath} (${String(diskText.length)} characters)`,
  );
}

function waitForTraceComplete(session: TraceSession): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Chrome trace"));
    }, 30_000);
    session.once("Tracing.tracingComplete", (params) => {
      clearTimeout(timeout);
      const result = params as { stream?: string };
      if (!result.stream) {
        reject(new Error("Chrome did not return a trace stream"));
        return;
      }
      void readTraceStream(session, result.stream).then(resolve, reject);
    });
  });
}

async function readTraceStream(
  session: TraceSession,
  stream: string,
): Promise<string> {
  let result = "";
  let eof = false;
  while (!eof) {
    const chunk = (await session.send("IO.read", { handle: stream })) as {
      data?: string;
      eof?: boolean;
      base64Encoded?: boolean;
    };
    const data = chunk.data ?? "";
    result += chunk.base64Encoded
      ? Buffer.from(data, "base64").toString("utf8")
      : data;
    eof = chunk.eof ?? false;
  }
  await session.send("IO.close", { handle: stream });
  return result;
}

// Matches spike A's proven-working category set (memory `navbench`/spike-common-v2 D11
// notes): "cc" carries the PipelineReporter frame-presentation events. Spike C round 2
// omitted it and every trace-based frame count came back 0 for 3 of 4 actions.
const TRACE_CATEGORIES =
  "devtools.timeline,disabled-by-default-devtools.timeline,toplevel,blink.user_timing,disabled-by-default-v8.gc,input,cc,viz,gpu,loading";

// A trace-analysis failure (zero tasks or zero frames — see
// trace-analysis.mjs) must be a reported failure for that one action, not an
// exception that aborts the whole run: round 3's fail-loud guard correctly
// caught undo's empty trace, but then threw out of `run()` and killed model
// switching along with it, which never got measured either.
type TraceAnalysisOutcome =
  | ({ readonly ok: true } & TraceAnalysis)
  | {
      readonly ok: false;
      readonly action: string;
      readonly error: string;
      readonly eventCount: number;
    };

async function recordTrace<T>(
  page: Page,
  action: string,
  callback: () => Promise<T>,
): Promise<{ readonly value: T; readonly trace: TraceAnalysisOutcome }> {
  const session = (await page
    .context()
    .newCDPSession(page)) as unknown as TraceSession;
  await session.send("Tracing.start", {
    categories: TRACE_CATEGORIES,
    transferMode: "ReturnAsStream",
  });
  let value!: T;
  try {
    value = await callback();
  } finally {
    const tracePromise = waitForTraceComplete(session);
    await session.send("Tracing.end");
    const trace = await tracePromise;
    await writeFile(
      join(resultsDirectory, `${action}.json.gz`),
      gzipSync(trace),
    );
    console.log(`[spike-c] trace written: ${action}.json.gz`);
  }
  const tracePath = join(resultsDirectory, `${action}.json.gz`);
  const events = await loadTraceEvents(tracePath);
  let trace: TraceAnalysisOutcome;
  try {
    const analysis = await analyzeTraceEvents(events, action);
    trace = { ok: true, ...analysis };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[spike-c] trace analysis failed for "${action}": ${message}`);
    trace = { ok: false, action, error: message, eventCount: events.length };
  }
  return { value, trace };
}

interface ActionResult {
  readonly inPage: ActionMetrics;
  readonly trace: TraceAnalysisOutcome;
}

async function runAction(
  page: Page,
  action: string,
  callback: () => Promise<void>,
): Promise<ActionResult> {
  const { value, trace } = await recordTrace(page, action, async () => {
    await page.evaluate((name) => {
      const api = (window as SpikeWindow).spikeC;
      if (!api) throw new Error("Spike C API is not available");
      api.startAction(name);
    }, action);
    // Short actions (paste, undo) can complete faster than a single
    // composited frame. `startAction` keeps a lightweight `editor.render`
    // rAF loop running until `finishAction`, and this padding gives it real
    // time on both sides of the action to produce PipelineReporter frames
    // inside the trace window instead of an empty trace.
    await page.waitForTimeout(500);
    await callback();
    await page.waitForTimeout(1_000);
    return page.evaluate(() => {
      const api = (window as SpikeWindow).spikeC;
      if (!api) throw new Error("Spike C API is not available");
      return api.finishAction();
    });
  });
  return { inPage: value, trace };
}

function parsePng(bytes: Buffer): PngImage {
  const signature = "89504e470d0a1a0a";
  if (bytes.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Screenshot is not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  let bitDepth = 8;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(
      `Unsupported PNG format: bitDepth=${String(bitDepth)}, colorType=${String(colorType)}`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(idat));
  const raw = new Uint8Array(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset++] ?? 0;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = filtered[sourceOffset++] ?? 0;
      const left = x >= channels ? (raw[rowStart + x - channels] ?? 0) : 0;
      const above = y > 0 ? (raw[rowStart - stride + x] ?? 0) : 0;
      const aboveLeft =
        y > 0 && x >= channels
          ? (raw[rowStart - stride + x - channels] ?? 0)
          : 0;
      raw[rowStart + x] =
        filter === 0
          ? value
          : filterByte(filter, value, left, above, aboveLeft);
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = raw[index * channels] ?? 0;
    rgba[index * 4 + 1] = raw[index * channels + 1] ?? 0;
    rgba[index * 4 + 2] = raw[index * channels + 2] ?? 0;
    rgba[index * 4 + 3] =
      colorType === 6 ? (raw[index * channels + 3] ?? 255) : 255;
  }
  return { width, height, rgba };
}

function filterByte(
  filter: number,
  value: number,
  left: number,
  above: number,
  aboveLeft: number,
): number {
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + above) & 255;
  if (filter === 3) return (value + Math.floor((left + above) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, above, aboveLeft)) & 255;
  throw new Error(`Unsupported PNG filter ${String(filter)}`);
}

function paeth(left: number, above: number, aboveLeft: number): number {
  const p = left + above - aboveLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - aboveLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? above : aboveLeft;
}

function pixel(
  image: PngImage,
  x: number,
  y: number,
): readonly [number, number, number] {
  const index = (y * image.width + x) * 4;
  return [
    image.rgba[index] ?? 0,
    image.rgba[index + 1] ?? 0,
    image.rgba[index + 2] ?? 0,
  ];
}

function inkWeight(image: PngImage, x: number, y: number): number {
  const [red, green, blue] = pixel(image, x, y);
  return Math.min(
    255,
    Math.abs(red - 30) + Math.abs(green - 30) + Math.abs(blue - 30),
  );
}

function colorDelta(
  before: PngImage,
  after: PngImage,
  x: number,
  y: number,
): number {
  const left = pixel(before, x, y);
  const right = pixel(after, x, y);
  return Math.max(
    Math.abs(left[0] - right[0]),
    Math.abs(left[1] - right[1]),
    Math.abs(left[2] - right[2]),
  );
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

interface CategoryPixelComparison extends PixelComparison {
  readonly category: SampleCategory["category"];
  readonly lineNumber: number;
}

// One dataset line per category (defect 5: ASCII-only, CJK/emoji, and tab
// lines must be reported separately, not folded into one sample block like
// round 2's single SAMPLE_LINE). `row` is the line's offset from the first
// visible line in the captured screenshot.
function compareCategory(
  before: PngImage,
  after: PngImage,
  category: SampleCategory,
  lineHeightCssPx: number,
  contentLeftCssPx: number,
  firstVisibleLine: number,
  dpr: number,
): CategoryPixelComparison {
  const lineHeight = lineHeightCssPx * dpr;
  const row = category.lineNumber - firstVisibleLine;
  const glyphs = category.glyphs.filter((glyph) => glyph.column <= 40);
  const xOffsets: number[] = [];
  const baselineOffsets: number[] = [];
  const columns: ColumnMeasurement[] = [];
  let colorSum = 0;
  let colorPixels = 0;
  let maxColorDelta = 0;
  for (const glyph of glyphs) {
    const left = Math.max(
      2,
      Math.floor(contentLeftCssPx * dpr + glyph.xOffsetCssPx * dpr),
    );
    const right = Math.min(
      before.width - 1,
      Math.ceil(left + glyph.advanceCssPx * dpr),
    );
    const top = Math.max(0, Math.floor(row * lineHeight));
    const bottom = Math.min(before.height - 1, Math.ceil(top + lineHeight));
    const positions = [before, after].map((image) => {
      let xSum = 0;
      let weightSum = 0;
      let bottomInk = -1;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const weight = inkWeight(image, x, y);
          if (weight < 18) continue;
          xSum += x * weight;
          weightSum += weight;
          bottomInk = Math.max(bottomInk, y);
          const delta = colorDelta(before, after, x, y);
          colorSum += delta;
          colorPixels += 1;
          maxColorDelta = Math.max(maxColorDelta, delta);
        }
      }
      return {
        x: weightSum > 0 ? xSum / weightSum : null,
        bottom: bottomInk,
      };
    });
    const first = positions[0];
    const second = positions[1];
    if (
      !first ||
      !second ||
      first.x === null ||
      second.x === null ||
      first.bottom < 0 ||
      second.bottom < 0
    )
      continue;
    const xOffset = second.x - first.x;
    const baselineOffset = second.bottom - first.bottom;
    xOffsets.push(Math.abs(xOffset));
    baselineOffsets.push(Math.abs(baselineOffset));
    columns.push({
      line: category.lineNumber,
      column: glyph.column,
      webglXDevicePx: first.x,
      monacoXDevicePx: second.x,
      deltaXDevicePx: xOffset,
      baselineOffsetDevicePx: baselineOffset,
    });
  }
  return {
    category: category.category,
    lineNumber: category.lineNumber,
    columnsMeasured: columns.length,
    maxXDeviationDevicePx: Math.max(...xOffsets, 0),
    p95XDeviationDevicePx: percentile(xOffsets, 0.95),
    maxBaselineDeviationDevicePx: Math.max(...baselineOffsets, 0),
    p95BaselineDeviationDevicePx: percentile(baselineOffsets, 0.95),
    meanColorDelta: colorPixels > 0 ? colorSum / colorPixels : 0,
    maxColorDelta,
    columns,
  };
}

function comparePixels(
  before: PngImage,
  after: PngImage,
  sample: SpikePageApi["sample"],
  firstVisibleLine: number,
  dpr: number,
): readonly CategoryPixelComparison[] {
  return sample.categories.map((category) =>
    compareCategory(
      before,
      after,
      category,
      sample.lineHeightCssPx,
      sample.contentLeftCssPx,
      firstVisibleLine,
      dpr,
    ),
  );
}

async function measureZoom(
  page: Page,
  zoom: number,
  dpr: number,
): Promise<{
  readonly zoom: number;
  readonly snappedZoom: number;
  readonly lineHeightCssPx: number;
  readonly lineHeightIsWholeCssPx: boolean;
  readonly before: string;
  readonly after: string;
  readonly pixels: readonly CategoryPixelComparison[];
  readonly deviationSummary: readonly {
    readonly category: SampleCategory["category"];
    readonly maxXDeviationDevicePx: number;
    readonly maxBaselineDeviationDevicePx: number;
  }[];
  readonly scroll: { before: ScrollState; after: ScrollState };
  readonly enter: SwapMeasurement;
  readonly exit: SwapMeasurement;
}> {
  const prepared = await page.evaluate((target) => {
    const api = (window as SpikeWindow).spikeC;
    if (!api) throw new Error("Spike C API is not available");
    return api.prepareZoom(target);
  }, zoom);
  const beforePath = join(
    resultsDirectory,
    `zoom-${String(zoom).replace(".", "-")}-before.png`,
  );
  const afterPath = join(
    resultsDirectory,
    `zoom-${String(zoom).replace(".", "-")}-after.png`,
  );
  const clip = {
    x: prepared.widgetBody.x,
    y: prepared.widgetBody.y,
    width: prepared.widgetBody.width,
    height: prepared.widgetBody.height,
  };
  await page.screenshot({ path: beforePath, clip, timeout: 30_000 });
  const beforeScroll = await page.evaluate(() => {
    const api = (window as SpikeWindow).spikeC;
    if (!api) throw new Error("Spike C API is not available");
    return api.getState().scroll;
  });
  const enter = await page.evaluate(async () => {
    const api = (window as SpikeWindow).spikeC;
    if (!api) throw new Error("Spike C API is not available");
    return api.enterEditing();
  });
  await page.screenshot({ path: afterPath, clip, timeout: 30_000 });
  const afterScroll = await page.evaluate(() => {
    const api = (window as SpikeWindow).spikeC;
    if (!api) throw new Error("Spike C API is not available");
    return api.getState().scroll;
  });
  const exit = await page.evaluate(async () => {
    const api = (window as SpikeWindow).spikeC;
    if (!api) throw new Error("Spike C API is not available");
    return api.exitEditing();
  });
  const before = parsePng(await readFile(beforePath));
  const after = parsePng(await readFile(afterPath));
  const api = await pageApi(page);
  const pixels = comparePixels(
    before,
    after,
    api.sample,
    beforeScroll.webglFirstVisibleLine,
    dpr,
  );
  return {
    zoom,
    snappedZoom: prepared.snappedZoom,
    lineHeightCssPx: prepared.lineHeightCssPx,
    lineHeightIsWholeCssPx: prepared.lineHeightIsWholeCssPx,
    before: beforePath,
    after: afterPath,
    pixels,
    // Per-category max |Δx| / |Δbaseline| in device px, pulled to the top
    // level so the tolerance can be judged without digging through each
    // category's full per-column `columns` array.
    deviationSummary: pixels.map((category) => ({
      category: category.category,
      maxXDeviationDevicePx: category.maxXDeviationDevicePx,
      maxBaselineDeviationDevicePx: category.maxBaselineDeviationDevicePx,
    })),
    scroll: { before: beforeScroll, after: afterScroll },
    enter,
    exit,
  };
}

interface AtlasSelfCheckSummary {
  readonly glyph: string;
  readonly slug: string;
  readonly verdict: AtlasSelfCheckResult["verdict"];
  readonly detail: string;
  readonly gpuCentroidFraction: number | null;
  readonly referenceCentroidFraction: number | null;
  readonly gpuPngPath: string | null;
  readonly referencePngPath: string | null;
}

function decodeDataUrl(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

// Called once, after the timed zoom/action captures are done (never inside
// their loops, so dumping these PNGs cannot skew any frame/task timing) —
// logs one `[spike-c] atlas self-check: ...` line per probe glyph and writes
// its GPU/Canvas2D-reference render as PNGs so the lead can look at them
// directly instead of trusting a single pass/fail verdict.
async function reportAtlasSelfCheck(
  results: readonly AtlasSelfCheckResult[],
): Promise<readonly AtlasSelfCheckSummary[]> {
  const summaries: AtlasSelfCheckSummary[] = [];
  for (const result of results) {
    console.log(
      `[spike-c] atlas self-check: glyph=${JSON.stringify(result.glyph)} verdict=${result.verdict} gpuCentroid=${result.gpuCentroidFraction?.toFixed(3) ?? "n/a"} refCentroid=${result.referenceCentroidFraction?.toFixed(3) ?? "n/a"} ${result.detail}`,
    );
    const gpuPngPath = result.gpuPngDataUrl
      ? join(resultsDirectory, `atlas-check-${result.slug}-gpu.png`)
      : null;
    const referencePngPath = result.referencePngDataUrl
      ? join(resultsDirectory, `atlas-check-${result.slug}-ref.png`)
      : null;
    if (gpuPngPath && result.gpuPngDataUrl) {
      await writeFile(gpuPngPath, decodeDataUrl(result.gpuPngDataUrl));
    }
    if (referencePngPath && result.referencePngDataUrl) {
      await writeFile(
        referencePngPath,
        decodeDataUrl(result.referencePngDataUrl),
      );
    }
    summaries.push({
      glyph: result.glyph,
      slug: result.slug,
      verdict: result.verdict,
      detail: result.detail,
      gpuCentroidFraction: result.gpuCentroidFraction,
      referenceCentroidFraction: result.referenceCentroidFraction,
      gpuPngPath,
      referencePngPath,
    });
  }
  return summaries;
}

async function run(): Promise<void> {
  await mkdir(resultsDirectory, { recursive: true });
  const buildDirectory = await mkdtemp(
    join("/private/tmp", "spike-c-preview-"),
  );
  await buildProduction(buildDirectory);
  const port = await freePort();
  console.log(`[spike-c] starting Vite preview on port ${String(port)}`);
  const preview = startPreview(port, buildDirectory);
  await waitForServer(`http://127.0.0.1:${String(port)}/`, preview);
  console.log("[spike-c] preview ready; launching headed Chrome");
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: `http://127.0.0.1:${String(port)}`,
    });
    page.setDefaultTimeout(30_000);
    page.on("console", (message) => {
      if (message.type() === "error") {
        // Chrome's synthetic "Failed to load resource" console errors don't
        // put the URL in message.text(); message.location() does. This is
        // also the only listener that ever saw round 3's 404 — the resource
        // never surfaced through page.on("response")/"requestfailed" below,
        // which strongly suggests it is a Worker-originated request
        // (Playwright's page-level network events do not cover requests
        // made from inside a dedicated Worker's own context).
        const location = message.location();
        console.log(
          `PAGE: console.error ${message.text()} (${location.url}:${String(location.lineNumber)})`,
        );
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
      console.log(`PAGE: pageerror ${error.message}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        console.log(`PAGE: ${String(response.status())} ${response.url()}`);
    });
    page.on("requestfailed", (request) => {
      console.log(
        `PAGE: requestfailed ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
      );
    });
    page.on("worker", (worker) => {
      console.log(`PAGE: worker created ${worker.url()}`);
    });
    console.log("[spike-c] navigating to production preview");
    await page.goto(`http://127.0.0.1:${String(port)}/`, {
      waitUntil: "load",
      timeout: 120_000,
    });
    console.log("[spike-c] page loaded; waiting for dataset readiness");
    await waitForDataset(page);
    await verifyDatasetSource(page);
    const pixelComparisons = [];
    for (const zoom of zooms) {
      console.log(
        `[spike-c] capturing before/after swap at requested zoom ${String(zoom)}`,
      );
      pixelComparisons.push(await measureZoom(page, zoom, 2));
    }
    await page.evaluate(async () => {
      const api = (window as SpikeWindow).spikeC;
      if (!api) throw new Error("Spike C API is not available");
      await api.prepareZoom(1);
      await api.enterEditing();
    });
    console.log("[spike-c] tracing typing at a human-like rate");
    const typing = await runAction(page, "typing", async () => {
      await page.keyboard.type(typedText, { delay: 5 });
    });
    console.log("[spike-c] tracing paste of 500 lines");
    let pasteMode = "clipboard-meta-v";
    const paste = await runAction(page, "paste-500-lines", async () => {
      try {
        await page.evaluate(
          async (text) => navigator.clipboard.writeText(text),
          pasteText,
        );
        await page.keyboard.press("Meta+V");
      } catch {
        pasteMode = "executeEdits-fallback";
        await page.evaluate(async () => {
          const api = (window as SpikeWindow).spikeC;
          if (!api) throw new Error("Spike C API is not available");
          await api.paste500Lines();
        });
      }
    });
    console.log("[spike-c] tracing undo");
    let undoMode = "keyboard-meta-z";
    const undo = await runAction(page, "undo", async () => {
      try {
        await page.keyboard.press("Meta+z");
      } catch {
        undoMode = "model-undo-fallback";
        await page.evaluate(async () => {
          const api = (window as SpikeWindow).spikeC;
          if (!api) throw new Error("Spike C API is not available");
          await api.undo();
        });
      }
    });
    console.log("[spike-c] tracing model switching");
    const modelSwitching = await runAction(
      page,
      "model-switching",
      async () => {
        await page.evaluate(async () => {
          const api = (window as SpikeWindow).spikeC;
          if (!api) throw new Error("Spike C API is not available");
          await api.switchModels();
        });
      },
    );
    const api = await pageApi(page);
    if (pageErrors.length > 0) {
      throw new Error(`Page errors were reported: ${pageErrors.join(" | ")}`);
    }
    const atlasSelfCheck = await reportAtlasSelfCheck(api.atlasSelfCheck);
    const report = {
      measuredAt: new Date().toISOString(),
      browser: "Chrome channel, headed",
      deviceScaleFactor: 2,
      viewport: { width: 1440, height: 900 },
      dataset: api.datasetSourceCheck,
      layoutRule: api.layoutRule,
      atlasSelfCheck,
      requestedZooms: zooms,
      pixelComparisons,
      actions: { typing, paste500Lines: paste, undo, modelSwitching },
      inputModes: { paste: pasteMode, undo: undoMode },
      pageErrors: pageErrors.length,
      traceFiles: [
        "typing.json.gz",
        "paste-500-lines.json.gz",
        "undo.json.gz",
        "model-switching.json.gz",
      ],
      configuration: {
        fontFamily: "Menlo",
        baseFontSizeCssPx: 14,
        baseLineHeightCssPx: 21,
        theme: "vs-dark",
        ligatures: false,
        minimap: false,
        overviewRuler: false,
        wordWrap: "off",
        codeLens: false,
        diagnostics: false,
        semanticTokens: false,
        lineNumbers: "on",
        lineNumbersMinChars: 5,
        renderLineHighlight: "none",
        cursorBlinking: "solid",
        cursorHiddenInCapture: true,
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 0,
        selectionHighlight: false,
        occurrencesHighlight: false,
        matchBrackets: "never",
      },
    };
    await writeFile(
      join(resultsDirectory, "latest.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("[spike-c] report written: spikes/c/results/latest.json");
    console.log(JSON.stringify(report));
    await context.close();
  } finally {
    await browser.close();
    preview.kill();
  }
}

await run();
