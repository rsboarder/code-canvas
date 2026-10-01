import { splitSourceLines } from "../../shared/domain/line-splitting";

export interface LineMetrics {
  readonly narrowAdvance: number;
  readonly tabSize: number;
  readonly baseline: number;
  readonly advanceFor: (cluster: string) => number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export const MINIMAP_LINE_METRICS: LineMetrics = {
  narrowAdvance: 1,
  tabSize: 4,
  baseline: 1,
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

  constructor(
    text: string,
    private readonly metrics: LineMetrics = {
      narrowAdvance: 8.4,
      tabSize: 4,
      baseline: 16,
      advanceFor: () => 8.4,
    },
  ) {
    this.lines = splitSourceLines(text);
  }

  cells(lineIndex: number): LayoutCell[] {
    const line = this.lines[lineIndex] ?? "";
    const cells: LayoutCell[] = [];
    let x = 0;
    let utf16Offset = 0;
    for (const segment of GRAPHEME_SEGMENTER.segment(line)) {
      const text = segment.segment;
      const advance = this.advance(text, x);
      cells.push({
        text,
        utf16Offset,
        utf16Length: text.length,
        x,
        advance,
      });
      x += advance;
      utf16Offset += text.length;
    }
    return cells;
  }

  width(lineIndex: number): number {
    return this.cells(lineIndex).reduce(
      (total, cell) => total + cell.advance,
      0,
    );
  }

  columnAtX(lineIndex: number, x: number): number {
    const cells = this.cells(lineIndex);
    for (const cell of cells) {
      if (x < cell.x + cell.advance / 2) return cell.utf16Offset + 1;
    }
    const last = cells[cells.length - 1];
    return last ? last.utf16Offset + last.text.length + 1 : 1;
  }

  private advance(cluster: string, x: number): number {
    if (cluster === "\t") {
      const tabWidth = this.metrics.narrowAdvance * this.metrics.tabSize;
      return tabWidth - (x % tabWidth || 0);
    }
    return this.metrics.advanceFor(cluster);
  }
}
