import type { SourceFileId } from "../../shared/domain";

export interface PackedTokenRuns {
  readonly firstLine: number;
  readonly runs: Uint32Array;
  readonly lineRunOffsets: Uint32Array;
}

export class TokenizedDocument {
  private readonly runs: Uint32Array;
  private readonly lineRunOffsets: Uint32Array;
  readonly fileId: SourceFileId;
  readonly contentVersion: number;
  readonly firstLine: number;

  constructor(
    fileId: SourceFileId,
    contentVersion: number,
    packed: PackedTokenRuns,
  ) {
    const { firstLine, runs, lineRunOffsets } = packed;
    validatePackedDocument(firstLine, runs, lineRunOffsets);
    this.fileId = fileId;
    this.contentVersion = contentVersion;
    this.firstLine = firstLine;
    this.runs = runs;
    this.lineRunOffsets = lineRunOffsets;
  }

  get lineCount(): number {
    return this.lineRunOffsets.length - 1;
  }

  get endLine(): number {
    return this.firstLine + this.lineCount;
  }

  runCount(line: number): number {
    const lineIndex = this.lineIndex(line);
    const start = this.lineRunOffsets[lineIndex] ?? 0;
    const end = this.lineRunOffsets[lineIndex + 1] ?? start;
    return (end - start) / 2;
  }

  colorAt(line: number, utf16Offset: number): number {
    const lineIndex = this.lineIndex(line);
    const start = this.lineRunOffsets[lineIndex] ?? 0;
    const end = this.lineRunOffsets[lineIndex + 1] ?? start;
    let low = 0;
    let high = (end - start) / 2 - 1;
    let color = this.runs[start + 1] ?? 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const runIndex = start + middle * 2;
      const runOffset = this.runs[runIndex] ?? 0;
      if (runOffset <= utf16Offset) {
        color = this.runs[runIndex + 1] ?? color;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return color;
  }

  private lineIndex(line: number): number {
    const lineIndex = line - this.firstLine;
    if (lineIndex < 0 || lineIndex >= this.lineCount) {
      throw new RangeError("TokenizedDocument line is outside its range.");
    }
    return lineIndex;
  }
}

function validatePackedDocument(
  firstLine: number,
  runs: Uint32Array,
  lineRunOffsets: Uint32Array,
): void {
  if (firstLine < 0) {
    throw new RangeError("TokenizedDocument first line cannot be negative.");
  }
  if (runs.length % 2 !== 0) {
    throw new RangeError("TokenizedDocument runs must contain pairs.");
  }
  if (lineRunOffsets.length === 0 || lineRunOffsets[0] !== 0) {
    throw new RangeError("TokenizedDocument line offsets must start at zero.");
  }
  validateLineRunOffsets(runs, lineRunOffsets);
  validateLines(runs, lineRunOffsets);
}

function validateLineRunOffsets(
  runs: Uint32Array,
  lineRunOffsets: Uint32Array,
): void {
  let previous = 0;
  for (let index = 1; index < lineRunOffsets.length; index += 1) {
    const current = lineRunOffsets[index] ?? 0;
    if (current % 2 !== 0) {
      throw new RangeError("TokenizedDocument line offsets must be even.");
    }
    if (current < previous) {
      throw new RangeError("TokenizedDocument line offsets cannot decrease.");
    }
    previous = current;
  }
  if (previous !== runs.length) {
    throw new RangeError(
      "TokenizedDocument line offsets must end at runs length.",
    );
  }
}

function validateLines(runs: Uint32Array, lineRunOffsets: Uint32Array): void {
  for (
    let lineIndex = 0;
    lineIndex < lineRunOffsets.length - 1;
    lineIndex += 1
  ) {
    const start = lineRunOffsets[lineIndex] ?? 0;
    const end = lineRunOffsets[lineIndex + 1] ?? start;
    if (start === end) {
      throw new RangeError("TokenizedDocument lines must contain a run.");
    }
    if (runs[start] !== 0) {
      throw new RangeError(
        "TokenizedDocument lines must start at offset zero.",
      );
    }
    let previousOffset = -1;
    for (let runIndex = start; runIndex < end; runIndex += 2) {
      const offset = runs[runIndex] ?? 0;
      if (offset <= previousOffset) {
        throw new RangeError("TokenizedDocument run offsets must increase.");
      }
      previousOffset = offset;
    }
  }
}
