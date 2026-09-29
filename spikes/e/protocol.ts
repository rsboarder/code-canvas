export type TransferMode = "transfer";

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
