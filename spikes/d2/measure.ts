import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { build, preview } from "vite";
import type { ProgressSnapshot, SpikeResult } from "./protocol";

const RUN_TIMEOUT_MS = 420_000;
const PROGRESS_POLL_INTERVAL_MS = 5_000;

const HOST = "127.0.0.1";
const spikeRoot = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const configFile = fileURLToPath(
  new URL("../../vite.config.ts", import.meta.url),
);

async function findFreePort(): Promise<number> {
  const socket = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, HOST, resolve);
  });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  if (!address || typeof address === "string") {
    throw new Error("TCP server did not expose a free port");
  }
  return address.port;
}

async function pageStatus(page: Page): Promise<string> {
  return (
    (await page
      .locator("#status")
      .textContent({ timeout: 2_000 })
      .catch(() => null)) ?? "status unavailable"
  );
}

// Polls window.__spikeProgress while the main run is in flight and writes
// each snapshot to disk, so a timeout still leaves partial numbers behind
// instead of nothing (spike-common-v2: "write PNGs/raw data before running
// any guard"). Runs concurrently with the timed page.evaluate() below —
// this is diagnostics, not part of any timed measurement inside the page.
function startProgressPolling(page: Page): { stop: () => void } {
  const state = { stopped: false };
  const progressPath = fileURLToPath(
    new URL("./results/progress-partial.json", import.meta.url),
  );
  const loop = async (): Promise<void> => {
    while (!state.stopped) {
      await new Promise((resolve) => {
        setTimeout(resolve, PROGRESS_POLL_INTERVAL_MS);
      });
      // TypeScript's control-flow analysis doesn't invalidate narrowing
      // across `await` for externally-mutated state, so an extra
      // `if (state.stopped) return` here would read as always-false to the
      // checker/linter even though `stop()` can race it in reality. Loop
      // re-checks `state.stopped` next iteration instead; one extra
      // page.evaluate() after stop() is harmless (caught below).
      const snapshot = await page
        .evaluate(
          () =>
            (window as unknown as { __spikeProgress?: ProgressSnapshot })
              .__spikeProgress,
        )
        .catch(() => undefined);
      if (!snapshot) {
        continue;
      }
      await mkdir(new URL("./results/", import.meta.url), {
        recursive: true,
      }).catch(() => undefined);
      await writeFile(
        progressPath,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        "utf8",
      ).catch(() => undefined);
      process.stdout.write(
        `[spike-d2] progress poll: phase=${snapshot.phase} files=${String(snapshot.filesProcessed)}/${String(snapshot.totalFiles)} elapsedMs=${snapshot.elapsedMs.toFixed(0)}\n`,
      );
    }
  };
  void loop();
  return {
    stop: () => {
      state.stopped = true;
    },
  };
}

async function verifyRawSource(result: SpikeResult): Promise<SpikeResult> {
  const relativePath = result.dataset.firstFile.replace(/^\/fixtures\//u, "");
  const diskPath = join(repoRoot, "fixtures", relativePath);
  const diskText = (await readFile(diskPath)).toString("utf8");
  if (diskText.length !== result.dataset.firstFileCharacterCount) {
    throw new Error(
      `raw source length mismatch for ${diskPath}: disk=${String(diskText.length)} page=${String(result.dataset.firstFileCharacterCount)}`,
    );
  }
  if (!diskText.startsWith(result.dataset.firstFilePrefix)) {
    throw new Error(`raw source prefix mismatch for ${diskPath}`);
  }
  return {
    ...result,
    dataset: { ...result.dataset, rawSourceVerified: true },
  };
}

async function main(): Promise<void> {
  const outputDirectory = await mkdtemp(
    join("/private/tmp", "spike-d2-production-"),
  );
  let previewServer: Awaited<ReturnType<typeof preview>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await build({
      root: spikeRoot,
      configFile,
      build: { outDir: outputDirectory, emptyOutDir: true, sourcemap: true },
    });
    process.stdout.write("[spike-d2] production build done\n");
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
    process.stdout.write(`[spike-d2] preview up: ${baseUrl}\n`);
    browser = await chromium.launch({ channel: "chrome", headless: false });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    page.on("console", (message) => {
      if (
        message.type() === "error" ||
        message.text().startsWith("[spike-d2]")
      ) {
        const location = message.location();
        const locationSuffix = location.url
          ? ` (${location.url}:${String(location.lineNumber)}:${String(location.columnNumber)})`
          : "";
        process.stdout.write(
          `PAGE: ${message.type()} ${message.text()}${locationSuffix}\n`,
        );
      }
    });
    page.on("pageerror", (error) => {
      process.stdout.write(`PAGE: pageerror: ${error.message}\n`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        process.stdout.write(
          `PAGE: ${String(response.status())} ${response.request().resourceType()} ${response.url()}\n`,
        );
      }
    });
    page.on("requestfailed", (request) => {
      process.stdout.write(
        `PAGE: requestfailed ${request.resourceType()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}\n`,
      );
    });
    // The lead's reference run saw one 404 with no URL captured by the
    // response listener above; worker-initiated requests are not always
    // surfaced the same way as page requests. This at least logs when and
    // where each Worker is created, to correlate against any future 404.
    page.on("worker", (workerHandle) => {
      process.stdout.write(`PAGE: worker created: ${workerHandle.url()}\n`);
    });
    await page.goto(`${baseUrl}/`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    process.stdout.write("[spike-d2] page ready\n");
    await page.waitForFunction(
      () => typeof window.__spikeRun === "function",
      undefined,
      { timeout: 30_000 },
    );
    process.stdout.write("[spike-d2] run started: full dataset\n");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let rawResult: SpikeResult;
    const progressPoller = startProgressPolling(page);
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          void pageStatus(page).then((status) =>
            process.stdout.write(`[spike-d2] timeout status: ${status}\n`),
          );
          reject(
            new Error(
              `full-dataset run exceeded ${String(RUN_TIMEOUT_MS / 1000)} seconds`,
            ),
          );
        }, RUN_TIMEOUT_MS);
      });
      rawResult = await Promise.race([
        page.evaluate(() =>
          (
            window as unknown as {
              __spikeRun: (options: {
                fullDataset: boolean;
              }) => Promise<SpikeResult>;
            }
          ).__spikeRun({ fullDataset: true }),
        ),
        timeoutPromise,
      ]);
    } finally {
      progressPoller.stop();
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
    const result = await verifyRawSource(rawResult);
    await mkdir(new URL("./results/", import.meta.url), { recursive: true });
    await writeFile(
      new URL("./results/latest.json", import.meta.url),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write("[spike-d2] run done\n");
    process.stdout.write(
      `[spike-d2] incremental (${String(result.incremental.fileCount)} files): coldFirstWindowMs median=${result.incremental.coldFirstWindowMs.median.toFixed(2)} p95=${result.incremental.coldFirstWindowMs.p95.toFixed(2)}\n`,
    );
    process.stdout.write(
      `[spike-d2] incremental editAt10: incrementalMs median=${result.incremental.editAt10.incrementalMs.median.toFixed(2)} fullRescanMs median=${result.incremental.editAt10.fullRescanMs.median.toFixed(2)} converged=${String(result.incremental.editAt10.convergedCount)}/${String(result.incremental.fileCount)}\n`,
    );
    process.stdout.write(
      `[spike-d2] incremental editAt1000: incrementalMs median=${result.incremental.editAt1000.incrementalMs.median.toFixed(2)} fullRescanMs median=${result.incremental.editAt1000.fullRescanMs.median.toFixed(2)} converged=${String(result.incremental.editAt1000.convergedCount)}/${String(result.incremental.fileCount)}\n`,
    );
    process.stdout.write(
      `[spike-d2] incremental chunkMs (100 lines): median=${result.incremental.chunkMs.median.toFixed(2)} p95=${result.incremental.chunkMs.p95.toFixed(2)} max=${result.incremental.chunkMs.max.toFixed(2)}\n`,
    );

    process.stdout.write("[spike-d2] rendering Monaco sample for screenshot\n");
    await page.evaluate(() =>
      (
        window as unknown as {
          __spikeRenderSample: () => Promise<{ containerId: string }>;
        }
      ).__spikeRenderSample(),
    );
    const monacoScreenshotPath = fileURLToPath(
      new URL("./results/monaco-sample.png", import.meta.url),
    );
    await page
      .locator("#monaco-sample-container")
      .screenshot({ path: monacoScreenshotPath });
    process.stdout.write(
      `[spike-d2] Monaco sample screenshot saved: ${monacoScreenshotPath}\n`,
    );

    process.stdout.write("[spike-d2] encoding worker minimap PNG\n");
    const minimapResult = await page.evaluate(() =>
      (
        window as unknown as {
          __spikeMinimapPng: () => Promise<{
            base64: string;
            width: number;
            height: number;
            fileId: string;
          }>;
        }
      ).__spikeMinimapPng(),
    );
    const minimapPngPath = fileURLToPath(
      new URL("./results/minimap-sample.png", import.meta.url),
    );
    await writeFile(
      minimapPngPath,
      Buffer.from(minimapResult.base64, "base64"),
    );
    process.stdout.write(
      `[spike-d2] minimap PNG saved: ${minimapPngPath} (${String(minimapResult.width)}x${String(minimapResult.height)}, file=${minimapResult.fileId})\n`,
    );

    const guardFailures: string[] = [];
    if (!result.colorComparison.tokenizedReferenceGuardPassed) {
      guardFailures.push("tokenized-reference default-foreground guard");
    }
    if (result.colorComparison.mismatches !== 0) {
      guardFailures.push(
        `hex color mismatches=${String(result.colorComparison.mismatches)}`,
      );
    }
    if (result.syntaxSamples.sampleParityMismatches !== 0) {
      guardFailures.push(
        `Monaco sample parity mismatches=${String(result.syntaxSamples.sampleParityMismatches)}`,
      );
    }
    if (
      !result.syntaxSamples.jsxTagDistinctFromPlain ||
      !result.syntaxSamples.functionDistinctFromPlain
    ) {
      guardFailures.push(
        "JSX/function colors are not distinct from plain identifiers",
      );
    }
    if (guardFailures.length > 0) {
      process.stdout.write(
        `[spike-d2] guard failures: ${guardFailures.join(", ")}\n`,
      );
      process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await browser?.close();
    await previewServer?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
});
