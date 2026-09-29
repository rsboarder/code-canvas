import { editor, languages, Uri } from "monaco-editor/editor/editor.api.js";
import { TokenMetadata } from "monaco-editor/editor/common/encodedTokenAttributes.js";
import { TokenTheme } from "monaco-editor/editor/common/languages/supports/tokenization.js";
import { TokenizationRegistry } from "monaco-editor/editor/common/languages.js";
import { vs_dark } from "monaco-editor/editor/standalone/common/themes.js";
import type {
  SpikeResult,
  TimingSummary,
  TransferMode,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

const MINIMAP_WIDTH = 256;
const MINIMAP_MAX_HEIGHT = 512;
const DATASET_FILE_COUNT = 200;
const DEFAULT_FOREGROUND_ID = 1;
const statusElement = document.querySelector<HTMLPreElement>("#status");
const resultsElement = document.querySelector<HTMLPreElement>("#results");
const workerModules = [
  "monaco-editor/editor/standalone/common/monarch/monarchCompile.js",
  "monaco-editor/editor/standalone/common/monarch/monarchLexer.js",
  "monaco-editor/languages/definitions/typescript/typescript.js",
];
const rawDatasetFiles = import.meta.glob(
  "../../fixtures/reference-dataset/**/*.{ts,tsx}",
  { query: "?raw", import: "default" },
);
const DATASET_ROOT = "/reference-dataset/";

function normalizeDatasetLoaders(): Map<string, () => Promise<unknown>> {
  const entries = Object.entries(rawDatasetFiles);
  if (entries.length !== DATASET_FILE_COUNT) {
    throw new Error(
      `raw dataset glob expected ${String(DATASET_FILE_COUNT)} entries, found ${String(entries.length)}`,
    );
  }
  const loaders = new Map<string, () => Promise<unknown>>();
  for (const [key, loader] of entries) {
    const markerIndex = key.indexOf(DATASET_ROOT);
    if (markerIndex < 0) {
      throw new Error(`raw dataset key has no reference-dataset root: ${key}`);
    }
    const fileId = `/fixtures${key.slice(markerIndex)}`;
    loaders.set(fileId, loader);
  }
  if (loaders.size !== DATASET_FILE_COUNT) {
    throw new Error(
      `normalized dataset expected ${String(DATASET_FILE_COUNT)} entries, found ${String(loaders.size)}`,
    );
  }
  return loaders;
}

const datasetLoaders = normalizeDatasetLoaders();

interface PendingRequest {
  resolve: (value: ReceivedWorkerResult) => void;
  reject: (reason: Error) => void;
  sentAt: number;
}

interface ReceivedWorkerResult {
  response: WorkerResponse;
  handlerMs: number;
  roundTripMs: number;
}

interface DatasetFile {
  fileId: string;
  text: string;
}

interface LineTokens {
  findTokenIndexAtOffset(offset: number): number;
  getCount(): number;
  getForeground(tokenIndex: number): number;
  getEndOffset(tokenIndex: number): number;
  getStartOffset(tokenIndex: number): number;
}

interface ColorValue {
  toString(): string;
}

type ColorMap = readonly (ColorValue | undefined)[];

interface MismatchTriple {
  tokenText: string;
  workerHex: string;
  monacoHex: string;
}

interface TokenizedModel {
  tokenization: {
    forceTokenization(lineNumber: number): void;
    getLineTokens(lineNumber: number): LineTokens;
  };
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
  dispose(): void;
}

interface WorkerRunOptions {
  mode: TransferMode;
  file: DatasetFile;
}

let worker: Worker | undefined;
let requestId = 0;
let contentVersion = 0;
let lastResult: SpikeResult | undefined;
const pending = new Map<number, PendingRequest>();

const theme = TokenTheme.createFromRawTokenTheme(vs_dark.rules, []);
// Monaco 0.57 color maps: TokenTheme.getColorMap is in
// editor/common/languages/supports/tokenization.js:146-147; the main-thread
// registry map is in editor/common/tokenizationRegistry.js:81-83.
const workerColorMap = theme.getColorMap();
const scopeColors = createScopeColors();
const scopePalette = createScopePalette(scopeColors);

function setStatus(message: string): void {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function setResults(result: SpikeResult): void {
  lastResult = result;
  if (resultsElement) {
    resultsElement.textContent = JSON.stringify(result, null, 2);
  }
}

function createScopeColors(): Record<string, number> {
  const colors: Record<string, number> = {};
  for (const rule of vs_dark.rules) {
    colors[rule.token] = TokenMetadata.getForeground(
      theme._match(rule.token).metadata,
    );
  }
  colors[""] = TokenMetadata.getForeground(theme._match("").metadata);
  return colors;
}

function createScopePalette(
  colors: Record<string, number>,
): Record<string, number> {
  const palette: Record<string, number> = {};
  const foregrounds = [...new Set(Object.values(colors))].sort(
    (left, right) => left - right,
  );
  if (foregrounds.length > 254) {
    throw new Error(
      `vs-dark uses ${String(foregrounds.length)} foregrounds; R8 supports 254`,
    );
  }
  foregrounds.forEach((foreground, index) => {
    palette[String(foreground)] = index + 1;
  });
  return palette;
}

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  try {
    worker = new Worker(new URL("./tokenizer.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    throw new Error(
      `worker construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  worker.onmessage = handleWorkerMessage;
  worker.onerror = handleWorkerError;
  return worker;
}

function handleWorkerMessage(event: MessageEvent<WorkerMessage>): void {
  const handlerStartedAt = performance.now();
  const message = event.data;
  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  pending.delete(message.id);
  if (message.type === "error") {
    request.reject(
      new Error(
        `${message.message}${message.stack ? `\n${message.stack}` : ""}`,
      ),
    );
    return;
  }
  request.resolve({
    response: message,
    handlerMs: performance.now() - handlerStartedAt,
    roundTripMs: performance.now() - request.sentAt,
  });
}

function handleWorkerError(event: ErrorEvent): void {
  const message = event.message || "worker module evaluation failed";
  const error = new Error(
    `${message} (${event.filename || "unknown worker module"})`,
  );
  for (const request of pending.values()) {
    request.reject(error);
  }
  pending.clear();
  worker?.terminate();
  worker = undefined;
  setStatus(`Worker failed: ${error.message}`);
}

function requestWorker(
  options: WorkerRunOptions,
): Promise<ReceivedWorkerResult> {
  const activeWorker = ensureWorker();
  const id = requestId;
  requestId += 1;
  contentVersion += 1;
  const request: WorkerRequest = {
    type: "tokenize",
    id,
    contentVersion,
    fileId: options.file.fileId,
    text: options.file.text,
    mode: options.mode,
    scopeColors,
    scopePalette,
    minimapWidth: MINIMAP_WIDTH,
    minimapMaxHeight: MINIMAP_MAX_HEIGHT,
  };
  const sentAt = performance.now();
  return new Promise<ReceivedWorkerResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, sentAt });
    activeWorker.postMessage(request);
  });
}

function datasetPath(index: number): string {
  const group = String(index % 10).padStart(2, "0");
  const kind = index % 2 === 0 ? "tsx" : "ts";
  return `/fixtures/reference-dataset/group-${group}/widget-${String(index).padStart(3, "0")}.${kind}`;
}

async function loadDataset(count: number): Promise<DatasetFile[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const fileId = datasetPath(index);
      const loadRawText = datasetLoaders.get(fileId);
      if (!loadRawText) {
        throw new Error(`raw dataset entry not found: ${fileId}`);
      }
      const text = await loadRawText();
      if (typeof text !== "string") {
        throw new Error(`raw dataset entry was not text: ${fileId}`);
      }
      return { fileId, text };
    }),
  );
}

function summarize(values: number[]): TimingSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => {
    if (sorted.length === 0) {
      return 0;
    }
    return (
      sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
      ] ?? 0
    );
  };
  return {
    count: values.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

function checksum(response: WorkerResponse): number {
  let value = 0;
  for (const color of response.colors) {
    value = (value + color) >>> 0;
  }
  for (const paletteIndex of response.minimap) {
    value = (value + paletteIndex) >>> 0;
  }
  return value;
}

function resolveHex(colorMap: ColorMap, colorId: number): string {
  return colorMap[colorId]?.toString().toUpperCase() ?? "#000000";
}

function compareColors(
  file: DatasetFile,
  response: WorkerResponse,
  monacoColorMap: ColorMap,
): {
  comparedCharacters: number;
  mismatches: number;
  defaultForegroundCharacters: number;
  nonWhitespaceCharacters: number;
  mismatchTriples: MismatchTriple[];
  firstMismatch?: string;
} {
  // Monaco 0.57 internals: tokenization is TextModel.tokenization from
  // editor/common/model/textModel.js:159; its calls are implemented in
  // editor/common/model/tokens/tokenizationTextModelPart.js:113-142.
  // Returned LineTokens methods are in editor/common/tokens/lineTokens.js:99-151.
  const model = editor.createModel(
    file.text,
    "typescript",
    Uri.parse(file.fileId),
  ) as TokenizedModel;
  model.tokenization.forceTokenization(model.getLineCount());
  let comparedCharacters = 0;
  let mismatches = 0;
  let defaultForegroundCharacters = 0;
  let nonWhitespaceCharacters = 0;
  let firstMismatch: string | undefined;
  const mismatchTriples = new Map<string, MismatchTriple>();
  for (let lineIndex = 0; lineIndex < model.getLineCount(); lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = model.getLineContent(lineNumber);
    const lineTokens = model.tokenization.getLineTokens(lineNumber);
    const workerStart = response.lineOffsets[lineIndex] ?? 0;
    for (let character = 0; character < line.length; character += 1) {
      let tokenIndex = lineTokens.findTokenIndexAtOffset(character);
      while (
        tokenIndex + 1 < lineTokens.getCount() &&
        lineTokens.getStartOffset(tokenIndex + 1) <= character
      ) {
        tokenIndex += 1;
      }
      const workerColorId = response.colors[workerStart + character] ?? 0;
      const monacoColorId = lineTokens.getForeground(tokenIndex);
      const workerHex = resolveHex(workerColorMap, workerColorId);
      const monacoHex = resolveHex(monacoColorMap, monacoColorId);
      if (!/\s/u.test(line[character] ?? "")) {
        nonWhitespaceCharacters += 1;
        if (monacoColorId === DEFAULT_FOREGROUND_ID) {
          defaultForegroundCharacters += 1;
        }
      }
      comparedCharacters += 1;
      if (workerHex !== monacoHex) {
        mismatches += 1;
        const tokenText = line.slice(
          lineTokens.getStartOffset(tokenIndex),
          lineTokens.getEndOffset(tokenIndex),
        );
        const triple: MismatchTriple = { tokenText, workerHex, monacoHex };
        const key = `${tokenText}\u0000${workerHex}\u0000${monacoHex}`;
        if (!mismatchTriples.has(key) && mismatchTriples.size < 20) {
          mismatchTriples.set(key, triple);
        }
        firstMismatch ??= `${file.fileId}:${String(lineNumber)}:${String(character)} worker=${workerHex} monaco=${monacoHex}`;
      }
    }
  }
  model.dispose();
  return {
    comparedCharacters,
    mismatches,
    defaultForegroundCharacters,
    nonWhitespaceCharacters,
    mismatchTriples: [...mismatchTriples.values()],
    ...(firstMismatch ? { firstMismatch } : {}),
  };
}

async function runMeasurement(files: DatasetFile[]): Promise<SpikeResult> {
  setStatus(
    `Running ${String(files.length)} file(s): transferable tokenization, Monaco comparison, then structured clone...`,
  );
  editor.setTheme("vs-dark");
  const typeScriptLanguage =
    await import("monaco-editor/languages/definitions/typescript/typescript.js").then(
      (module) => module.language,
    );
  languages.register({ id: "typescript" });
  languages.setMonarchTokensProvider("typescript", typeScriptLanguage);
  const monacoColorMap = TokenizationRegistry.getColorMap();
  if (!monacoColorMap) {
    throw new Error("Monaco color map is unavailable after setting vs-dark");
  }
  const workerTimes: number[] = [];
  const transferReceives: number[] = [];
  const cloneReceives: number[] = [];
  let comparedCharacters = 0;
  let mismatches = 0;
  let defaultForegroundCharacters = 0;
  let nonWhitespaceCharacters = 0;
  let firstMismatch: string | undefined;
  const mismatchTriples = new Map<string, MismatchTriple>();
  let totalLineCount = 0;
  let totalWorkerMs = 0;
  let totalMinimapBytes = 0;
  for (const file of files) {
    const received = await requestWorker({ mode: "transfer", file });
    workerTimes.push(received.response.timing.totalMs);
    transferReceives.push(received.handlerMs);
    totalLineCount += received.response.timing.lineCount;
    totalWorkerMs += received.response.timing.totalMs;
    totalMinimapBytes += received.response.minimap.byteLength;
    const comparison = compareColors(file, received.response, monacoColorMap);
    comparedCharacters += comparison.comparedCharacters;
    mismatches += comparison.mismatches;
    defaultForegroundCharacters += comparison.defaultForegroundCharacters;
    nonWhitespaceCharacters += comparison.nonWhitespaceCharacters;
    firstMismatch ??= comparison.firstMismatch;
    for (const triple of comparison.mismatchTriples) {
      const key = `${triple.tokenText}\u0000${triple.workerHex}\u0000${triple.monacoHex}`;
      if (!mismatchTriples.has(key) && mismatchTriples.size < 20) {
        mismatchTriples.set(key, triple);
      }
    }
  }
  if (
    nonWhitespaceCharacters > 0 &&
    defaultForegroundCharacters / nonWhitespaceCharacters > 0.5
  ) {
    throw new Error(
      `reference not tokenized: ${String(defaultForegroundCharacters)} of ${String(nonWhitespaceCharacters)} non-whitespace characters use the default foreground`,
    );
  }
  for (const file of files) {
    const received = await requestWorker({ mode: "clone", file });
    checksum(received.response);
    cloneReceives.push(received.handlerMs);
  }
  const bytesPerFile =
    files.length === 0 ? 0 : totalMinimapBytes / files.length;
  return {
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: window.crossOriginIsolated,
      referenceDatasetFiles: files.length,
    },
    workerModules,
    minimap: {
      width: MINIMAP_WIDTH,
      maxHeight: MINIMAP_MAX_HEIGHT,
      decimation:
        "height=min(lineCount,512); row r samples source line floor(r*lineCount/height); first non-whitespace color per column wins",
      bytesPerFile,
      totalBytes: totalMinimapBytes,
    },
    workerTiming: {
      per2000LineFile: summarize(workerTimes),
      wholeDataset: {
        fileCount: files.length,
        lineCount: totalLineCount,
        totalMs: totalWorkerMs,
      },
    },
    mainThreadReceive: {
      structuredClone: summarize(cloneReceives),
      transferable: summarize(transferReceives),
    },
    colorComparison: {
      fileCount: files.length,
      comparedCharacters,
      mismatches,
      mismatchTriples: [...mismatchTriples.values()],
      ...(firstMismatch ? { firstMismatch } : {}),
    },
  };
}

async function run(count: number): Promise<SpikeResult> {
  const files = await loadDataset(count);
  const result = await runMeasurement(files);
  setResults(result);
  setStatus(
    `Complete: ${String(files.length)} file(s), ${String(result.colorComparison.mismatches)} color mismatches.`,
  );
  return result;
}

function bindButton(id: string, action: () => Promise<void>): void {
  const button = document.querySelector<HTMLButtonElement>(`#${id}`);
  button?.addEventListener("click", () => {
    button.disabled = true;
    action()
      .catch((error: unknown) => {
        setStatus(
          `Failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

bindButton("run-sample", async () => {
  await run(1);
});

bindButton("run-dataset", async () => {
  await run(DATASET_FILE_COUNT);
});

document
  .querySelector<HTMLButtonElement>("#copy-results")
  ?.addEventListener("click", () => {
    void (async () => {
      if (!lastResult) {
        setStatus("Run a measurement before copying results.");
        return;
      }
      await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
      setStatus("Copied results as JSON.");
    })();
  });

declare global {
  interface Window {
    __spikeRun: (options?: { fullDataset?: boolean }) => Promise<SpikeResult>;
  }
}

window.__spikeRun = (options = {}) =>
  run(options.fullDataset ? DATASET_FILE_COUNT : 1);
