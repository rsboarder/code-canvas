import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import { chromium } from "@playwright/test";

const HOST = "127.0.0.1";
const spikeRoot = fileURLToPath(new URL("./", import.meta.url));
const configFile = fileURLToPath(new URL("./vite.config.ts", import.meta.url));

async function findFreePort(): Promise<number> {
  const socket = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, HOST, () => {
      resolve();
    });
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("TCP server did not expose a free port");
  }
  return address.port;
}

const outputDirectory = await mkdtemp(join(tmpdir(), "spike-d-production-"));
let previewServer: Awaited<ReturnType<typeof preview>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await build({
    root: spikeRoot,
    configFile,
    build: { outDir: outputDirectory, emptyOutDir: true, sourcemap: true },
  });
  process.stdout.write("[spike-d] production build done\n");

  const port = await findFreePort();
  previewServer = await preview({
    root: spikeRoot,
    configFile,
    build: { outDir: outputDirectory },
    preview: { host: HOST, port, strictPort: true },
  });
  const address = previewServer.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite preview did not expose a TCP address");
  }
  const baseUrl = `http://${HOST}:${String(address.port)}`;
  process.stdout.write(`[spike-d] preview up: ${baseUrl}\n`);

  browser = await chromium.launch({ channel: "chrome", headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(120_000);
  page.on("console", (message) => {
    if (message.type() === "error") {
      process.stdout.write(`PAGE: console error: ${message.text()}\n`);
    }
  });
  page.on("pageerror", (error) => {
    process.stdout.write(`PAGE: pageerror: ${error.message}\n`);
  });
  page.on("requestfailed", (request) => {
    process.stdout.write(
      `PAGE: requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown error"}\n`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      process.stdout.write(
        `PAGE: ${String(response.status())} ${response.url()}\n`,
      );
    }
  });
  await page.goto(`${baseUrl}/`, {
    waitUntil: "networkidle",
  });
  process.stdout.write("[spike-d] page ready\n");
  await page.waitForFunction(
    () => typeof window.__spikeRun === "function",
    undefined,
    { timeout: 30_000 },
  );
  process.stdout.write("[spike-d] run started: full dataset\n");
  const startedAt = performance.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let result: unknown;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("Full-dataset run exceeded 120 seconds"));
      }, 120_000);
    });
    result = await Promise.race([
      page.evaluate(() => window.__spikeRun({ fullDataset: true })),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
  const durationMs = performance.now() - startedAt;
  process.stdout.write(`[spike-d] run done: ${durationMs.toFixed(1)} ms\n`);
  await mkdir(new URL("./results/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("./results/latest.json", import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await previewServer?.close();
  await rm(outputDirectory, { recursive: true, force: true });
}
