import { TokenizedDocument } from "../../domain/tokenized-document";
import { sourceFileId } from "../../../shared/domain/ids";
import type { TokenizedLines } from "./ports";

export interface VersionRecord {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly text: string;
  readonly chunks: TokenChunk[];
  minimap?: Uint8Array;
  minimapHeight?: number;
}

export interface TokenChunk {
  readonly result: TokenizedLines;
  document?: TokenizedDocument;
}

export class VersionLedger {
  private readonly records = new Map<string, VersionRecord>();

  get(fileId: string): VersionRecord | undefined {
    return this.records.get(fileId);
  }

  values(): IterableIterator<VersionRecord> {
    return this.records.values();
  }

  replace(
    fileId: string,
    contentVersion: number,
    text: string,
  ): VersionRecord | undefined {
    const previous = this.records.get(fileId);
    if (previous && contentVersion <= previous.contentVersion) return undefined;
    const record: VersionRecord = {
      fileId,
      contentVersion,
      text,
      chunks: [],
    };
    this.records.set(fileId, record);
    return record;
  }

  append(result: TokenizedLines): VersionRecord | undefined {
    const record = this.records.get(result.fileId);
    if (record?.contentVersion !== result.contentVersion) return undefined;
    const last = record.chunks[record.chunks.length - 1]?.result;
    const expectedStart = last?.lineRange.end ?? 0;
    if (!isContiguous(result, expectedStart)) return undefined;
    record.chunks.push({ result });
    if (result.minimap && result.minimapHeight !== undefined) {
      record.minimap = result.minimap;
      record.minimapHeight = result.minimapHeight;
    }
    return record;
  }

  frontier(record: VersionRecord): number {
    return record.chunks[record.chunks.length - 1]?.result.lineRange.end ?? 0;
  }

  chunkAt(record: VersionRecord, line: number): TokenizedDocument | undefined {
    let low = 0;
    let high = record.chunks.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const chunk = record.chunks[middle];
      if (!chunk) return undefined;
      const range = chunk.result.lineRange;
      if (line < range.start) high = middle - 1;
      else if (line >= range.end) low = middle + 1;
      else {
        chunk.document ??= new TokenizedDocument(
          sourceFileId(chunk.result.fileId),
          chunk.result.contentVersion,
          chunk.result,
        );
        return chunk.document;
      }
    }
    return undefined;
  }
}

function isContiguous(result: TokenizedLines, expectedStart: number): boolean {
  return (
    result.firstLine === result.lineRange.start &&
    result.lineRange.start === expectedStart &&
    result.lineRange.end > result.lineRange.start &&
    result.lineRunOffsets.length ===
      result.lineRange.end - result.lineRange.start + 1
  );
}
