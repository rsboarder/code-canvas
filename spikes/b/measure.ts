import { createServer, type Server } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { chromium, type Page } from "@playwright/test";

interface MetricSummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

interface MeasurementResult {
  readonly glyphCount: number;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly drawCalls: number;
  readonly devicePixelRatio: number;
  readonly cpuFrameMs: MetricSummary;
  readonly rafIntervalMs: MetricSummary;
  readonly rafIntervals: readonly number[];
  readonly gpuFrameMs: MetricSummary | "unavailable";
  readonly gpuTimerQuery: string;
}

interface SpikePageApi {
  measure(glyphCount: number, durationMs: number): Promise<MeasurementResult>;
  readonly monacoCrossCheck: {
    readonly fontFamily: string;
    readonly fontSizeCssPx: number;
    readonly lineHeightCssPx: number;
    readonly maxGlyphXDeviationCssPx: number;
    readonly maxBaselineDeviationCssPx: number;
    readonly sampledLine: number;
    readonly sampledText: string;
  };
  readonly datasetSourceCheck: {
    readonly relativePath: string;
    readonly length: number;
    readonly prefix: string;
  };
}

interface SpikePageWindow extends Window {
  spikeB?: SpikePageApi;
}

const DURATION_MS = 5200;
const GLYPH_COUNTS = [50_000, 100_000, 200_000] as const;
const root = process.cwd();
const resultsDirectory = join(root, "spikes", "b", "results");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
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

async function waitForVite(url: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `Vite exited before startup with code ${String(process.exitCode)}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Vite");
}

function startVite(port: number): ChildProcess {
  return spawn(
    "pnpm",
    ["exec", "vite", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

async function waitForDataset(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const text = document.getElementById("status")?.textContent ?? "";
        return (
          text.startsWith("Dataset ready:") ||
          text.startsWith("Spike setup failed:")
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
      // Preserve the original timeout when the page is no longer readable.
    }
    console.log(`PAGE: dataset wait timeout; status=${status}`);
    throw error;
  }
  const status = await page.locator("#status").textContent();
  if (!status?.startsWith("Dataset ready:")) {
    throw new Error(status ?? "Dataset did not load");
  }
}

async function verifyDatasetSource(page: Page): Promise<void> {
  const sourceCheck = await page.evaluate(() => {
    const api = (window as SpikePageWindow).spikeB;
    if (!api) {
      throw new Error("Spike API is not available");
    }
    return api.datasetSourceCheck;
  });
  const datasetPrefix = "/fixtures/reference-dataset/";
  if (!sourceCheck.relativePath.startsWith(datasetPrefix)) {
    throw new Error(`Unexpected dataset path: ${sourceCheck.relativePath}`);
  }
  const relativePath = sourceCheck.relativePath.slice(datasetPrefix.length);
  const diskText = await readFile(
    join(root, "fixtures", "reference-dataset", relativePath),
    "utf8",
  );
  const diskPrefix = diskText.slice(0, sourceCheck.prefix.length);
  if (
    diskText.length !== sourceCheck.length ||
    diskPrefix !== sourceCheck.prefix
  ) {
    throw new Error(
      `Dataset source mismatch for ${relativePath}: page length=${String(sourceCheck.length)}, disk length=${String(diskText.length)}`,
    );
  }
  console.log(
    `[spike-b] verified raw dataset source: ${relativePath} (${String(diskText.length)} characters)`,
  );
}

async function measurePage(
  page: Page,
  glyphCount: number,
): Promise<MeasurementResult> {
  return page.evaluate(
    async ({ count, duration }) => {
      const api = (window as SpikePageWindow).spikeB;
      if (!api) {
        throw new Error("Spike API is not available");
      }
      return api.measure(count, duration);
    },
    { count: glyphCount, duration: DURATION_MS },
  );
}

async function run(): Promise<void> {
  console.log("[spike-b] preparing results directory");
  await mkdir(resultsDirectory, { recursive: true });
  const port = await freePort();
  console.log(`[spike-b] starting Vite on port ${String(port)}`);
  const vite = startVite(port);
  console.log("[spike-b] waiting for Vite");
  await waitForVite(`http://127.0.0.1:${String(port)}/spikes/b/`, vite);
  console.log("[spike-b] Vite ready; launching headed Chrome");
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`PAGE: console.error ${message.text()}`);
      }
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
      if (response.status() >= 400) {
        console.log(`PAGE: ${String(response.status())} ${response.url()}`);
      }
    });
    console.log("[spike-b] navigating to spike page");
    await page.goto(`http://127.0.0.1:${String(port)}/spikes/b/`, {
      waitUntil: "load",
      timeout: 120_000,
    });
    console.log("[spike-b] page load complete; waiting for dataset readiness");
    await waitForDataset(page);
    console.log("[spike-b] dataset ready; verifying source bytes");
    await verifyDatasetSource(page);
    const monacoCrossCheck = await page.evaluate(() => {
      const api = (window as SpikePageWindow).spikeB;
      if (!api) {
        throw new Error("Spike API is not available");
      }
      return api.monacoCrossCheck;
    });
    const measurements: MeasurementResult[] = [];
    for (const glyphCount of GLYPH_COUNTS) {
      console.log(
        `[spike-b] measuring ${String(glyphCount)} glyphs for ${String(DURATION_MS)} ms`,
      );
      measurements.push(await measurePage(page, glyphCount));
    }
    const report = {
      measuredAt: new Date().toISOString(),
      browser: "Chrome channel, headed",
      deviceScaleFactor: 2,
      viewport: { width: 1440, height: 900 },
      durationPerGlyphCountMs: DURATION_MS,
      font: "Menlo, 14px, 21px line height; atlas raster scale 2",
      monacoCrossCheck,
      measurements,
    };
    await writeFile(
      join(resultsDirectory, "latest.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("[spike-b] measurement report written");
    console.log(JSON.stringify(report));
    await context.close();
  } finally {
    await browser.close();
    vite.kill();
  }
}

await run();
