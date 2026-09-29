import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { build, preview, type PreviewServer } from "vite";
import { chromium, type Page } from "@playwright/test";
import { textCoverageGuardFails, type WidgetCoverageSummary } from "./coverage";
import {
  analyzeTraceEvents,
  parseTraceEvents,
  type TraceAnalysis,
} from "./trace-analysis.mjs";

const gzipAsync = promisify(gzip);
const root = process.cwd();
const spikeRoot = join(root, "spikes", "e");
const configFile = join(spikeRoot, "vite.config.ts");
const resultsRoot = join(spikeRoot, "results");
const datasetRoot = join(root, "fixtures", "reference-dataset");
const datasetPrefix = "/fixtures/reference-dataset/";
const READY_TIMEOUT_MS = 30_000;
const PASS_TIMEOUT_MS = 180_000;
const TEARDOWN_TIMEOUT_MS = 10_000;

interface DatasetCheck {
  readonly fileId: string;
  readonly length: number;
  readonly prefix: string;
  readonly hash: string;
}

interface FrameSample {
  readonly frame: number;
  readonly zoom: number;
  readonly detailLevel: "Text" | "Minimap";
  readonly visibleWidgets: number;
  readonly visibleGlyphs: number;
  readonly cpuMs: number;
  readonly gpuMs: number | "unavailable";
  readonly rafIntervalMs: number;
}

interface MetricPercentiles {
  readonly count: number;
  readonly p50: number | "unavailable";
  readonly p95: number | "unavailable";
  readonly p99: number | "unavailable";
  readonly max: number | "unavailable";
}

interface ZoomSummary {
  readonly label: "zoom-1" | "text-threshold" | "sweep";
  readonly zoom: number;
  readonly detailLevel: "Text" | "Minimap" | "Mixed";
  readonly visibleWidgets: number;
  readonly visibleGlyphs: number;
  readonly cpuMs: MetricPercentiles;
  readonly gpuMs: MetricPercentiles;
  readonly rafIntervalMs: MetricPercentiles;
  readonly longFrames: number;
}

interface SwitchEvent {
  readonly frame: number;
  readonly from: "Text" | "Minimap";
  readonly to: "Text" | "Minimap";
}

interface SwitchCapture extends SwitchEvent {
  readonly pngAfter: string;
  readonly pngNext: string;
}

interface SweepResult {
  readonly thresholds: {
    readonly textToMinimapPx: number;
    readonly minimapToTextPx: number;
  };
  readonly hysteresisBandZoom: { readonly min: number; readonly max: number };
  readonly frames: readonly FrameSample[];
  readonly switches: readonly SwitchEvent[];
  readonly captureSwitches: readonly SwitchCapture[];
  readonly longFrames: readonly {
    readonly frame: number;
    readonly intervalMs: number;
  }[];
  readonly switchIntervals: readonly {
    readonly switchFrame: number;
    readonly intervals: readonly number[];
  }[];
  readonly levelFlips: number;
  readonly emptyFrames: number;
  readonly overlapDepth: string;
  readonly maxVisibleGlyphCount: number;
  readonly textWorstCaseZoom: number;
  readonly textWorstCaseFrame: FrameSample | undefined;
  readonly gpuFramesMeasured: number;
  readonly textGpuFramesMeasured: number;
  readonly minimapGpuP99: number | "unavailable";
  readonly minimapFrameAtThreshold: FrameSample | undefined;
  readonly minimapFrameAtFarZoom: FrameSample | undefined;
  readonly zoomSummaries: readonly ZoomSummary[];
  readonly densestText: ZoomSummary | undefined;
  readonly captureGuards: readonly CaptureGuardSample[];
}

interface CaptureGuardSample {
  readonly name: string;
  readonly kind: "Text" | "Minimap";
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  readonly dominantFraction: number;
  readonly gapForegroundFraction: number;
  readonly textCoverage: WidgetCoverageSummary | undefined;
}

interface CaptureGuardReport {
  readonly passed: boolean;
  readonly samples: readonly CaptureGuardSample[];
  readonly failures: readonly string[];
}

interface TraceSummary {
  readonly framesTotal: number;
  readonly presented: number;
  readonly dropped: number;
  readonly partial: number;
  readonly intervalsOver12_5Ms: number;
  readonly mainThreadTasks: number;
}

// Matches Spike C's proven-working category set: `cc` carries the
// PipelineReporter frame-presentation events.
const TRACE_CATEGORIES =
  "devtools.timeline,disabled-by-default-devtools.timeline,toplevel,blink.user_timing,disabled-by-default-v8.gc,input,cc,viz,gpu,loading";

interface SpikeApi {
  readonly datasetChecks: readonly DatasetCheck[];
  readonly prepared: {
    readonly files: number;
    readonly atlasBytes: number;
    readonly glyphInstances: number;
    readonly minimapWidth: number;
    readonly widgets: readonly {
      readonly index: number;
      readonly expectedVisibleLines: number;
      readonly glyphInstancesDrawn: number;
    }[];
  };
  measureTiming(): Promise<SweepResult>;
  capture(): Promise<{
    readonly switches: readonly SwitchCapture[];
    readonly legibility: readonly {
      readonly name: string;
      readonly dataUrl: string;
    }[];
    readonly guards: readonly CaptureGuardSample[];
  }>;
}

interface SpikeWindow extends Window {
  spikeE?: SpikeApi;
}

function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          "Timed out waiting for " +
            label +
            " after " +
            String(timeoutMs) +
            " ms",
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "free-port listener",
    READY_TIMEOUT_MS,
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await closeServer(server);
  if (!port) throw new Error("could not allocate a free port");
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    "temporary port server close",
    TEARDOWN_TIMEOUT_MS,
  );
}

async function buildPage(outputDirectory: string): Promise<void> {
  console.log("[spike-e] production build starting");
  await build({
    root: spikeRoot,
    configFile,
    build: { outDir: outputDirectory, emptyOutDir: true, sourcemap: true },
  });
  console.log(`[spike-e] production build done: ${outputDirectory}`);
}

async function startPreview(
  port: number,
  outputDirectory: string,
): Promise<PreviewServer> {
  return preview({
    root: spikeRoot,
    configFile,
    build: { outDir: outputDirectory },
    preview: { host: "127.0.0.1", port, strictPort: true },
  });
}

function attachDiagnostics(page: Page): void {
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log(`PAGE: console.error ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(`PAGE: pageerror ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    console.log(
      `PAGE: requestfailed ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.log(`PAGE: ${String(response.status())} ${response.url()}`);
  });
}

async function waitForReady(page: Page): Promise<void> {
  try {
    await withTimeout(
      page.waitForFunction(
        () =>
          (document.getElementById("status")?.textContent ?? "").startsWith(
            "[spike-e] ready:",
          ),
        undefined,
        { timeout: READY_TIMEOUT_MS },
      ),
      "main.ts readiness signal [spike-e] ready:",
      READY_TIMEOUT_MS,
    );
  } catch (error) {
    let status = "<unavailable>";
    try {
      status =
        (await withTimeout(
          page.locator("#status").textContent({ timeout: 1_000 }),
          "status text after readiness failure",
          2_000,
        )) ?? "<empty>";
    } catch {
      /* retain timeout */
    }
    console.log(
      "PAGE: readiness failure while waiting for main.ts signal; status=" +
        status,
    );
    throw new Error(
      "Spike E did not report main.ts readiness signal [spike-e] ready: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const status =
    (await withTimeout(
      page.locator("#status").textContent({ timeout: 1_000 }),
      "ready status text",
      2_000,
    )) ?? "<empty>";
  if (!status.startsWith("[spike-e] ready:"))
    throw new Error(
      "main.ts reported an unexpected ready status while waiting for [spike-e] ready: " +
        status,
    );
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function verifyAllRawFiles(page: Page): Promise<readonly DatasetCheck[]> {
  const checks = await withTimeout(
    page.evaluate(() => {
      const api = (window as SpikeWindow).spikeE;
      if (!api) throw new Error("Spike E API is unavailable");
      return api.datasetChecks;
    }),
    "raw dataset checks from spike page",
    READY_TIMEOUT_MS,
  );
  if (checks.length !== 200)
    throw new Error(
      `page reported ${String(checks.length)} files, expected 200`,
    );
  for (const check of checks) {
    if (!check.fileId.startsWith(datasetPrefix))
      throw new Error(`unexpected dataset path: ${check.fileId}`);
    const relative = check.fileId.slice(datasetPrefix.length);
    const diskText = await readFile(join(datasetRoot, relative), "utf8");
    if (
      diskText.length !== check.length ||
      !diskText.startsWith(check.prefix) ||
      hashText(diskText) !== check.hash
    ) {
      throw new Error(`raw dataset mismatch: ${relative}`);
    }
  }
  console.log(
    `[spike-e] verified raw text and SHA-256 for ${String(checks.length)} files`,
  );
  return checks;
}

async function writeSwitchPngs(
  switches: readonly SwitchCapture[],
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const [index, capture] of switches.entries()) {
    for (const [suffix, dataUrl] of [
      ["after", capture.pngAfter],
      ["next", capture.pngNext],
    ] as const) {
      const path = join(
        resultsRoot,
        `switch-${String(index).padStart(2, "0")}-${suffix}.png`,
      );
      const encoded = dataUrl.replace(/^data:image\/png;base64,/, "");
      await writeFile(path, Buffer.from(encoded, "base64"));
      paths.push(path);
    }
  }
  return paths;
}

async function writeLegibilityPngs(
  captures: readonly { readonly name: string; readonly dataUrl: string }[],
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const capture of captures) {
    const path = join(resultsRoot, capture.name);
    const encoded = capture.dataUrl.replace(/^data:image\/png;base64,/, "");
    await writeFile(path, Buffer.from(encoded, "base64"));
    paths.push(path);
  }
  return paths;
}

function validateCaptureGuards(
  samples: readonly CaptureGuardSample[],
): CaptureGuardReport {
  const failures: string[] = [];
  for (const sample of samples) {
    if (sample.dominantFraction > 0.9)
      failures.push(
        sample.name +
          ": dominant colour fraction " +
          sample.dominantFraction.toFixed(3) +
          " > 0.900",
      );
    if (sample.gapForegroundFraction > 0.02)
      failures.push(
        sample.name +
          ": foreground in inter-widget gaps " +
          sample.gapForegroundFraction.toFixed(3) +
          " > 0.020",
      );
    if (sample.textCoverage) {
      if (textCoverageGuardFails(sample.textCoverage))
        failures.push(
          sample.name +
            ": " +
            String(sample.textCoverage.qualifyingWidgets) +
            "/" +
            String(sample.textCoverage.widgets) +
            " widgets meet text coverage",
        );
      if (sample.textCoverage.lineBandCoverage < 0.6)
        failures.push(
          sample.name +
            ": line-band coverage " +
            sample.textCoverage.lineBandCoverage.toFixed(3) +
            " < 0.600",
        );
      if (sample.textCoverage.wideLineCoverage < 0.5)
        failures.push(
          sample.name +
            ": wide-line coverage " +
            sample.textCoverage.wideLineCoverage.toFixed(3) +
            " < 0.500",
        );
    }
  }
  return { passed: failures.length === 0, samples, failures };
}

async function summarizeTrace(traceBytes: Buffer): Promise<TraceSummary> {
  const events = parseTraceEvents(traceBytes.toString("utf8"));
  const analysis: TraceAnalysis = await analyzeTraceEvents(
    events,
    "zoom-sweep",
  );
  const presentationTimes = [...analysis.presentedFrameTimestamps].sort(
    (left, right) => left - right,
  );
  let intervalsOver12_5Ms = 0;
  for (let index = 1; index < presentationTimes.length; index += 1) {
    const previous = presentationTimes[index - 1] ?? 0;
    const current = presentationTimes[index] ?? previous;
    if (current - previous > 12_500) intervalsOver12_5Ms += 1;
  }
  return {
    framesTotal: analysis.framesTotal,
    presented: analysis.framesPresented,
    dropped: analysis.framesDropped,
    partial: analysis.framesPartiallyPresented,
    intervalsOver12_5Ms,
    mainThreadTasks: analysis.mainThreadTasks,
  };
}

async function startTrace(
  page: Page,
): Promise<{ readonly stop: () => Promise<Buffer> }> {
  const client = await withTimeout(
    page.context().newCDPSession(page),
    "Chrome tracing session creation",
    READY_TIMEOUT_MS,
  );
  const events: unknown[] = [];
  client.on("Tracing.dataCollected", (event: { value?: unknown[] }) =>
    events.push(...(event.value ?? [])),
  );
  await withTimeout(
    client.send("Tracing.start", {
      categories: TRACE_CATEGORIES,
      transferMode: "ReturnAsStream",
    }),
    "Chrome tracing start",
    READY_TIMEOUT_MS,
  );
  return {
    stop: async () => {
      const stream = await withTimeout(
        new Promise<string>((resolve, reject) => {
          client.once(
            "Tracing.tracingComplete",
            (event: { stream?: string }) => {
              resolve(event.stream ?? "");
            },
          );
          void client.send("Tracing.end").catch(reject);
        }),
        "Chrome tracing completion",
        PASS_TIMEOUT_MS,
      );
      if (stream) {
        const chunks: string[] = [];
        let eof = false;
        while (!eof) {
          const result = await withTimeout(
            client.send("IO.read", { handle: stream }),
            "Chrome trace stream read",
            READY_TIMEOUT_MS,
          );
          chunks.push(result.data);
          eof = result.eof;
        }
        await withTimeout(
          client.send("IO.close", { handle: stream }),
          "Chrome trace stream close",
          READY_TIMEOUT_MS,
        );
        return Buffer.from(chunks.join(""), "utf8");
      }
      return Buffer.from(JSON.stringify({ traceEvents: events }), "utf8");
    },
  };
}

async function run(): Promise<void> {
  await mkdir(resultsRoot, { recursive: true });
  const buildDirectory = join(
    "/private/tmp",
    `spike-e-vite-${String(process.pid)}`,
  );
  await withTimeout(
    buildPage(buildDirectory),
    "production Vite build",
    PASS_TIMEOUT_MS,
  );
  const port = await freePort();
  console.log(`[spike-e] starting Vite preview on 127.0.0.1:${String(port)}`);
  const previewServer = await withTimeout(
    startPreview(port, buildDirectory),
    "Vite preview startup",
    READY_TIMEOUT_MS,
  );
  console.log("[spike-e] preview ready; launching headed Chrome");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await withTimeout(
      chromium.launch({ channel: "chrome", headless: false }),
      "headed Chrome launch",
      READY_TIMEOUT_MS,
    );
    const context = await withTimeout(
      browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      }),
      "browser context creation",
      READY_TIMEOUT_MS,
    );
    const page = await withTimeout(
      context.newPage(),
      "page creation",
      READY_TIMEOUT_MS,
    );
    page.setDefaultTimeout(30_000);
    attachDiagnostics(page);
    console.log("[spike-e] navigating to production preview");
    await page.goto(`http://127.0.0.1:${String(port)}/`, {
      waitUntil: "load",
      timeout: 30_000,
    });
    await waitForReady(page);
    const checks = await verifyAllRawFiles(page);
    const prepared = await withTimeout(
      page.evaluate(() => {
        const api = (window as SpikeWindow).spikeE;
        if (!api) throw new Error("Spike E API is unavailable");
        return api.prepared;
      }),
      "prepared spike data",
      READY_TIMEOUT_MS,
    );
    console.log(
      `[spike-e] worker minimaps and glyph instances prepared: ${String(prepared.glyphInstances)} glyphs`,
    );
    const trace = await startTrace(page);
    console.log("[spike-e] running timing pass without screenshots");
    const timingPass = await withTimeout(
      page.evaluate(async () => {
        const api = (window as SpikeWindow).spikeE;
        if (!api) throw new Error("Spike E API is unavailable");
        return api.measureTiming();
      }),
      "timing pass completion",
      PASS_TIMEOUT_MS,
    );
    const traceBytes = await trace.stop();
    console.log(
      "[spike-e] timing pass complete; running separate capture pass",
    );
    const capturePass = await withTimeout(
      page.evaluate(async () => {
        const api = (window as SpikeWindow).spikeE;
        if (!api) throw new Error("Spike E API is unavailable");
        return api.capture();
      }),
      "capture pass completion",
      PASS_TIMEOUT_MS,
    );
    const tracePath = join(resultsRoot, "zoom-sweep-trace.json.gz");
    await writeFile(tracePath, await gzipAsync(traceBytes));
    const switchPngPaths = await writeSwitchPngs(capturePass.switches);
    const legibilityPngPaths = await writeLegibilityPngs(
      capturePass.legibility,
    );
    const captureGuards = validateCaptureGuards(capturePass.guards);
    const switchFrameTimes = timingPass.switchIntervals.flatMap(
      (value) => value.intervals,
    );
    const summary = {
      densestText: timingPass.densestText,
      detailSwitches: {
        count: timingPass.switches.length,
        maxFrameTimeMs: Math.max(0, ...switchFrameTimes),
        emptyFrames: timingPass.emptyFrames,
      },
      minimapGpuP99: timingPass.minimapGpuP99,
      trace: await summarizeTrace(traceBytes),
      atlasMemoryBytes: prepared.atlasBytes,
      preliminaryThresholds: {
        textToMinimapDevicePx: timingPass.thresholds.textToMinimapPx,
        minimapToTextDevicePx: timingPass.thresholds.minimapToTextPx,
        hysteresisBandZoom: timingPass.hysteresisBandZoom,
      },
      minimapWidth: prepared.minimapWidth,
    };
    const report = {
      measuredAt: new Date().toISOString(),
      browser: "Chrome channel, headed",
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      summary,
      prepared,
      rawFilesVerified: checks.length,
      timingPass,
      capturePass: {
        switches: capturePass.switches.map(({ frame, from, to }) => ({
          frame,
          from,
          to,
        })),
        legibilityPngPaths,
        guards: captureGuards,
      },
      tracePath,
      switchPngPaths,
    };
    await writeFile(
      join(resultsRoot, "latest.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`[spike-e] trace written: ${tracePath}`);
    console.log(
      `[spike-e] switch PNGs written: ${String(switchPngPaths.length)}`,
    );
    console.log(
      `[spike-e] legibility PNGs written: ${String(legibilityPngPaths.length)}`,
    );
    console.log(
      `[spike-e] capture guards: ${captureGuards.passed ? "passed" : "failed"} (${String(captureGuards.failures.length)} failures)`,
    );
    console.log(`[spike-e] summary: ${JSON.stringify(summary)}`);
    if (!captureGuards.passed)
      throw new Error(
        `capture guards failed after PNG write: ${captureGuards.failures.join("; ")}`,
      );
    console.log(
      JSON.stringify({
        files: checks.length,
        atlasBytes: prepared.atlasBytes,
        glyphInstances: prepared.glyphInstances,
        frames: timingPass.frames.length,
        levelFlips: timingPass.levelFlips,
        emptyFrames: timingPass.emptyFrames,
        longFrames: timingPass.longFrames.length,
        gpuFramesMeasured: timingPass.gpuFramesMeasured,
        textGpuFramesMeasured: timingPass.textGpuFramesMeasured,
        tracePath,
      }),
    );
  } finally {
    try {
      if (browser)
        await withTimeout(
          browser.close(),
          "headed Chrome teardown",
          TEARDOWN_TIMEOUT_MS,
        );
    } finally {
      await withTimeout(
        previewServer.close(),
        "Vite preview teardown",
        TEARDOWN_TIMEOUT_MS,
      );
    }
  }
}

run().catch((error: unknown) => {
  console.error(
    `[spike-e] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
});
