import {
  isWhitespaceCluster,
  LineLayout,
  type LineWindow,
} from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import {
  encodeRasterCells,
  RasterCellWriter,
  type CellPlacement,
  type EncodedRasterCells,
  type RasterCellInput,
} from "../text/raster-job";
import { LineNumberLayout } from "../text/line-number-layout";
import type { CodeTextMetrics } from "../text/text-metrics";
import {
  buildMinimapLabelRasterJob,
  layoutMinimapLabel,
  type MinimapLabelLayout,
} from "./minimap-label";
import { tileContentSize } from "./tile-plan";
import type {
  TileContentSource,
  TileLabelContentSource,
} from "./tile-kind-jobs";

const HEADER_PADDING_CSS = 16;
const MINIMAP_LABEL_PADDING_CSS = 12;
const MINIMAP_LABEL_FILL = "#FFFFFF";

interface TileContentSourceBuilderOptions {
  readonly metrics: CodeTextMetrics;
  readonly font: FontDefinition;
  readonly palette: readonly string[];
  readonly lineNumberColorIndex: number;
  readonly baseline: number;
  readonly lineHeight: number;
  readonly backgroundColor: string;
  readonly headerBackgroundColor: string;
}

interface TileContentSourceInput {
  readonly fileId: string;
  readonly filePath: string;
  readonly contentVersion: number;
  readonly highlighted: boolean;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly window: LineWindow;
}

interface TileContentSourceRecord {
  readonly fileId: string;
  readonly filePath: string;
  readonly hasText: boolean;
  readonly contentVersion: number;
  readonly highlighted: boolean;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly window?: LineWindow;
}

interface TileLabelSourceOptions {
  readonly filePath: string;
  readonly frame: Rect;
  readonly zoom: number;
  readonly font: FontDefinition;
  readonly metrics: CodeTextMetrics;
}

export class TileContentSourceBuilder {
  private readonly sourceFields: Pick<
    TileContentSource,
    | "palette"
    | "baseline"
    | "lineHeight"
    | "backgroundColor"
    | "headerBackgroundColor"
  >;
  private readonly scratch = {
    rasterCellWriter: new RasterCellWriter(),
    cellPlacement: { x: 0, line: 0, colorIndex: 0 } satisfies CellPlacement,
    contentPosition: { column: 0, size: 0, gutterWidth: 0 },
    lineNumberLayout: undefined as LineNumberLayout | undefined,
  };

  constructor(private readonly options: TileContentSourceBuilderOptions) {
    this.sourceFields = {
      palette: options.palette,
      baseline: options.baseline,
      lineHeight: options.lineHeight,
      backgroundColor: options.backgroundColor,
      headerBackgroundColor: options.headerBackgroundColor,
    };
  }

  contentSourceFor(input: TileContentSourceInput): TileContentSource {
    return this.sourceFor({ ...input, hasText: true });
  }

  titleSourceFor(fileId: string, filePath: string): TileContentSource {
    return this.sourceFor({
      fileId,
      filePath,
      hasText: false,
      contentVersion: -1,
      highlighted: false,
      contentWidth: 0,
      contentHeight: 0,
    });
  }

  labelSourceFor(
    filePath: string,
    frame: Rect,
    zoom: number,
  ): TileLabelContentSource {
    const options = {
      filePath,
      frame,
      zoom,
      font: this.options.font,
      metrics: this.options.metrics,
    };
    const layout = layoutTileLabel(options);
    return {
      identity: `${filePath}\u0000${layout.text}\u0000${String(layout.fontSize)}`,
      x: layout.x / zoom,
      y: layout.y / zoom,
      width: layout.width / zoom,
      height: layout.height / zoom,
      jobFor: () =>
        buildMinimapLabelRasterJob({
          layout,
          zoom,
          font: this.options.font,
          fillColor: MINIMAP_LABEL_FILL,
        }),
    };
  }

  private sourceFor(input: TileContentSourceRecord): TileContentSource {
    const { window, ...source } = input;
    return {
      ...source,
      ...this.sourceFields,
      cellsFor: window
        ? (column, row, rasterScale) =>
            this.buildContentCells(window, column, row, rasterScale)
        : () => encodeRasterCells([]),
      headerCellsFor: (column, rasterScale) =>
        buildHeaderCells(
          input.filePath,
          this.options.metrics,
          column,
          rasterScale,
        ),
    };
  }

  private buildContentCells(
    window: LineWindow,
    column: number,
    row: number,
    rasterScale: number,
  ): EncodedRasterCells {
    const size = tileContentSize(rasterScale);
    const lineHeight = this.options.metrics.lineHeight;
    const firstLine = Math.max(
      window.firstLine,
      Math.floor((row * size) / lineHeight) - 1,
    );
    const lastLine = Math.min(
      window.firstLine + window.lines.length,
      Math.ceil(((row + 1) * size) / lineHeight) + 1,
    );
    this.scratch.rasterCellWriter.reset();
    this.scratch.contentPosition.column = column;
    this.scratch.contentPosition.size = size;
    const gutter = this.options.metrics.lineNumberGutter;
    const numberAreaWidth = gutter.numberAreaWidth(window.lineCount);
    this.scratch.contentPosition.gutterWidth = gutter.codeLeft(
      window.lineCount,
    );
    for (let line = firstLine; line < lastLine; line += 1) {
      this.appendLineCells(window, line);
      if (column === 0) this.appendLineNumberCells(line, numberAreaWidth);
    }
    return this.scratch.rasterCellWriter.finish();
  }

  private appendLineCells(window: LineWindow, line: number): void {
    const lineIndex = line - window.firstLine;
    const lineStart = window.lineCellOffsets[lineIndex] ?? 0;
    const lineEnd = window.lineCellOffsets[lineIndex + 1] ?? lineStart;
    const sourceLine = window.lines[lineIndex] ?? "";
    for (let cell = lineStart; cell < lineEnd; cell += 1) {
      const start = window.cellStarts[cell] ?? 0;
      const end = window.cellEnds[cell] ?? start;
      const localX =
        this.scratch.contentPosition.gutterWidth +
        (window.cellXs[cell] ?? 0) -
        this.scratch.contentPosition.column * this.scratch.contentPosition.size;
      if (
        localX < -this.scratch.contentPosition.size ||
        localX > 2 * this.scratch.contentPosition.size
      )
        continue;
      this.scratch.cellPlacement.x = localX;
      this.scratch.cellPlacement.line = line;
      this.scratch.cellPlacement.colorIndex = window.cellColors[cell] ?? 0;
      this.scratch.rasterCellWriter.appendCluster(
        sourceLine,
        start,
        end,
        this.scratch.cellPlacement,
      );
    }
  }

  private appendLineNumberCells(line: number, numberAreaWidth: number): void {
    const digits = this.getLineNumberLayout();
    const totalWidth = digits.width(line + 1);
    const startX = Math.max(0, numberAreaWidth - totalWidth);
    this.scratch.cellPlacement.x = startX;
    this.scratch.cellPlacement.line = line;
    this.scratch.cellPlacement.colorIndex = this.options.lineNumberColorIndex;
    digits.write(
      this.scratch.rasterCellWriter,
      line + 1,
      this.scratch.cellPlacement,
    );
  }

  private getLineNumberLayout(): LineNumberLayout {
    this.scratch.lineNumberLayout ??= new LineNumberLayout(
      this.options.metrics.advanceFor,
    );
    return this.scratch.lineNumberLayout;
  }
}

function buildHeaderCells(
  path: string,
  metrics: CodeTextMetrics,
  column: number,
  rasterScale: number,
): EncodedRasterCells {
  const size = tileContentSize(rasterScale);
  const titleLayout = new LineLayout(path, metrics);
  const cells: RasterCellInput[] = [];
  titleLayout.cells(0).forEach((cell) => {
    if (isWhitespaceCluster(cell.text, 0, cell.text.length)) return;
    const localX = HEADER_PADDING_CSS + cell.x - column * size;
    if (localX < -size || localX > 2 * size) return;
    cells.push({ cluster: cell.text, x: localX, line: 0, colorIndex: 0 });
  });
  return encodeRasterCells(cells);
}

function layoutTileLabel(options: TileLabelSourceOptions): MinimapLabelLayout {
  return layoutMinimapLabel({
    filePath: options.filePath,
    widgetWidth: options.frame.width * options.zoom,
    widgetHeight: (options.frame.height - options.font.bodyTop) * options.zoom,
    padding: MINIMAP_LABEL_PADDING_CSS,
    baseFontSize: options.font.size,
    baseBaseline: options.metrics.baseline,
    baseLineHeight: options.metrics.lineHeight,
    advanceFor: options.metrics.advanceFor,
  });
}
