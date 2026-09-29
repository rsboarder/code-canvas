export type TransferMode = "clone" | "transfer";

export interface WorkerRequest {
  type: "tokenize";
  id: number;
  contentVersion: number;
  fileId: string;
  text: string;
  mode: TransferMode;
}

export interface WorkerResponse {
  type: "result";
  id: number;
  contentVersion: number;
  fileId: string;
  timing: {
    initMs: number;
    tokenizeMs: number;
    minimapMs: number;
    totalMs: number;
    lineCount: number;
    characterCount: number;
  };
  runs: Uint32Array;
  lineRunOffsets: Uint32Array;
  minimap: Uint8Array;
  minimapHeight: number;
  colorMap: string[];
  minimapPalette: string[];
}

export interface WorkerFailure {
  type: "error";
  id: number;
  contentVersion: number;
  fileId: string;
  message: string;
  stack?: string;
}

export interface IncrementalWorkerRequest {
  type: "incremental";
  id: number;
  fileId: string;
  text: string;
}

export type AnyWorkerRequest = WorkerRequest | IncrementalWorkerRequest;

export interface IncrementalEditSummary {
  editLine: number;
  linesRetokenized: number;
  converged: boolean;
  reachedWindowBound: boolean;
  incrementalMs: number;
  fullRescanMs: number;
}

export interface IncrementalWorkerResult {
  fileId: string;
  lineCount: number;
  coldFirstWindowMs: number;
  coldFirstWindowLines: number;
  editAt10: IncrementalEditSummary;
  editAt1000: IncrementalEditSummary;
  chunkTimingsMs: number[];
}

export interface IncrementalWorkerResponse {
  type: "incremental-result";
  id: number;
  fileId: string;
  result: IncrementalWorkerResult;
}

export type WorkerMessage =
  WorkerResponse | WorkerFailure | IncrementalWorkerResponse;

export interface TimingSummary {
  count: number;
  median: number;
  p95: number;
  max: number;
  total: number;
}

export interface IncrementalTimingSummary {
  count: number;
  median: number;
  p95: number;
  max: number;
}

export interface SyntaxSample {
  text: string;
  color: string;
}

export interface SampleTokenParity {
  kind: string;
  text: string;
  workerHex: string;
  monacoHex: string;
  match: boolean;
}

export interface SpikeResult {
  environment: Record<string, string | number | boolean>;
  dataset: {
    fileCount: number;
    lineCount: number;
    characterCount: number;
    rawSourceVerified: boolean;
    firstFile: string;
    firstFileCharacterCount: number;
    firstFilePrefix: string;
  };
  worker: {
    grammar: string;
    wasm: string;
    output: string;
    packedRunBytesPerFile: number;
    packedRunBytesTotal: number;
    minimap: {
      width: number;
      maxHeight: number;
      bytesPerFile: number;
      bytesTotal: number;
      decimation: string;
    };
    cold2000LineFile: TimingSummary;
    warm2000LineFile: TimingSummary;
    coldDataset: { fileCount: number; lineCount: number; totalMs: number };
    warmDataset: { fileCount: number; lineCount: number; totalMs: number };
  };
  mainThreadReceive: {
    structuredClone: TimingSummary;
    transferable: TimingSummary;
  };
  colorComparison: {
    fileCount: number;
    comparedCharacters: number;
    mismatches: number;
    defaultForegroundCharacters: number;
    nonWhitespaceCharacters: number;
    tokenizedReferenceGuardPassed: boolean;
    mismatchTriples: {
      tokenText: string;
      workerHex: string;
      monacoHex: string;
    }[];
    firstMismatch?: string;
  };
  syntaxSamples: {
    jsxTag: SyntaxSample;
    functionIdentifier: SyntaxSample;
    plainIdentifier: SyntaxSample;
    jsxTagDistinctFromPlain: boolean;
    functionDistinctFromPlain: boolean;
    sampleParity: SampleTokenParity[];
    sampleParityMismatches: number;
  };
  incremental: {
    fileCount: number;
    coldFirstWindowMs: IncrementalTimingSummary;
    editAt10: {
      incrementalMs: IncrementalTimingSummary;
      fullRescanMs: IncrementalTimingSummary;
      convergedCount: number;
      linesRetokenizedMedian: number;
    };
    editAt1000: {
      incrementalMs: IncrementalTimingSummary;
      fullRescanMs: IncrementalTimingSummary;
      convergedCount: number;
      linesRetokenizedMedian: number;
    };
    chunkMs: IncrementalTimingSummary;
  };
}

// Polled from `window.__spikeProgress` by measure.ts while a run is in
// flight, so a timeout still leaves partial data on disk.
export interface ProgressSnapshot {
  phase: "cold" | "warm" | "clone" | "incremental" | "done";
  filesProcessed: number;
  totalFiles: number;
  elapsedMs: number;
  mismatchesSoFar: number;
  comparedCharactersSoFar: number;
}
