import { splitSourceLines } from "../../shared/domain/line-splitting";

export interface LineMetrics {
  readonly narrowAdvance: number;
  readonly tabSize: number;
  readonly baseline: number;
  readonly lineHeight: number;
  readonly advanceFor: (cluster: string) => number;
}

export interface LineGeometry {
  clusterCount: number;
  utf16Starts: Uint32Array;
  xs: Float64Array;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function createLineGeometry(initialCapacity = 16): LineGeometry {
  const capacity = Math.max(1, Math.floor(initialCapacity));
  return {
    clusterCount: 0,
    utf16Starts: new Uint32Array(capacity + 1),
    xs: new Float64Array(capacity + 1),
  };
}

export const MINIMAP_LINE_METRICS: LineMetrics = {
  narrowAdvance: 1,
  tabSize: 4,
  baseline: 1,
  lineHeight: 1,
  advanceFor: () => 1,
};

export interface LayoutCell {
  readonly text: string;
  readonly utf16Offset: number;
  readonly utf16Length: number;
  readonly x: number;
  readonly advance: number;
}

export class LineLayout {
  readonly lines: readonly string[];
  private readonly geometry = createLineGeometry();

  constructor(
    text: string,
    private readonly metrics: LineMetrics = {
      narrowAdvance: 8.4,
      tabSize: 4,
      baseline: 16,
      lineHeight: 20,
      advanceFor: () => 8.4,
    },
  ) {
    this.lines = splitSourceLines(text);
  }

  get lineCount(): number {
    return this.lines.length;
  }

  layoutLine(lineIndex: number, out: LineGeometry): LineGeometry {
    const line = this.lines[lineIndex] ?? "";
    if (isAsciiLine(line)) return this.layoutAsciiLine(line, out);
    return this.layoutSegmentedLine(line, out);
  }

  private layoutAsciiLine(line: string, out: LineGeometry): LineGeometry {
    resetGeometry(out);
    let x = 0;
    let visibleColumn = 0;
    for (let index = 0; index < line.length; index += 1) {
      const clusterIndex = out.clusterCount;
      ensureGeometryCapacity(out, clusterIndex + 1);
      const cluster = line[index] ?? "";
      const nextVisibleColumn = visibleColumnAfter(
        cluster,
        visibleColumn,
        this.metrics.tabSize,
      );
      x += clusterAdvance(
        cluster,
        visibleColumn,
        nextVisibleColumn,
        this.metrics,
      );
      out.clusterCount = clusterIndex + 1;
      out.utf16Starts[out.clusterCount] = index + 1;
      out.xs[out.clusterCount] = x;
      visibleColumn = nextVisibleColumn;
    }
    return out;
  }

  private layoutSegmentedLine(line: string, out: LineGeometry): LineGeometry {
    resetGeometry(out);
    let x = 0;
    let visibleColumn = 0;
    for (const segment of GRAPHEME_SEGMENTER.segment(line)) {
      const clusterIndex = out.clusterCount;
      ensureGeometryCapacity(out, clusterIndex + 1);
      const cluster = segment.segment;
      const nextVisibleColumn = visibleColumnAfter(
        cluster,
        visibleColumn,
        this.metrics.tabSize,
      );
      x += clusterAdvance(
        cluster,
        visibleColumn,
        nextVisibleColumn,
        this.metrics,
      );
      out.clusterCount = clusterIndex + 1;
      out.utf16Starts[out.clusterCount] = segment.index + cluster.length;
      out.xs[out.clusterCount] = x;
      visibleColumn = nextVisibleColumn;
    }
    return out;
  }

  cells(lineIndex: number): LayoutCell[] {
    const line = this.lines[lineIndex] ?? "";
    const geometry = this.layoutLine(lineIndex, this.geometry);
    const cells: LayoutCell[] = [];
    for (let index = 0; index < geometry.clusterCount; index += 1) {
      const utf16Offset = geometry.utf16Starts[index] ?? 0;
      const nextOffset = geometry.utf16Starts[index + 1] ?? utf16Offset;
      const x = geometry.xs[index] ?? 0;
      const nextX = geometry.xs[index + 1] ?? x;
      cells.push({
        text: line.slice(utf16Offset, nextOffset),
        utf16Offset,
        utf16Length: nextOffset - utf16Offset,
        x,
        advance: nextX - x,
      });
    }
    return cells;
  }

  width(lineIndex: number): number {
    const geometry = this.layoutLine(lineIndex, this.geometry);
    return geometry.xs[geometry.clusterCount] ?? 0;
  }

  xAtOffset(lineIndex: number, utf16Offset: number): number {
    const geometry = this.layoutLine(lineIndex, this.geometry);
    if (utf16Offset <= 0) return geometry.xs[0] ?? 0;
    for (let index = 0; index < geometry.clusterCount; index += 1) {
      const nextOffset = geometry.utf16Starts[index + 1] ?? 0;
      if (utf16Offset < nextOffset) return geometry.xs[index] ?? 0;
    }
    return geometry.xs[geometry.clusterCount] ?? 0;
  }

  offsetAtX(lineIndex: number, x: number): number {
    const geometry = this.layoutLine(lineIndex, this.geometry);
    const pointX = Math.max(0, x);
    for (let index = 0; index < geometry.clusterCount; index += 1) {
      const startX = geometry.xs[index] ?? 0;
      const advance = (geometry.xs[index + 1] ?? startX) - startX;
      if (pointX < startX + advance / 2) {
        return geometry.utf16Starts[index] ?? 0;
      }
    }
    return geometry.utf16Starts[geometry.clusterCount] ?? 0;
  }

  columnAtX(lineIndex: number, x: number): number {
    return this.offsetAtX(lineIndex, x) + 1;
  }

  positionAt(
    contentX: number,
    contentY: number,
  ): {
    lineNumber: number;
    column: number;
  } {
    const lineIndex = Math.min(
      Math.max(Math.floor(contentY / this.metrics.lineHeight), 0),
      this.lineCount - 1,
    );
    return {
      lineNumber: lineIndex + 1,
      column: this.columnAtX(lineIndex, Math.max(0, contentX)),
    };
  }
}

function ensureGeometryCapacity(
  out: LineGeometry,
  requiredClusterCount: number,
): void {
  if (requiredClusterCount < out.utf16Starts.length) return;
  let capacity = Math.max(1, out.utf16Starts.length - 1);
  while (capacity < requiredClusterCount) capacity *= 2;
  const utf16Starts = out.utf16Starts;
  const xs = out.xs;
  out.utf16Starts = new Uint32Array(capacity + 1);
  out.xs = new Float64Array(capacity + 1);
  out.utf16Starts.set(utf16Starts);
  out.xs.set(xs);
}

function resetGeometry(out: LineGeometry): void {
  out.clusterCount = 0;
  out.utf16Starts[0] = 0;
  out.xs[0] = 0;
}

function isAsciiLine(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line.charCodeAt(index) >= 0x80) return false;
  }
  return true;
}

function visibleColumnAfter(
  cluster: string,
  visibleColumn: number,
  tabSize: number,
): number {
  if (cluster === "\t") return nextRenderTabStop(visibleColumn, tabSize);
  let nextColumn = visibleColumn;
  for (let index = 0; index < cluster.length; index += 1) {
    nextColumn += isMonacoFullWidthCharacter(cluster.charCodeAt(index)) ? 2 : 1;
  }
  return nextColumn;
}

function clusterAdvance(
  cluster: string,
  visibleColumn: number,
  nextVisibleColumn: number,
  metrics: LineMetrics,
): number {
  if (cluster === "\t") {
    return (nextVisibleColumn - visibleColumn) * metrics.narrowAdvance;
  }
  return metrics.advanceFor(cluster);
}

function nextRenderTabStop(visibleColumn: number, tabSize: number): number {
  return visibleColumn + tabSize - (visibleColumn % tabSize);
}

function isMonacoFullWidthCharacter(charCode: number): boolean {
  return (
    (charCode >= 0x2e80 && charCode <= 0xd7af) ||
    (charCode >= 0xf900 && charCode <= 0xfaff) ||
    (charCode >= 0xff01 && charCode <= 0xff5e) ||
    (charCode >= 0xffe0 && charCode <= 0xffe6)
  );
}
