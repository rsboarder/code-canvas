import type { LineMetrics } from "../../domain/line-layout";
import type { PackedTokenRuns } from "../../domain/tokenized-document";

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface TokenizedLines extends PackedTokenRuns {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly lineRange: LineRange;
  readonly minimap?: Uint8Array;
  readonly minimapHeight?: number;
}

export interface Tokenizer {
  contentChanged(fileId: string, contentVersion: number, text: string): void;
  wanted(fileId: string, lineRanges: readonly LineRange[]): void;
  subscribe(listener: (result: TokenizedLines) => void): () => void;
}

export interface LineWindow {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly lineCount: number;
  readonly firstLine: number;
  readonly highlighted: boolean;
  readonly lines: readonly string[];
  readonly lineCellOffsets: Uint32Array;
  readonly cellStarts: Uint32Array;
  readonly cellEnds: Uint32Array;
  readonly cellXs: Float32Array;
  readonly cellColors: Uint8Array;
}

export interface MinimapUpload {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly bytes: Uint8Array;
  readonly height: number;
}

export interface GpuUploader {
  uploadLineWindow(window: LineWindow): void;
  uploadMinimap(minimap: MinimapUpload): void;
}

export interface DocumentResidencyOptions {
  readonly tokenizer: Tokenizer;
  readonly lineMetrics: LineMetrics;
  readonly now?: () => number;
}
