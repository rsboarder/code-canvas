export type TransferMode = "clone" | "transfer";

export interface WorkerRequest {
  type: "tokenize";
  id: number;
  contentVersion: number;
  fileId: string;
  text: string;
  mode: TransferMode;
  scopeColors: Record<string, number>;
  scopePalette: Record<string, number>;
  minimapWidth: number;
  minimapMaxHeight: number;
}

export interface WorkerResponse {
  type: "result";
  id: number;
  contentVersion: number;
  fileId: string;
  sentAt: number;
  timing: {
    tokenizeMs: number;
    minimapMs: number;
    totalMs: number;
    lineCount: number;
    characterCount: number;
  };
  colors: Uint32Array;
  lineOffsets: Uint32Array;
  minimap: Uint8Array;
  minimapHeight: number;
}

export interface WorkerFailure {
  type: "error";
  id: number;
  contentVersion: number;
  fileId: string;
  message: string;
  stack?: string;
}

export type WorkerMessage = WorkerResponse | WorkerFailure;

export interface TimingSummary {
  count: number;
  median: number;
  p95: number;
  max: number;
  total: number;
}

export interface SpikeResult {
  environment: Record<string, string | number | boolean>;
  workerModules: string[];
  minimap: {
    width: number;
    maxHeight: number;
    decimation: string;
    bytesPerFile: number;
    totalBytes: number;
  };
  workerTiming: {
    per2000LineFile: TimingSummary;
    wholeDataset: { fileCount: number; lineCount: number; totalMs: number };
  };
  mainThreadReceive: {
    structuredClone: TimingSummary;
    transferable: TimingSummary;
  };
  colorComparison: {
    fileCount: number;
    comparedCharacters: number;
    mismatches: number;
    mismatchTriples: {
      tokenText: string;
      workerHex: string;
      monacoHex: string;
    }[];
    firstMismatch?: string;
  };
}
