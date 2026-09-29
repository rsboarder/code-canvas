import { editor, languages, Uri } from "monaco-editor/editor/editor.api.js";
import {
  DARK_PLUS_COLORS,
  createMonacoState,
  createTextMateRuntime,
  grammarForScope,
  initialState,
  toHex,
  toMonacoThemeRules,
} from "./textmate";
import type {
  IncrementalTimingSummary,
  IncrementalWorkerRequest,
  IncrementalWorkerResponse,
  IncrementalWorkerResult,
  ProgressSnapshot,
  SampleTokenParity,
  SpikeResult,
  SyntaxSample,
  TimingSummary,
  TransferMode,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

const DATASET_FILE_COUNT = 200;
const SUBSET_FILE_COUNT = 20;
const PROGRESS_LOG_INTERVAL = 20;
const MINIMAP_WIDTH = 256;
const MINIMAP_MAX_HEIGHT = 512;
const SAMPLE_FILE = `function renderWidget(plainIdentifier: string) {
  const helperValue = plainIdentifier.trim();
  return <Widget value={helperValue} className="demo"><div>{helperValue}</div></Widget>;
}
renderWidget(plainIdentifier);
`;
const SCREENSHOT_SAMPLE = `function renderWidget(plainIdentifier: string) {
  const helperValue = plainIdentifier.trim();
  return <Widget value={helperValue} label="demo" />;
}
`;
const statusElement = document.querySelector<HTMLPreElement>("#status");
const resultsElement = document.querySelector<HTMLPreElement>("#results");
const rawDatasetFiles = import.meta.glob(
  "../../fixtures/reference-dataset/**/*.{ts,tsx}",
  { query: "?raw", import: "default" },
);
const DATASET_MARKER = "/fixtures/reference-dataset/";

interface DatasetFile {
  fileId: string;
  text: string;
}

interface PendingRequest {
  resolve: (value: ReceivedMessage) => void;
  reject: (reason: Error) => void;
}

interface ReceivedMessage {
  message: WorkerResponse | IncrementalWorkerResponse;
  handlerMs: number;
}

interface ReceivedWorkerResult {
  response: WorkerResponse;
  handlerMs: number;
}

interface LineTokens {
  findTokenIndexAtOffset(offset: number): number;
  getCount(): number;
  getForeground(tokenIndex: number): number;
  getStartOffset(tokenIndex: number): number;
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

interface MonacoState {
  clone(): MonacoState;
  equals(other: MonacoState): boolean;
}

interface MonacoEncodedProvider {
  getInitialState(): MonacoState;
  tokenizeEncoded(
    line: string,
    state: MonacoState,
  ): {
    tokens: Uint32Array;
    endState: MonacoState;
  };
}

interface MonacoLanguagesApi {
  register(language: { id: string }): void;
  setColorMap(colorMap: string[]): void;
  setTokensProvider(
    languageId: string,
    provider: MonacoEncodedProvider,
  ): unknown;
}

interface MonacoStandaloneEditor {
  dispose(): void;
}

interface MonacoEditorApi {
  defineTheme(
    name: string,
    theme: {
      base: "vs-dark";
      inherit: boolean;
      rules: ReturnType<typeof toMonacoThemeRules>;
      encodedTokensColors: string[];
      colors: Record<string, string>;
    },
  ): void;
  setTheme(name: string): void;
  create(
    container: HTMLElement,
    options: {
      model: TokenizedModel;
      theme: string;
      automaticLayout: boolean;
      minimap: { enabled: boolean };
    },
  ): MonacoStandaloneEditor;
}

let worker: Worker | undefined;
let requestId = 0;
let contentVersion = 0;
let lastResult: SpikeResult | undefined;
let runtimePromise: ReturnType<typeof createTextMateRuntime> | undefined;
const pending = new Map<number, PendingRequest>();

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

interface HarnessWindow {
  __spikeRun: (options?: { fullDataset?: boolean }) => Promise<SpikeResult>;
  __spikeRenderSample: () => Promise<{ containerId: string }>;
  __spikeMinimapPng: () => Promise<{
    base64: string;
    width: number;
    height: number;
    fileId: string;
  }>;
  __spikeProgress?: ProgressSnapshot;
}

const runStartedAt = performance.now();

// Polled by measure.ts via a separate page.evaluate() while the main run is
// still in flight, so a timeout still leaves partial numbers on disk. Also
// logged as a `[spike-d2]` line so console-only capture still tells the
// story (spike-common-v2's diagnosability rule).
function reportProgress(
  phase: ProgressSnapshot["phase"],
  filesProcessed: number,
  totalFiles: number,
  mismatchesSoFar: number,
  comparedCharactersSoFar: number,
): void {
  const snapshot: ProgressSnapshot = {
    phase,
    filesProcessed,
    totalFiles,
    elapsedMs: performance.now() - runStartedAt,
    mismatchesSoFar,
    comparedCharactersSoFar,
  };
  (window as unknown as HarnessWindow).__spikeProgress = snapshot;
  console.log(
    `[spike-d2] progress phase=${snapshot.phase} files=${String(snapshot.filesProcessed)}/${String(snapshot.totalFiles)} elapsedMs=${snapshot.elapsedMs.toFixed(0)} mismatchesSoFar=${String(snapshot.mismatchesSoFar)}`,
  );
}

function normalizeDatasetLoaders(): Map<string, () => Promise<unknown>> {
  const entries = Object.entries(rawDatasetFiles);
  if (entries.length !== DATASET_FILE_COUNT) {
    throw new Error(
      `raw dataset glob expected ${String(DATASET_FILE_COUNT)} entries, found ${String(entries.length)}`,
    );
  }
  const loaders = new Map<string, () => Promise<unknown>>();
  for (const [key, loader] of entries) {
    const markerIndex = key.indexOf(DATASET_MARKER);
    if (markerIndex < 0) {
      throw new Error(`raw dataset key has no reference-dataset root: ${key}`);
    }
    const fileId = key.slice(markerIndex);
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

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("./tokenizer.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
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
      message,
      handlerMs: performance.now() - handlerStartedAt,
    });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "worker module evaluation failed");
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    setStatus(`Worker failed: ${error.message}`);
  };
  return worker;
}

async function requestWorker(
  file: DatasetFile,
  mode: TransferMode,
): Promise<ReceivedWorkerResult> {
  const id = requestId;
  requestId += 1;
  contentVersion += 1;
  const request: WorkerRequest = {
    type: "tokenize",
    id,
    contentVersion,
    fileId: file.fileId,
    text: file.text,
    mode,
  };
  const received = await new Promise<ReceivedMessage>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(request);
  });
  if (received.message.type !== "result") {
    throw new Error(
      `unexpected worker message type for tokenize request: ${received.message.type}`,
    );
  }
  return { response: received.message, handlerMs: received.handlerMs };
}

async function requestIncremental(
  file: DatasetFile,
): Promise<IncrementalWorkerResult> {
  const id = requestId;
  requestId += 1;
  const request: IncrementalWorkerRequest = {
    type: "incremental",
    id,
    fileId: file.fileId,
    text: file.text,
  };
  const received = await new Promise<ReceivedMessage>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage(request);
  });
  if (received.message.type !== "incremental-result") {
    throw new Error(
      `unexpected worker message type for incremental request: ${received.message.type}`,
    );
  }
  return received.message.result;
}

function datasetPath(index: number): string {
  const group = String(index % 10).padStart(2, "0");
  const kind = index % 2 === 0 ? "tsx" : "ts";
  return `${DATASET_MARKER}group-${group}/widget-${String(index).padStart(3, "0")}.${kind}`;
}

async function loadDataset(count: number): Promise<DatasetFile[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const fileId = datasetPath(index);
      const loader = datasetLoaders.get(fileId);
      if (!loader) {
        throw new Error(`raw dataset entry not found: ${fileId}`);
      }
      const text = await loader();
      if (typeof text !== "string") {
        throw new Error(`raw dataset entry was not text: ${fileId}`);
      }
      return { fileId, text };
    }),
  );
}

function summarize(values: number[]): TimingSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;
  return {
    count: values.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

function summarizeIncremental(values: number[]): IncrementalTimingSummary {
  const { count, median, p95, max } = summarize(values);
  return { count, median, p95, max };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length * 0.5)] ?? 0;
}

function workerColorAt(
  response: WorkerResponse,
  line: number,
  offset: number,
): number {
  const start = response.lineRunOffsets[line] ?? 0;
  const end = response.lineRunOffsets[line + 1] ?? start;
  let color = 0;
  for (let index = start; index < end; index += 2) {
    if ((response.runs[index] ?? 0) > offset) {
      break;
    }
    color = response.runs[index + 1] ?? color;
  }
  return color;
}

function resolveHex(colorMap: string[], colorId: number): string {
  return toHex(colorMap[colorId]);
}

async function ensureMonacoProvider(): Promise<
  Awaited<ReturnType<typeof createTextMateRuntime>>
> {
  runtimePromise ??= createTextMateRuntime();
  const runtime = await runtimePromise;
  const monacoLanguages = languages as unknown as MonacoLanguagesApi;
  const monacoEditor = editor as unknown as MonacoEditorApi;
  const colorMap = [...runtime.colorMap];
  monacoLanguages.setColorMap(colorMap);
  monacoEditor.defineTheme("spike-d2-dark-plus", {
    base: "vs-dark",
    inherit: false,
    rules: toMonacoThemeRules(),
    encodedTokensColors: colorMap,
    colors: DARK_PLUS_COLORS,
  });
  monacoEditor.setTheme("spike-d2-dark-plus");
  const createProvider = (languageId: string): MonacoEncodedProvider => ({
    getInitialState: () => createMonacoState(initialState()),
    tokenizeEncoded: (line, state) => {
      const typedState = state as ReturnType<typeof createMonacoState>;
      const grammar = grammarForScope(runtime, languageId);
      const result = grammar.tokenizeLine2(line, typedState.ruleStack);
      return {
        tokens: result.tokens,
        endState: createMonacoState(result.ruleStack),
      };
    },
  });
  monacoLanguages.register({ id: "typescript" });
  monacoLanguages.register({ id: "typescriptreact" });
  monacoLanguages.setTokensProvider("typescript", createProvider("typescript"));
  monacoLanguages.setTokensProvider(
    "typescriptreact",
    createProvider("typescriptreact"),
  );
  return runtime;
}

function compareColors(
  file: DatasetFile,
  response: WorkerResponse,
  colorMap: string[],
): {
  comparedCharacters: number;
  mismatches: number;
  defaultForegroundCharacters: number;
  nonWhitespaceCharacters: number;
  mismatchTriples: {
    tokenText: string;
    workerHex: string;
    monacoHex: string;
  }[];
  firstMismatch?: string;
} {
  const languageId = file.fileId.endsWith(".tsx")
    ? "typescriptreact"
    : "typescript";
  const model = editor.createModel(
    file.text,
    languageId,
    Uri.parse(file.fileId),
  ) as TokenizedModel;
  model.tokenization.forceTokenization(model.getLineCount());
  const defaultHex = toHex(DARK_PLUS_COLORS["editor.foreground"]);
  let comparedCharacters = 0;
  let mismatches = 0;
  let defaultForegroundCharacters = 0;
  let nonWhitespaceCharacters = 0;
  let firstMismatch: string | undefined;
  const mismatchTriples = new Map<
    string,
    { tokenText: string; workerHex: string; monacoHex: string }
  >();
  for (let lineIndex = 0; lineIndex < model.getLineCount(); lineIndex += 1) {
    const line = model.getLineContent(lineIndex + 1);
    const tokens = model.tokenization.getLineTokens(lineIndex + 1);
    for (let character = 0; character < line.length; character += 1) {
      let tokenIndex = tokens.findTokenIndexAtOffset(character);
      while (
        tokenIndex + 1 < tokens.getCount() &&
        tokens.getStartOffset(tokenIndex + 1) <= character
      ) {
        tokenIndex += 1;
      }
      const workerHex = resolveHex(
        colorMap,
        workerColorAt(response, lineIndex, character),
      );
      const monacoHex = resolveHex(colorMap, tokens.getForeground(tokenIndex));
      const characterValue = line[character] ?? "";
      if (!/\s/u.test(characterValue)) {
        nonWhitespaceCharacters += 1;
        if (monacoHex === defaultHex) {
          defaultForegroundCharacters += 1;
        }
      }
      comparedCharacters += 1;
      if (workerHex !== monacoHex) {
        mismatches += 1;
        const triple = {
          tokenText: characterValue,
          workerHex,
          monacoHex,
        };
        const key = `${triple.tokenText}\u0000${workerHex}\u0000${monacoHex}`;
        if (!mismatchTriples.has(key) && mismatchTriples.size < 20) {
          mismatchTriples.set(key, triple);
        }
        firstMismatch ??= `${file.fileId}:${String(lineIndex + 1)}:${String(character)} worker=${workerHex} monaco=${monacoHex}`;
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

interface SampleTokenSpec {
  kind: string;
  text: string;
  marker: string;
  offsetInMarker?: number;
}

const SAMPLE_TOKEN_SPECS: SampleTokenSpec[] = [
  {
    kind: "function identifier",
    text: "renderWidget",
    marker: "function renderWidget",
    offsetInMarker: "function ".length,
  },
  {
    kind: "plain identifier",
    text: "plainIdentifier",
    marker: "plainIdentifier: string",
  },
  {
    kind: "type annotation",
    text: "string",
    marker: "plainIdentifier: string",
    offsetInMarker: "plainIdentifier: ".length,
  },
  {
    kind: "method call",
    text: "trim",
    marker: "plainIdentifier.trim",
    offsetInMarker: "plainIdentifier.".length,
  },
  {
    kind: "component tag",
    text: "Widget",
    marker: "<Widget",
    offsetInMarker: 1,
  },
  {
    kind: "attribute",
    text: "className",
    marker: "className=",
  },
  {
    kind: "intrinsic tag",
    text: "div",
    marker: "<div",
    offsetInMarker: 1,
  },
  {
    kind: "function call",
    text: "renderWidget",
    marker: "\nrenderWidget(",
    offsetInMarker: 1,
  },
];

function lineAndColumnAtOffset(
  text: string,
  offset: number,
): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const line = prefix.split("\n").length - 1;
  const lastNewline = prefix.lastIndexOf("\n");
  return { line, column: offset - lastNewline - 1 };
}

function sampleOffset(spec: SampleTokenSpec): number {
  const markerOffset = SAMPLE_FILE.indexOf(spec.marker);
  if (markerOffset < 0) {
    throw new Error(`sample marker not found: ${spec.marker}`);
  }
  return markerOffset + (spec.offsetInMarker ?? 0);
}

function monacoColorAtOffset(
  model: TokenizedModel,
  text: string,
  offset: number,
  colorMap: string[],
): string {
  const { line, column } = lineAndColumnAtOffset(text, offset);
  const lineTokens = model.tokenization.getLineTokens(line + 1);
  let tokenIndex = lineTokens.findTokenIndexAtOffset(column);
  while (
    tokenIndex + 1 < lineTokens.getCount() &&
    lineTokens.getStartOffset(tokenIndex + 1) <= column
  ) {
    tokenIndex += 1;
  }
  return resolveHex(colorMap, lineTokens.getForeground(tokenIndex));
}

function sampleParity(
  response: WorkerResponse,
  colorMap: string[],
): SampleTokenParity[] {
  const model = editor.createModel(
    SAMPLE_FILE,
    "typescriptreact",
    Uri.parse("/samples/d2-parity.tsx"),
  ) as TokenizedModel;
  model.tokenization.forceTokenization(model.getLineCount());
  const parity = SAMPLE_TOKEN_SPECS.map((spec) => {
    const offset = sampleOffset(spec);
    const { line, column } = lineAndColumnAtOffset(SAMPLE_FILE, offset);
    return {
      kind: spec.kind,
      text: spec.text,
      workerHex: resolveHex(
        response.colorMap,
        workerColorAt(response, line, column),
      ),
      monacoHex: monacoColorAtOffset(model, SAMPLE_FILE, offset, colorMap),
      match: false,
    };
  });
  model.dispose();
  return parity.map((token) => ({
    ...token,
    match: token.workerHex === token.monacoHex,
  }));
}

function syntaxSamples(
  response: WorkerResponse,
  colorMap: string[],
): SpikeResult["syntaxSamples"] {
  const parity = sampleParity(response, colorMap);
  const sample = (kind: string): SyntaxSample => {
    const token = parity.find((entry) => entry.kind === kind);
    if (!token) {
      throw new Error(`sample parity token missing: ${kind}`);
    }
    return { text: token.text, color: token.workerHex };
  };
  const jsxTag = sample("component tag");
  const functionIdentifier = sample("function identifier");
  const plainIdentifier = sample("plain identifier");
  return {
    jsxTag,
    functionIdentifier,
    plainIdentifier,
    jsxTagDistinctFromPlain: jsxTag.color !== plainIdentifier.color,
    functionDistinctFromPlain:
      functionIdentifier.color !== plainIdentifier.color,
    sampleParity: parity,
    sampleParityMismatches: parity.filter((token) => !token.match).length,
  };
}

async function runMeasurement(files: DatasetFile[]): Promise<SpikeResult> {
  await ensureMonacoProvider();
  setStatus(`Running cold worker pass for ${String(files.length)} file(s)...`);
  console.log(`[spike-d2] worker cold pass: ${String(files.length)} file(s)`);
  const coldTimes: number[] = [];
  const warmTimes: number[] = [];
  const transferReceives: number[] = [];
  const cloneReceives: number[] = [];
  const coldResponses: WorkerResponse[] = [];
  let coldTotalMs = 0;
  let warmTotalMs = 0;
  let totalLineCount = 0;
  let totalCharacterCount = 0;
  let packedRunBytesTotal = 0;
  let minimapBytesTotal = 0;
  let comparedCharacters = 0;
  let mismatches = 0;
  let defaultForegroundCharacters = 0;
  let nonWhitespaceCharacters = 0;
  let rawMismatch: string | undefined;
  const mismatchTriples = new Map<
    string,
    { tokenText: string; workerHex: string; monacoHex: string }
  >();
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) {
      continue;
    }
    const received = await requestWorker(file, "transfer");
    const response = received.response;
    coldResponses.push(response);
    coldTimes.push(response.timing.totalMs);
    transferReceives.push(received.handlerMs);
    coldTotalMs += response.timing.totalMs;
    totalLineCount += response.timing.lineCount;
    totalCharacterCount += response.timing.characterCount;
    packedRunBytesTotal += response.runs.byteLength;
    minimapBytesTotal += response.minimap.byteLength;
    const comparison = compareColors(file, response, response.colorMap);
    comparedCharacters += comparison.comparedCharacters;
    mismatches += comparison.mismatches;
    defaultForegroundCharacters += comparison.defaultForegroundCharacters;
    nonWhitespaceCharacters += comparison.nonWhitespaceCharacters;
    rawMismatch ??= comparison.firstMismatch;
    for (const triple of comparison.mismatchTriples) {
      const key = `${triple.tokenText}\u0000${triple.workerHex}\u0000${triple.monacoHex}`;
      if (!mismatchTriples.has(key) && mismatchTriples.size < 20) {
        mismatchTriples.set(key, triple);
      }
    }
    if (
      (index + 1) % PROGRESS_LOG_INTERVAL === 0 ||
      index === files.length - 1
    ) {
      reportProgress(
        "cold",
        index + 1,
        files.length,
        mismatches,
        comparedCharacters,
      );
    }
  }
  console.log("[spike-d2] worker cold pass complete; warm pass starting");

  // Warm/clone/incremental passes run on a fixed subset (not the full
  // dataset): the hex-parity/packed-size/minimap requirements only need the
  // cold pass over all 200 files; repeating on a 20-file subset is enough
  // to compare warm-vs-cold and clone-vs-transfer timing while keeping the
  // whole run inside the harness's time budget.
  const subset = files.slice(0, Math.min(SUBSET_FILE_COUNT, files.length));

  let subsetLineCount = 0;
  for (let index = 0; index < subset.length; index += 1) {
    const file = subset[index];
    if (!file) {
      continue;
    }
    const received = await requestWorker(file, "transfer");
    warmTimes.push(received.response.timing.totalMs);
    warmTotalMs += received.response.timing.totalMs;
    subsetLineCount += received.response.timing.lineCount;
    reportProgress(
      "warm",
      index + 1,
      subset.length,
      mismatches,
      comparedCharacters,
    );
  }
  console.log("[spike-d2] warm pass complete; structured-clone pass starting");
  for (let index = 0; index < subset.length; index += 1) {
    const file = subset[index];
    if (!file) {
      continue;
    }
    const received = await requestWorker(file, "clone");
    cloneReceives.push(received.handlerMs);
    reportProgress(
      "clone",
      index + 1,
      subset.length,
      mismatches,
      comparedCharacters,
    );
  }
  console.log(
    "[spike-d2] structured-clone pass complete; incremental pass starting",
  );
  const incrementalResults: IncrementalWorkerResult[] = [];
  for (let index = 0; index < subset.length; index += 1) {
    const file = subset[index];
    if (!file) {
      continue;
    }
    incrementalResults.push(await requestIncremental(file));
    reportProgress(
      "incremental",
      index + 1,
      subset.length,
      mismatches,
      comparedCharacters,
    );
  }
  console.log("[spike-d2] incremental pass complete");
  const sample = await requestWorker(
    { fileId: "/samples/d2-syntax.tsx", text: SAMPLE_FILE },
    "transfer",
  );
  const guardPassed =
    nonWhitespaceCharacters > 0 &&
    defaultForegroundCharacters / nonWhitespaceCharacters <= 0.5;
  const firstResponse = coldResponses[0];
  if (!firstResponse) {
    throw new Error("worker returned no dataset response");
  }
  const incrementalSummary: SpikeResult["incremental"] = {
    fileCount: incrementalResults.length,
    coldFirstWindowMs: summarizeIncremental(
      incrementalResults.map((result) => result.coldFirstWindowMs),
    ),
    editAt10: {
      incrementalMs: summarizeIncremental(
        incrementalResults.map((result) => result.editAt10.incrementalMs),
      ),
      fullRescanMs: summarizeIncremental(
        incrementalResults.map((result) => result.editAt10.fullRescanMs),
      ),
      convergedCount: incrementalResults.filter(
        (result) => result.editAt10.converged,
      ).length,
      linesRetokenizedMedian: median(
        incrementalResults.map((result) => result.editAt10.linesRetokenized),
      ),
    },
    editAt1000: {
      incrementalMs: summarizeIncremental(
        incrementalResults.map((result) => result.editAt1000.incrementalMs),
      ),
      fullRescanMs: summarizeIncremental(
        incrementalResults.map((result) => result.editAt1000.fullRescanMs),
      ),
      convergedCount: incrementalResults.filter(
        (result) => result.editAt1000.converged,
      ).length,
      linesRetokenizedMedian: median(
        incrementalResults.map((result) => result.editAt1000.linesRetokenized),
      ),
    },
    chunkMs: summarizeIncremental(
      incrementalResults.flatMap((result) => result.chunkTimingsMs),
    ),
  };
  const result: SpikeResult = {
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: window.crossOriginIsolated,
    },
    dataset: {
      fileCount: files.length,
      lineCount: totalLineCount,
      characterCount: totalCharacterCount,
      rawSourceVerified: false,
      firstFile: files[0]?.fileId ?? "",
      firstFileCharacterCount: files[0]?.text.length ?? 0,
      firstFilePrefix: files[0]?.text.slice(0, 80) ?? "",
    },
    worker: {
      grammar: "tm-grammars TypeScript source.ts and TSX source.tsx",
      wasm: "vscode-oniguruma/release/onig.wasm loaded with Vite ?url and fetch",
      output:
        "Uint32Array packed [line-relative startOffset, foregroundColorId] runs per line; R8 minimap Uint8Array",
      packedRunBytesPerFile:
        files.length === 0 ? 0 : packedRunBytesTotal / files.length,
      packedRunBytesTotal,
      minimap: {
        width: MINIMAP_WIDTH,
        maxHeight: MINIMAP_MAX_HEIGHT,
        bytesPerFile: files.length === 0 ? 0 : minimapBytesTotal / files.length,
        bytesTotal: minimapBytesTotal,
        decimation:
          "height=min(lines,512); proportional source line; first non-whitespace color per column",
      },
      cold2000LineFile: summarize(coldTimes),
      warm2000LineFile: summarize(warmTimes),
      coldDataset: {
        fileCount: files.length,
        lineCount: totalLineCount,
        totalMs: coldTotalMs,
      },
      warmDataset: {
        fileCount: subset.length,
        lineCount: subsetLineCount,
        totalMs: warmTotalMs,
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
      defaultForegroundCharacters,
      nonWhitespaceCharacters,
      tokenizedReferenceGuardPassed: guardPassed,
      mismatchTriples: [...mismatchTriples.values()],
      ...(rawMismatch ? { firstMismatch: rawMismatch } : {}),
    },
    syntaxSamples: syntaxSamples(sample.response, sample.response.colorMap),
    incremental: incrementalSummary,
  };
  reportProgress(
    "done",
    files.length,
    files.length,
    mismatches,
    comparedCharacters,
  );
  setResults(result);
  setStatus(
    guardPassed
      ? `Complete: ${String(files.length)} file(s), ${String(mismatches)} color mismatches.`
      : `Guard failed: ${String(defaultForegroundCharacters)} of ${String(nonWhitespaceCharacters)} non-whitespace characters use the default foreground.`,
  );
  return result;
}

async function run(count: number): Promise<void> {
  const files = await loadDataset(count);
  console.log(`[spike-d2] raw dataset loaded: ${String(files.length)} file(s)`);
  await runMeasurement(files);
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

bindButton("run-sample", () => run(1));
bindButton("run-dataset", () => run(DATASET_FILE_COUNT));
async function copyResults(): Promise<void> {
  if (!lastResult) {
    setStatus("No results to copy yet.");
    return;
  }
  await navigator.clipboard.writeText(JSON.stringify(lastResult));
  setStatus("Results copied as JSON.");
}

document
  .querySelector<HTMLButtonElement>("#copy-results")
  ?.addEventListener("click", () => {
    void copyResults();
  });

let sampleEditor: MonacoStandaloneEditor | undefined;

// Mounts a real Monaco editor on the sample TSX snippet so the lead's
// browser run can screenshot it and confirm JSX tag / function-identifier /
// plain-identifier colors are visibly distinct (spec code-widget-rendering).
// Not called inside any timed measurement loop.
async function renderMonacoSample(): Promise<{ containerId: string }> {
  await ensureMonacoProvider();
  const container = document.querySelector<HTMLDivElement>(
    "#monaco-sample-container",
  );
  if (!container) {
    throw new Error("monaco-sample-container element not found");
  }
  sampleEditor?.dispose();
  const model = editor.createModel(
    SCREENSHOT_SAMPLE,
    "typescriptreact",
    Uri.parse("/samples/d2-screenshot.tsx"),
  ) as TokenizedModel;
  model.tokenization.forceTokenization(model.getLineCount());
  const monacoEditor = editor as unknown as MonacoEditorApi;
  sampleEditor = monacoEditor.create(container, {
    model,
    theme: "spike-d2-dark-plus",
    automaticLayout: false,
    minimap: { enabled: false },
  });
  return { containerId: "monaco-sample-container" };
}

// Encodes an R8 palette-indexed minimap as a PNG using the browser's own
// canvas encoder (no hand-rolled encoder in page code). Called once after
// the timed measurement passes complete, per spike-common-v2's "no
// toDataURL/screenshots inside a timed loop" rule.
async function minimapPngBase64(response: WorkerResponse): Promise<{
  base64: string;
  width: number;
  height: number;
  fileId: string;
}> {
  const width = MINIMAP_WIDTH;
  const height = response.minimapHeight;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2d context unavailable for minimap PNG encode");
  }
  const imageData = context.createImageData(width, height);
  for (let index = 0; index < response.minimap.length; index += 1) {
    const hex =
      response.minimapPalette[response.minimap[index] ?? 0] ?? "#000000";
    const pixel = index * 4;
    imageData.data[pixel] = parseInt(hex.slice(1, 3), 16);
    imageData.data[pixel + 1] = parseInt(hex.slice(3, 5), 16);
    imageData.data[pixel + 2] = parseInt(hex.slice(5, 7), 16);
    imageData.data[pixel + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return { base64: btoa(binary), width, height, fileId: response.fileId };
}

(window as unknown as HarnessWindow).__spikeRun = async (options) => {
  const files = await loadDataset(
    options?.fullDataset ? DATASET_FILE_COUNT : 1,
  );
  console.log(
    `[spike-d2] harness run started: ${String(files.length)} file(s)`,
  );
  return runMeasurement(files);
};

(window as unknown as HarnessWindow).__spikeRenderSample = renderMonacoSample;

(window as unknown as HarnessWindow).__spikeMinimapPng = async () => {
  const [file] = await loadDataset(1);
  if (!file) {
    throw new Error("no dataset file available for minimap PNG");
  }
  const received = await requestWorker(file, "transfer");
  return minimapPngBase64(received.response);
};
