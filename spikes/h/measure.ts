import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { Readable } from "node:stream";

import { chromium, type Browser, type Page } from "@playwright/test";
import { decodePng, type Rgba } from "./png";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const RESULT_DIR = resolve(ROOT, "spikes/h/results");
const ZOOMS = [0.75, 1, 1.37, 2] as const;
const ALPHA_MODES = ["straight", "premultiplied"] as const;
const STARTUP_TIMEOUT_MS = 30_000;
const GLOBAL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 100;
const SHIFT_LIMIT = 12;
const STALE_MAX_LUMINANCE_DIFFERENCE = 2;
const VARIANTS = [
  { key: "dom", selector: "DOM", file: "dom" },
  { key: "atlasExact", selector: "Atlas, exact size", file: "atlas-exact" },
  {
    key: "atlasPhased",
    selector: "Atlas, exact size + phases",
    file: "atlas-phased",
  },
  {
    key: "atlasDiscrete",
    selector: "Atlas, discrete set",
    file: "atlas-discrete",
  },
  { key: "canvas", selector: "Canvas2D raster", file: "canvas" },
  {
    key: "canvasStale",
    selector: "Canvas2D, stale during gesture",
    file: "canvas-stale",
  },
] as const;

type AlphaMode = (typeof ALPHA_MODES)[number];
type VariantKey = (typeof VARIANTS)[number]["key"];
interface Comparison {
  readonly dx: number;
  readonly dy: number;
  readonly meanAbsoluteLuminanceDifference: number;
  readonly inkRatio: number;
  readonly meanHorizontalGradientRatio: number;
}

interface CostSample {
  readonly rasterMs?: number;
  readonly uploadMs?: number;
  readonly buildMs?: number;
  readonly textureBytes: number;
}

interface SpikeState {
  readonly ready: boolean;
  readonly datasetAvailable: boolean;
  readonly sourcePath: string;
  readonly sourceTextLength: number;
  readonly sourceTextPrefix: string;
  readonly devicePixelRatio: number;
}

type ViteProcess = ChildProcessByStdio<null, Readable, Readable>;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function pickFreePort(): Promise<number> {
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

async function startVite(): Promise<{
  readonly process: ViteProcess;
  readonly url: string;
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
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let startupError: Error | undefined;
  server.once("error", (error) => {
    startupError = error instanceof Error ? error : new Error(String(error));
  });
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("Vite exited before becoming ready");
    try {
      if ((await fetch(`${url}/spikes/h/`)).ok) return { process: server, url };
    } catch {
      // Poll until Vite has bound the free port.
    }
    await wait(POLL_INTERVAL_MS);
  }
  await stopVite(server);
  throw new Error(
    `Vite did not become ready within ${String(STARTUP_TIMEOUT_MS)} ms`,
  );
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "ascii");
  const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc, 0);
  return Buffer.concat([header, data, trailer]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(image: Rgba): Buffer {
  const rows = Buffer.alloc(image.height * (image.width * 4 + 1));
  const stride = image.width * 4;
  for (let y = 0; y < image.height; y += 1) {
    rows[y * (stride + 1)] = 0;
    Buffer.from(
      image.data.buffer,
      image.data.byteOffset + y * stride,
      stride,
    ).copy(rows, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function cropAndEnlarge(image: Rgba): Rgba {
  const width = Math.min(100, image.width);
  const height = Math.min(40, image.height);
  const enlarged = {
    width: width * 4,
    height: height * 4,
    data: new Uint8Array(width * height * 16 * 4),
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * image.width + x) * 4;
      for (let yy = 0; yy < 4; yy += 1) {
        for (let xx = 0; xx < 4; xx += 1) {
          const target = ((y * 4 + yy) * enlarged.width + x * 4 + xx) * 4;
          enlarged.data.set(image.data.subarray(source, source + 4), target);
        }
      }
    }
  }
  return enlarged;
}

function luminance(image: Rgba, x: number, y: number): number {
  const index = (y * image.width + x) * 4;
  return (
    0.2126 * (image.data[index] ?? 0) +
    0.7152 * (image.data[index + 1] ?? 0) +
    0.0722 * (image.data[index + 2] ?? 0)
  );
}

function thresholdFor(image: Rgba): number {
  const values = Array.from(
    { length: image.width * image.height },
    (_, index) =>
      luminance(image, index % image.width, Math.floor(index / image.width)),
  );
  values.sort((left, right) => left - right);
  const background = luminance(image, 0, 0);
  const percentile =
    values[Math.min(values.length - 1, Math.floor(values.length * 0.995))] ??
    background;
  return background + (percentile - background) * 0.1;
}

function compare(dom: Rgba, candidate: Rgba): Comparison {
  let best = { difference: Number.POSITIVE_INFINITY, dx: 0, dy: 0 };
  for (let dy = -SHIFT_LIMIT; dy <= SHIFT_LIMIT; dy += 1) {
    for (let dx = -SHIFT_LIMIT; dx <= SHIFT_LIMIT; dx += 1) {
      let total = 0;
      let count = 0;
      for (let y = 0; y < dom.height; y += 1) {
        const sourceY = y + dy;
        if (sourceY < 0 || sourceY >= candidate.height) continue;
        for (let x = 0; x < dom.width; x += 1) {
          const sourceX = x + dx;
          if (sourceX < 0 || sourceX >= candidate.width) continue;
          total += Math.abs(
            luminance(dom, x, y) - luminance(candidate, sourceX, sourceY),
          );
          count += 1;
        }
      }
      const difference = count === 0 ? Number.POSITIVE_INFINITY : total / count;
      if (difference < best.difference) best = { difference, dx, dy };
    }
  }
  const threshold = thresholdFor(dom);
  let domInk = 0;
  let candidateInk = 0;
  let domGradient = 0;
  let candidateGradient = 0;
  for (let y = 0; y < dom.height; y += 1) {
    const sourceY = y + best.dy;
    if (sourceY < 0 || sourceY >= candidate.height) continue;
    for (let x = 0; x < dom.width; x += 1) {
      const sourceX = x + best.dx;
      if (sourceX < 0 || sourceX >= candidate.width) continue;
      if (luminance(dom, x, y) > threshold) domInk += 1;
      if (luminance(candidate, sourceX, sourceY) > threshold) candidateInk += 1;
      if (x + 1 < dom.width && sourceX + 1 < candidate.width) {
        domGradient += Math.abs(
          luminance(dom, x + 1, y) - luminance(dom, x, y),
        );
        candidateGradient += Math.abs(
          luminance(candidate, sourceX + 1, sourceY) -
            luminance(candidate, sourceX, sourceY),
        );
      }
    }
  }
  return {
    dx: best.dx,
    dy: best.dy,
    meanAbsoluteLuminanceDifference: best.difference,
    inkRatio: domInk === 0 ? 0 : candidateInk / domInk,
    meanHorizontalGradientRatio:
      domGradient === 0 ? 0 : candidateGradient / domGradient,
  };
}

function meanLuminanceDifference(first: Rgba, second: Rgba): number {
  const width = Math.min(first.width, second.width);
  const height = Math.min(first.height, second.height);
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      total += Math.abs(luminance(first, x, y) - luminance(second, x, y));
    }
  }
  return total / (width * height);
}

function summarizeCost(samples: readonly CostSample[]): Record<string, number> {
  const first = samples[0];
  if (!first) return { rasterMs: 0, uploadMs: 0, buildMs: 0, textureBytes: 0 };
  return {
    rasterMs: median(samples.map((sample) => sample.rasterMs ?? 0)),
    uploadMs: median(samples.map((sample) => sample.uploadMs ?? 0)),
    buildMs: median(samples.map((sample) => sample.buildMs ?? 0)),
    textureBytes: median(samples.map((sample) => sample.textureBytes)),
  };
}

async function waitForReady(page: Page, url: string): Promise<SpikeState> {
  await page.goto(`${url}/spikes/h/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    return (
      document.querySelector("#ready-state")?.textContent.startsWith("ready") ??
      false
    );
  });
  const state = await page.evaluate(() => {
    if (!window.__spikeH) throw new Error("Spike H API is unavailable");
    return window.__spikeH.getState();
  });
  if (!state.ready || !state.datasetAvailable)
    throw new Error(
      "Reference Dataset is unavailable; run pnpm fixtures first",
    );
  if (state.devicePixelRatio !== 2)
    throw new Error(`Expected DPR 2, got ${String(state.devicePixelRatio)}`);
  return state;
}

async function verifySourceText(state: SpikeState): Promise<void> {
  const source = await readFile(resolve(ROOT, state.sourcePath), "utf8");
  if (
    source.length !== state.sourceTextLength ||
    !source.startsWith(state.sourceTextPrefix)
  )
    throw new Error("Page source does not match the fixture on disk");
}

async function captureVariant(page: Page, selector: string): Promise<Buffer> {
  return page
    .locator(`[data-variant="${selector}"]`)
    .screenshot({ type: "png" });
}

async function captureAll(
  page: Page,
  zoom: number,
  alphaMode: AlphaMode,
): Promise<Record<VariantKey, Buffer>> {
  await page.evaluate(
    ({ zoom: nextZoom, alpha }) => {
      if (!window.__spikeH) throw new Error("Spike H API is unavailable");
      window.__spikeH.setAlphaMode(alpha);
      window.__spikeH.setZoom(nextZoom);
    },
    { zoom, alpha: alphaMode },
  );
  await page.waitForTimeout(60);
  const captures = await Promise.all(
    VARIANTS.map(
      async (variant) =>
        [variant.key, await captureVariant(page, variant.selector)] as const,
    ),
  );
  return Object.fromEntries(captures) as Record<VariantKey, Buffer>;
}

async function run(): Promise<void> {
  await mkdir(RESULT_DIR, { recursive: true });
  let server:
    { readonly process: ViteProcess; readonly url: string } | undefined;
  let browser: Browser | undefined;
  const timeout = setTimeout(() => {
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
    const captures: Record<string, unknown>[] = [];
    const sanityFailures: string[] = [];
    for (const zoom of ZOOMS) {
      const byAlpha = new Map<AlphaMode, Record<VariantKey, Buffer>>();
      for (const alphaMode of ALPHA_MODES)
        byAlpha.set(alphaMode, await captureAll(page, zoom, alphaMode));
      const dom = decodePng(
        byAlpha.get("premultiplied")?.dom ?? Buffer.alloc(0),
      );
      const variants: Record<string, unknown> = {};
      const chosenImages = new Map<VariantKey, Rgba>();
      for (const variant of VARIANTS) {
        const comparisons = ALPHA_MODES.map((alphaMode) => {
          const image = decodePng(
            byAlpha.get(alphaMode)?.[variant.key] ?? Buffer.alloc(0),
          );
          return { alphaMode, image, comparison: compare(dom, image) };
        });
        const best = comparisons.reduce((left, right) =>
          left.comparison.meanAbsoluteLuminanceDifference <=
          right.comparison.meanAbsoluteLuminanceDifference
            ? left
            : right,
        );
        chosenImages.set(variant.key, best.image);
        if (
          Math.abs(best.comparison.dx) === SHIFT_LIMIT ||
          Math.abs(best.comparison.dy) === SHIFT_LIMIT
        ) {
          sanityFailures.push(
            `shift-limit: ${variant.key} at zoom ${zoom.toFixed(2)} reached ±${String(SHIFT_LIMIT)} device px`,
          );
        }
        const suffix = zoom.toFixed(2).replace(".", "-");
        const normalPath = resolve(RESULT_DIR, `${variant.file}-${suffix}.png`);
        const magnifiedPath = resolve(
          RESULT_DIR,
          `${variant.file}-${suffix}-4x.png`,
        );
        await writeFile(
          normalPath,
          best.alphaMode === "premultiplied"
            ? (byAlpha.get("premultiplied")?.[variant.key] ?? Buffer.alloc(0))
            : (byAlpha.get("straight")?.[variant.key] ?? Buffer.alloc(0)),
        );
        await writeFile(magnifiedPath, encodePng(cropAndEnlarge(best.image)));
        variants[variant.key] = {
          selectedAlphaMode: best.alphaMode,
          png: normalPath,
          magnifiedPng: magnifiedPath,
          comparison: best.comparison,
          alphaModes: Object.fromEntries(
            comparisons.map((item) => [item.alphaMode, item.comparison]),
          ),
        };
      }
      if (zoom === 1) {
        const canvasImage = chosenImages.get("canvas");
        const staleImage = chosenImages.get("canvasStale");
        if (canvasImage && staleImage) {
          const difference = meanLuminanceDifference(canvasImage, staleImage);
          if (difference > STALE_MAX_LUMINANCE_DIFFERENCE) {
            sanityFailures.push(
              `stale-canvas: zoom 1 Canvas2D differs from stale WebGL by ${difference.toFixed(2)} luminance (limit ${String(STALE_MAX_LUMINANCE_DIFFERENCE)})`,
            );
          }
        }
      }
      captures.push({ zoom, variants });
    }
    if (sanityFailures.length > 0) {
      throw new Error(`SANITY CHECK FAILED: ${sanityFailures.join("; ")}`);
    }
    const costs = await page.evaluate(() => {
      if (!window.__spikeH) throw new Error("Spike H API is unavailable");
      return window.__spikeH.measureCosts();
    });
    const result = {
      state,
      captures,
      costs: {
        canvas2d: {
          fortyLines: summarizeCost(costs.canvas.fortyLines),
          twoThousandLines: summarizeCost(costs.canvas.twoThousandLines),
        },
        atlas: {
          exact: summarizeCost(costs.atlas.exact),
          phased: summarizeCost(costs.atlas.phased),
        },
      },
    };
    const summaryPath = resolve(RESULT_DIR, "summary.json");
    await writeFile(summaryPath, JSON.stringify(result, null, 2));
    console.log(`[spike-h] results: ${summaryPath}`);
  } finally {
    clearTimeout(timeout);
    if (browser) await browser.close();
    if (server) await stopVite(server.process);
  }
}

run().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
