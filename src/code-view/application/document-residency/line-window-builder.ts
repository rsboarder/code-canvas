import {
  createLineGeometry,
  isWhitespaceCluster,
  LineLayout,
  type LineGeometry,
  type LineMetrics,
} from "../../domain/line-layout";
import type { LineRange, LineWindow } from "./ports";

export type CellColorAt = (line: number, utf16Offset: number) => number;

interface LineWindowBuilderOptions {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly layout: LineLayout;
  readonly range: LineRange;
  readonly lineMetrics: LineMetrics;
}

export class LineWindowBuilder {
  private readonly geometry: LineGeometry;
  private readonly lineCellOffsets: Uint32Array;
  private readonly lineFrontiers: Uint32Array;
  private cellStarts = new Uint32Array(16);
  private cellEnds = new Uint32Array(16);
  private cellXs = new Float32Array(16);
  private cellColors = new Uint8Array(16);
  private nextLine: number;
  private nextRecolorIndex = 0;
  private cellCount = 0;

  readonly firstLine: number;
  readonly endLine: number;
  readonly lineCount: number;

  constructor(private readonly options: LineWindowBuilderOptions) {
    this.firstLine = options.range.start;
    this.endLine = options.range.end;
    this.lineCount = options.layout.lineCount;
    this.nextLine = this.firstLine;
    const lineCount = this.endLine - this.firstLine;
    this.geometry = createLineGeometry();
    this.lineCellOffsets = new Uint32Array(lineCount + 1);
    this.lineFrontiers = new Uint32Array(lineCount);
  }

  get complete(): boolean {
    return this.nextLine >= this.endLine;
  }

  buildUnit(tokenFrontier: number, colorAt: CellColorAt): void {
    if (this.complete) return;
    const line = this.nextLine;
    this.options.layout.layoutLine(line, this.geometry);
    const lineIndex = line - this.firstLine;
    this.appendCells(line, lineIndex, tokenFrontier, colorAt);
    this.lineFrontiers[lineIndex] = line < tokenFrontier ? tokenFrontier : 0;
    this.nextLine += 1;
  }

  recolorBuiltUnit(tokenFrontier: number, colorAt: CellColorAt): boolean {
    const lineIndex = this.nextRecolorLine(tokenFrontier);
    if (lineIndex < 0) return false;
    this.recolorLine(lineIndex, tokenFrontier, colorAt);
    return true;
  }

  needsRecolor(tokenFrontier: number): boolean {
    return this.nextRecolorLine(tokenFrontier) >= 0;
  }

  toWindow(tokenFrontier: number): LineWindow {
    return {
      fileId: this.options.fileId,
      contentVersion: this.options.contentVersion,
      lineCount: this.lineCount,
      firstLine: this.firstLine,
      highlighted: this.endLine <= tokenFrontier,
      lines: this.options.layout.lines.slice(this.firstLine, this.endLine),
      lineCellOffsets: this.lineCellOffsets,
      cellStarts: this.cellStarts.slice(0, this.cellCount),
      cellEnds: this.cellEnds.slice(0, this.cellCount),
      cellXs: this.cellXs.slice(0, this.cellCount),
      cellColors: this.cellColors.slice(0, this.cellCount),
    };
  }

  private appendCells(
    line: number,
    lineIndex: number,
    tokenFrontier: number,
    colorAt: CellColorAt,
  ): void {
    const lineText = this.options.layout.lines[line] ?? "";
    for (let index = 0; index < this.geometry.clusterCount; index += 1) {
      const start = this.geometry.utf16Starts[index] ?? 0;
      const end = this.geometry.utf16Starts[index + 1] ?? start;
      if (isWhitespaceCluster(lineText, start, end)) continue;
      this.ensureCellCapacity(this.cellCount + 1);
      this.cellStarts[this.cellCount] = start;
      this.cellEnds[this.cellCount] = end;
      this.cellXs[this.cellCount] = this.geometry.xs[index] ?? 0;
      this.cellColors[this.cellCount] =
        line < tokenFrontier ? colorIndex(colorAt(line, start)) : 0;
      this.cellCount += 1;
    }
    this.lineCellOffsets[lineIndex + 1] = this.cellCount;
  }

  private nextRecolorLine(tokenFrontier: number): number {
    const builtEnd = Math.min(this.nextLine, this.endLine);
    const builtEndIndex = builtEnd - this.firstLine;
    while (this.nextRecolorIndex < builtEndIndex) {
      const line = this.firstLine + this.nextRecolorIndex;
      if ((this.lineFrontiers[this.nextRecolorIndex] ?? 0) > 0) {
        this.nextRecolorIndex += 1;
        continue;
      }
      if (line >= tokenFrontier) return -1;
      return this.nextRecolorIndex;
    }
    return -1;
  }

  private recolorLine(
    lineIndex: number,
    tokenFrontier: number,
    colorAt: CellColorAt,
  ): void {
    const line = this.firstLine + lineIndex;
    const start = this.lineCellOffsets[lineIndex] ?? 0;
    const end = this.lineCellOffsets[lineIndex + 1] ?? start;
    for (let cell = start; cell < end; cell += 1) {
      this.cellColors[cell] = colorIndex(
        colorAt(line, this.cellStarts[cell] ?? 0),
      );
    }
    this.lineFrontiers[lineIndex] = tokenFrontier;
    this.nextRecolorIndex = lineIndex + 1;
  }

  private ensureCellCapacity(required: number): void {
    if (required <= this.cellStarts.length) return;
    const capacity = Math.max(required, this.cellStarts.length * 2);
    this.cellStarts = grow(this.cellStarts, capacity);
    this.cellEnds = grow(this.cellEnds, capacity);
    this.cellXs = grow(this.cellXs, capacity);
    this.cellColors = grow(this.cellColors, capacity);
  }
}

interface RecolorWorkOptions {
  readonly window: LineWindow;
  readonly firstLine: number;
  readonly endLine: number;
  readonly colorAt: CellColorAt;
}

export class RecolorWork {
  private readonly colors: Uint8Array;
  private nextLine: number;

  constructor(private readonly options: RecolorWorkOptions) {
    this.colors = new Uint8Array(options.window.cellColors);
    this.nextLine = options.firstLine;
  }

  get complete(): boolean {
    return this.nextLine >= this.options.endLine;
  }

  recolorUnit(): void {
    if (this.complete) return;
    const lineIndex = this.nextLine - this.options.window.firstLine;
    const start = this.options.window.lineCellOffsets[lineIndex] ?? 0;
    const end = this.options.window.lineCellOffsets[lineIndex + 1] ?? start;
    for (let cell = start; cell < end; cell += 1) {
      const utf16Offset = this.options.window.cellStarts[cell] ?? 0;
      this.colors[cell] = colorIndex(
        this.options.colorAt(this.nextLine, utf16Offset),
      );
    }
    this.nextLine += 1;
  }

  toWindow(tokenFrontier: number): LineWindow {
    return {
      ...this.options.window,
      highlighted:
        this.options.window.firstLine + this.options.window.lines.length <=
        tokenFrontier,
      cellColors: this.colors,
    };
  }
}

function colorIndex(color: number): number {
  return Math.min(255, color + 1);
}

function grow<T extends Uint32Array | Float32Array | Uint8Array>(
  source: T,
  capacity: number,
): T {
  let result: Uint32Array | Float32Array | Uint8Array;
  if (source instanceof Uint32Array) result = new Uint32Array(capacity);
  else if (source instanceof Float32Array) result = new Float32Array(capacity);
  else result = new Uint8Array(capacity);
  result.set(source);
  return result as T;
}
