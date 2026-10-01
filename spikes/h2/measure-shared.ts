import { mkdir, rename, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  chromium,
  type Browser,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import { planEvents } from "../../perf/harness/driver";
import { scenarioSchema, type Scenario } from "../../perf/scenarios/schema";
import { runWithCap, RunTimedOutError } from "./pure";

export const ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../..",
);
export const RESULT_DIR = resolve(ROOT, "spikes/h2/results");
export const DOC_PATH = resolve(ROOT, "docs/spikes/h2.md");
export const STARTUP_TIMEOUT_MS = 30_000;
export const CELL_TIMEOUT_MS = 30_000;
export const POLL_MS = 100;
export const RUNS = 3;
export const VIEWPORT_WIDTH = 1200;
export const VIEWPORT_HEIGHT = 720;
export const SCENE_TEXT_PIXEL_THRESHOLD = 100;
export const TEXT_THRESHOLD_DEVICE_PX = 9;
export const EXPECTED_DPR = 2;
export const DENSITY_ZOOM =
  TEXT_THRESHOLD_DEVICE_PX / (DEFAULT_CODE_FONT.lineHeight * EXPECTED_DPR);
export const PRODUCT_BACKGROUND = [24, 30, 40] as const;
export const WIDGET_BACKGROUND = [31, 38, 51] as const;
export const RENDERERS = ["tiles-main", "tiles-worker", "atlas"] as const;
export const STAGES = [
  "smoke",
  "validate",
  "time",
  "trace",
  "summary",
] as const;
export type Renderer = (typeof RENDERERS)[number];
export type Stage = (typeof STAGES)[number];

export const SCENARIOS: readonly {
  readonly key: string;
  readonly scenario: Scenario;
  readonly camera: readonly [number, number, number];
}[] = [
  {
    key: "pan",
    camera: [0, 0, 1],
    scenario: scenarioSchema.parse({
      name: "Pan across the whole canvas at zoom 1.0",
      setup: { dataset: "reference" },
      steps: [
        { kind: "pan", x: 600, y: 400, dx: 1_800, dy: 900, durationMs: 5_000 },
      ],
      durationMs: 5_000,
    }),
  },
  {
    key: "zoom",
    camera: [0, 0, 1],
    scenario: scenarioSchema.parse({
      name: 'Zoom from "Fit all" to 4.0 and back',
      setup: { dataset: "reference" },
      steps: [
        { kind: "pinch", scaleFactor: 2, x: 600, y: 400, durationMs: 2_000 },
        { kind: "pinch", scaleFactor: 0.25, x: 600, y: 400, durationMs: 2_000 },
        { kind: "pinch", scaleFactor: 2, x: 600, y: 400, durationMs: 2_000 },
        { kind: "wait", ms: 2_000 },
      ],
      durationMs: 8_000,
    }),
  },
  {
    key: "density",
    camera: [0, 0, DENSITY_ZOOM],
    scenario: scenarioSchema.parse({
      name: "Worst-case text density",
      setup: { dataset: "reference" },
      steps: [
        { kind: "pan", x: 600, y: 400, dx: 900, dy: -500, durationMs: 4_000 },
      ],
      durationMs: 4_000,
    }),
  },
  {
    // (380, 400) is inside widget 0's body (x 0-760, body y 40-940 at zoom
    // 1), away from its edges, so the plain (non-ctrl) wheel at that point
    // scrolls the widget's content, not the camera. Widget 0 must hold more
    // than 3000 px of content: the gesture ends 1500 px down, so the final
    // capture shows lines that only a working scroll can put on screen.
    key: "scroll",
    camera: [0, 0, 1],
    scenario: scenarioSchema.parse({
      name: "Drag, resize and scroll inside a widget",
      setup: { dataset: "reference" },
      steps: [
        { kind: "scroll", x: 380, y: 400, dy: 3_000, durationMs: 1_000 },
        { kind: "wait", ms: 500 },
        { kind: "scroll", x: 380, y: 400, dy: -1_500, durationMs: 1_000 },
      ],
      durationMs: 2_500,
    }),
  },
];

// Net of the scroll scenario's plan (3000 px down, 1500 px up): the validate
// stage checks getState().scrollOffset against this within one line height.
export const SCROLL_EXPECTED_FINAL_OFFSET = 1_500;

type ViteProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface PageState {
  readonly ready: boolean;
  readonly widgetCount: number;
  readonly datasetAvailable: boolean;
  readonly devicePixelRatio: number;
  readonly zoom: number;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly scrollWidgetIndex: number | null;
  readonly scrollOffset: number;
}

export interface RuntimeMetrics {
  readonly [key: string]: unknown;
  readonly renderer?: Renderer;
  readonly atlasGestureViolations?: number;
  readonly atlasTextureCreations?: number;
  readonly detailLevel?: string;
  readonly flatDetailFrames?: number;
}

export interface ValidationResult {
  readonly expectedGlyphs: number;
  readonly actualGlyphs: number;
  readonly expectedTileArea: number;
  readonly actualTileArea: number;
  readonly nonBackgroundPixels: number;
  readonly expectedTextOutsideWidgetPixels: number;
  readonly actualTextOutsideWidgetPixels: number;
  readonly glError: string | null;
}

export interface CellStatus {
  readonly stage: Stage;
  readonly renderer: Renderer;
  readonly scenario: string;
  readonly status: "pass" | "fail" | "timed-out";
  readonly reason?: string;
  readonly elapsedMs: number;
  readonly stepReached?: string;
  readonly gestureElapsedMs?: number;
  readonly runWallTimesMs?: readonly number[];
  readonly runtime?: RuntimeMetrics;
  readonly validation?: ValidationResult;
  readonly atlasGestureViolationCounter?: string;
  readonly tracePath?: string;
  readonly trace?: Record<string, unknown>;
  readonly textMaskIoU?: number;
}

export class TimedRunError extends Error {
  constructor(
    message: string,
    readonly completedRuns: readonly RuntimeMetrics[],
    readonly stepReached: string,
    readonly runWallTimesMs: readonly number[],
  ) {
    super(message);
    this.name = "TimedRunError";
  }
}

export class EventRunTimedOutError extends Error {
  constructor(
    message: string,
    readonly stepReached: string,
  ) {
    super(message);
    this.name = "EventRunTimedOutError";
  }
}

export class ValidationGestureError extends Error {
  constructor(
    message: string,
    readonly elapsedMs: number,
    readonly stepReached: string,
    readonly runtime?: RuntimeMetrics,
    readonly validation?: ValidationResult,
    readonly atlasGestureViolationCounter?: string,
  ) {
    super(message);
    this.name = "ValidationGestureError";
  }
}

export function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export function stageLine(
  stage: Stage,
  renderer: Renderer,
  scenario: string,
  status: string,
  elapsedMs: number,
): void {
  console.log(
    `[spike h2] stage=${stage} cell=${renderer}-${scenario} status=${status} elapsed=${String(Math.round(elapsedMs))}ms`,
  );
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export function cellPath(
  stage: Stage,
  renderer: Renderer,
  scenario: string,
): string {
  return resolve(RESULT_DIR, stage, `${renderer}-${scenario}.json`);
}

export function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function scenarioEntry(key: string) {
  const entry = SCENARIOS.find((item) => item.key === key);
  if (!entry) throw new Error(`unknown scenario ${key}`);
  return entry;
}

export function selectedRenderers(
  value: string | undefined,
): readonly Renderer[] {
  if (!value) return RENDERERS;
  if (!RENDERERS.includes(value as Renderer))
    throw new Error(`unknown renderer ${value}`);
  return [value as Renderer];
}

export function selectedScenarios(
  value: string | undefined,
): readonly string[] {
  if (!value) return SCENARIOS.map((item) => item.key);
  scenarioEntry(value);
  return [value];
}

export function shortScenario(entry: (typeof SCENARIOS)[number]): Scenario {
  const steps = entry.scenario.steps.map((step) => {
    if (step.kind === "wait") return { ...step, ms: Math.min(step.ms, 250) };
    if ("durationMs" in step)
      return { ...step, durationMs: Math.min(step.durationMs, 1_000) };
    return step;
  });
  const durationMs = steps.reduce(
    (total, step) =>
      total +
      (step.kind === "wait"
        ? step.ms
        : "durationMs" in step
          ? step.durationMs
          : 0),
    0,
  );
  return scenarioSchema.parse({ ...entry.scenario, steps, durationMs });
}

export async function pickFreePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not inspect the free port");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  return port;
}

export async function stopVite(server: ViteProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    wait(2_000).then(() => false),
  ]);
  if (!exited) {
    server.kill("SIGKILL");
    await once(server, "exit").catch(() => undefined);
  }
}

export async function startVite(): Promise<{
  process: ViteProcess;
  url: string;
}> {
  const port = await pickFreePort();
  const url = `http://127.0.0.1:${String(port)}`;
  const server = spawn(
    "pnpm",
    [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("Vite exited before becoming ready");
    try {
      if ((await fetch(`${url}/spikes/h2/`)).ok)
        return { process: server, url };
    } catch {
      // Vite is still binding.
    }
    await wait(POLL_MS);
  }
  await stopVite(server);
  throw new Error(
    `Vite did not become ready within ${String(STARTUP_TIMEOUT_MS)} ms`,
  );
}

export async function waitForReady(
  page: Page,
  url: string,
  renderer: Renderer,
  flags = "",
): Promise<PageState> {
  await page.goto(
    `${url}/spikes/h2/?renderer=${renderer}${flags ? `&${flags}` : ""}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLElement>("#ready-state");
    return element?.textContent.startsWith("ready") ?? false;
  });
  const state = await page.evaluate(() => {
    if (!window.__spikeH2) throw new Error("Spike H2 API is unavailable");
    return window.__spikeH2.getState() as unknown as PageState;
  });
  if (!state.ready || !state.datasetAvailable)
    throw new Error("Reference Dataset unavailable; run pnpm fixtures first");
  if (state.widgetCount !== 200)
    throw new Error(`Expected 200 widgets, got ${String(state.widgetCount)}`);
  if (state.devicePixelRatio !== 2)
    throw new Error(`Expected DPR 2, got ${String(state.devicePixelRatio)}`);
  return state;
}

export async function withBrowser<T>(
  callback: (
    context: Awaited<ReturnType<Browser["newContext"]>>,
    url: string,
  ) => Promise<T>,
): Promise<T> {
  const server = await startVite();
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      deviceScaleFactor: 2,
    });
    return await callback(context, server.url);
  } finally {
    if (context)
      await Promise.race([context.close().catch(() => undefined), wait(2_000)]);
    await Promise.race([browser.close().catch(() => undefined), wait(2_000)]);
    await stopVite(server.process);
  }
}

export async function closePage(page: Page): Promise<void> {
  await Promise.race([
    page.close({ runBeforeUnload: false }).catch(() => undefined),
    wait(2_000),
  ]);
}

export async function preparePage(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  url: string,
  renderer: Renderer,
  flags = "",
): Promise<Page> {
  const page = await context.newPage();
  page.on("console", (message) => {
    console.log(`PAGE: ${message.type()} ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(`PAGE: error ${error.message}`);
  });
  await waitForReady(page, url, renderer, flags);
  return page;
}

export async function setupCamera(
  page: Page,
  camera: readonly [number, number, number],
): Promise<void> {
  await page.evaluate(([x, y, zoom]) => {
    if (!window.__spikeH2) throw new Error("Spike H2 API is unavailable");
    // resetMetrics() clears the tile cache and its raster zoom back to the
    // page's initial 1; setCamera() must run after, so its settleZoom(zoom)
    // establishes the raster zoom for a non-1.0 starting camera (density).
    window.__spikeH2.resetMetrics();
    window.__spikeH2.setCamera(x, y, zoom);
  }, camera);
  await wait(100);
}

// Chrome turns a trackpad pinch into ctrl+wheel with deltaY = -100 * ln(scale);
// the harness driver's linear (scale - 1) * -100 does not reach the planned scale.
export function planGestureEvents(
  scenario: Scenario,
): ReturnType<typeof planEvents> {
  let offsetMs = 0;
  return scenario.steps.flatMap((step) => {
    const stepEvents = planEvents({ ...scenario, steps: [step] }, 120);
    const pinchDeltaY =
      step.kind === "pinch"
        ? (-100 * Math.log(step.scaleFactor)) /
          stepEvents.filter((event) => event.method !== "wait").length
        : undefined;
    const shifted = stepEvents.map((event) => ({
      ...event,
      atMs: event.atMs + offsetMs,
      params:
        pinchDeltaY === undefined
          ? event.params
          : { ...event.params, deltaY: pinchDeltaY },
    }));
    offsetMs +=
      step.kind === "wait"
        ? step.ms
        : "durationMs" in step
          ? step.durationMs
          : 0;
    return shifted;
  });
}

function readWaitMilliseconds(event: {
  readonly params: Readonly<Record<string, unknown>>;
}): number {
  const milliseconds = event.params.ms;
  return typeof milliseconds === "number" ? milliseconds : 0;
}

export async function runEventsWithCap(
  cdp: CDPSession,
  scenario: Scenario,
  capMs: number,
): Promise<{ readonly elapsedMs: number; readonly stepReached: string }> {
  const events = planGestureEvents(scenario);
  // A mutable object, not a `let`, so the abort flag set inside the onTimeout
  // closure below is a property read (not narrowed to a stale literal) at
  // the catch site.
  const state = { aborted: false };
  // Events go out on schedule without awaiting each ack, as a trackpad would:
  // awaiting acks serialized the gesture at ~45 ms per event (5x its plan).
  const dispatch = async (): Promise<{
    readonly elapsedMs: number;
    readonly stepReached: string;
  }> => {
    const started = performance.now();
    const acks: Promise<unknown>[] = [];
    for (const event of events) {
      if (state.aborted) break;
      const remaining = event.atMs - (performance.now() - started);
      if (remaining > 0) await wait(remaining);
      if (event.method === "wait") {
        // A trailing "wait" step (e.g. the 2 s settle after a pinch) must
        // actually be slept, not just used as the next event's atMs anchor:
        // skipping it ended the gesture early and cut the drain time Chrome
        // needs to deliver already-dispatched wheel events to the page.
        const waitMs = readWaitMilliseconds(event);
        if (waitMs > 0) await wait(waitMs);
        continue;
      }
      acks.push(
        cdp.send(event.method as Parameters<CDPSession["send"]>[0], {
          ...event.params,
        }),
      );
    }
    await Promise.all(acks);
    return { elapsedMs: performance.now() - started, stepReached: "gesture" };
  };
  try {
    return await runWithCap(dispatch, capMs, async () => {
      state.aborted = true;
      await Promise.race([cdp.detach().catch(() => undefined), wait(250)]);
    });
  } catch (error: unknown) {
    if (error instanceof RunTimedOutError || state.aborted)
      throw new EventRunTimedOutError(
        error instanceof Error ? error.message : String(error),
        "gesture",
      );
    throw error;
  }
}
