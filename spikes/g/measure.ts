import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";

import { chromium, type Browser, type Page } from "@playwright/test";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const RESULT_DIR = resolve(ROOT, "spikes/g/results");
const ZOOMS = [0.4, 0.5, 0.75, 1, 1.33, 1.5, 2, 3, 4];
const STARTUP_TIMEOUT_MS = 30_000;
const GLOBAL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 100;

interface MeasurementSummary {
  mode: string;
  frames: number;
  worstFrameMs: number;
  p99FrameMs: number;
  worstIntervalMs: number;
  intervalsOver12_5ms: number;
  switches: { from: number; to: number; buildMs: number }[];
}

interface SpikeState {
  ready: boolean;
  datasetAvailable: boolean;
  sourcePath: string;
  sourceTextLength: number;
  sourceTextPrefix: string;
  devicePixelRatio: number;
  rasterSizes: number[];
  activeRasterSize: number;
  zoom: number;
}

interface Capture {
  zoom: number;
  atlasPath: string;
  sdfPath: string;
}

type ViteProcess = ChildProcessByStdio<null, Readable, Readable>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  });
}

async function pickFreePort(): Promise<number> {
  const portServer = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    portServer.once("error", rejectListen);
    portServer.listen(0, "127.0.0.1", () => {
      resolveListen();
    });
  });
  const address = portServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not inspect the free loopback port");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    portServer.close((error) => {
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    });
  });
  return port;
}

async function stopVite(server: ViteProcess): Promise<void> {
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

async function waitForVite(url: string, server: ViteProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let startupError: Error | undefined;
  server.once("error", (error) => {
    startupError = error instanceof Error ? error : new Error(String(error));
  });
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("Vite exited before becoming ready");
    }
    try {
      const response = await fetch(`${url}/spikes/g/`);
      if (response.ok) return;
    } catch {
      // Vite is still binding or compiling; poll until the hard deadline.
    }
    await wait(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Vite did not become ready within ${String(STARTUP_TIMEOUT_MS)} ms`,
  );
}

async function startVite(): Promise<{ process: ViteProcess; url: string }> {
  const port = await pickFreePort();
  const url = `http://127.0.0.1:${String(port)}`;
  console.log(`[spike-g] starting Vite at ${url}`);
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
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let ready = false;
  try {
    await waitForVite(url, server);
    ready = true;
    console.log(`[spike-g] Vite ready at ${url}`);
    return { process: server, url };
  } finally {
    if (!ready) await stopVite(server);
  }
}

async function waitForReady(page: Page, url: string): Promise<SpikeState> {
  await page.goto(`${url}/spikes/g/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const element = document.querySelector("#ready-state");
    return element?.textContent.startsWith("ready") ?? false;
  });
  const state = await page.evaluate(() => {
    if (!window.__spikeG) throw new Error("Spike API is unavailable");
    return window.__spikeG.getState() as unknown as SpikeState;
  });
  if (!state.ready) throw new Error("Spike page did not report ready");
  if (state.devicePixelRatio !== 2)
    throw new Error(`Expected DPR 2, got ${String(state.devicePixelRatio)}`);
  if (!state.datasetAvailable)
    throw new Error(
      "Reference Dataset is unavailable; run pnpm fixtures first",
    );
  return state;
}

async function verifySourceText(state: SpikeState): Promise<void> {
  const sourcePath = resolve(ROOT, state.sourcePath);
  const sourceText = await readFile(sourcePath, "utf8");
  const prefixMatches = sourceText.startsWith(state.sourceTextPrefix);
  if (sourceText.length !== state.sourceTextLength || !prefixMatches) {
    throw new Error(
      `Page source mismatch for ${state.sourcePath}: page length ${String(state.sourceTextLength)}, disk length ${String(sourceText.length)}, prefix match ${String(prefixMatches)}`,
    );
  }
  console.log(
    `[spike-g] source verified: ${state.sourcePath} (${String(sourceText.length)} bytes, prefix matched)`,
  );
}

async function captureScreenshots(page: Page): Promise<string[]> {
  const captures: Capture[] = [];
  for (const zoom of ZOOMS) {
    await page.evaluate((value) => window.__spikeG?.setZoom(value), zoom);
    await page.waitForTimeout(80);
    const suffix = zoom.toFixed(2).replace(".", "-");
    const atlasPath = resolve(RESULT_DIR, `atlas-${suffix}.png`);
    const sdfPath = resolve(RESULT_DIR, `sdf-stand-in-${suffix}.png`);
    await page.locator("#discrete-canvas").screenshot({ path: atlasPath });
    await page.locator("#sdf-canvas").screenshot({ path: sdfPath });
    captures.push({ zoom, atlasPath, sdfPath });
    console.log(`[spike-g] captured PNGs at zoom ${zoom.toFixed(2)}`);
  }

  const guardFailures: string[] = [];
  for (const capture of captures) {
    await page.evaluate(
      (value) => window.__spikeG?.setZoom(value),
      capture.zoom,
    );
    await page.waitForTimeout(40);
    const pixelChecks = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#sdf-canvas");
      if (!canvas) throw new Error("SDF canvas is unavailable for the guards");
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("SDF context is unavailable for the guards");
      const api = window.__spikeG;
      if (!api) throw new Error("Spike API is unavailable for the guards");
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      const dpr = window.devicePixelRatio || 1;
      const lineBands = api.getRenderedLineBands();
      let foregroundPixels = 0;
      let rightEdgeOutsideLinePixels = 0;
      const edgeStart = Math.max(0, canvas.width - 12);
      for (let index = 0; index < pixels.length; index += 4) {
        const pixelIndex = index / 4;
        const x = pixelIndex % canvas.width;
        const y = Math.floor(pixelIndex / canvas.width);
        const isForeground =
          (pixels[index] ?? 0) > 150 && (pixels[index + 2] ?? 0) > 150;
        if (!isForeground) continue;
        foregroundPixels += 1;
        const yCss = y / dpr;
        const insideLineBand = lineBands.some(
          (band) => yCss >= band.top && yCss <= band.bottom,
        );
        if (x >= edgeStart && !insideLineBand) {
          rightEdgeOutsideLinePixels += 1;
        }
      }
      return {
        foregroundRatio: foregroundPixels / (canvas.width * canvas.height),
        rightEdgeOutsideLineRatio:
          rightEdgeOutsideLinePixels / (12 * canvas.height),
      };
    });
    const zoomLabel = capture.zoom.toFixed(2);
    if (pixelChecks.foregroundRatio > 0.6) {
      guardFailures.push(
        `zoom ${zoomLabel}: ${String(Math.round(pixelChecks.foregroundRatio * 100))}% foreground; glyphs look like bars`,
      );
    }
    if (capture.zoom <= 0.75 && pixelChecks.rightEdgeOutsideLineRatio > 0.005) {
      guardFailures.push(
        `zoom ${zoomLabel}: stray right-edge foreground outside rendered text-line bands`,
      );
    }
    console.log(
      `[spike-g] checked zoom ${zoomLabel} (SDF foreground ${String(Math.round(pixelChecks.foregroundRatio * 100))}%)`,
    );
  }
  if (guardFailures.length > 0) {
    console.error(
      `[spike-g] capture guard failures after all PNGs were written:\n${guardFailures.map((failure) => `- ${failure}`).join("\n")}`,
    );
    throw new Error(`capture guards failed:\n${guardFailures.join("\n")}`);
  }
  return captures.flatMap(({ atlasPath, sdfPath }) => [atlasPath, sdfPath]);
}

async function run(): Promise<void> {
  await mkdir(RESULT_DIR, { recursive: true });
  let server: { process: ViteProcess; url: string } | undefined;
  let browser: Browser | undefined;
  const globalTimer = setTimeout(() => {
    console.error(
      `[spike-g] global timeout after ${String(GLOBAL_TIMEOUT_MS)} ms`,
    );
    if (browser) void browser.close();
    if (server) void stopVite(server.process);
  }, GLOBAL_TIMEOUT_MS);
  try {
    server = await startVite();
    browser = await chromium.launch({ channel: "chrome", headless: false });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const state = await waitForReady(page, server.url);
    await verifySourceText(state);
    console.log(`[spike-g] page ready: ${state.sourcePath}`);
    const screenshots = await captureScreenshots(page);
    const midGesture = await page.evaluate(
      () =>
        window.__spikeG?.runZoomSequence(
          "mid-gesture",
        ) as Promise<MeasurementSummary>,
    );
    const debounced = await page.evaluate(
      () =>
        window.__spikeG?.runZoomSequence(
          "debounced",
        ) as Promise<MeasurementSummary>,
    );
    console.log("[spike-g] mid-gesture switch done");
    console.log("[spike-g] debounced switch done");
    const summary = {
      state,
      screenshots,
      atlasSizeChange: { midGesture, debounced },
    };
    await writeFile(
      resolve(RESULT_DIR, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(`[spike-g] results: ${resolve(RESULT_DIR, "summary.json")}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    clearTimeout(globalTimer);
    if (browser) await browser.close();
    if (server) await stopVite(server.process);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message }));
  process.exitCode = 1;
});
