import type { Camera } from "../../board/index";
import type {
  FallbackDocument,
  GpuUploader,
  TokenizedLines,
} from "../../code-view/index";
import { LineLayout } from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { MinimapPass } from "../passes/minimap-pass";
import type { TileDrawContext } from "../passes/tile-pass";
import type { RasterCellInput } from "../text/raster-job";
import type {
  CodeTextMetrics,
  TextMetricsProbe,
  TextMetricsProbeLine,
} from "../text/text-metrics";
import { isWhitespaceCluster } from "../text/text-metrics";
import type { Viewport } from "../viewport";
import { PaletteTexture } from "./palette-texture";
import type { FrameDrawMetrics } from "./frame-draw-metrics";
import {
  buildMinimapLabelRasterJob,
  layoutMinimapLabel,
  type MinimapLabelLayout,
} from "./minimap-label";
import { tileContentSize } from "./tile-plan";
import {
  TileResidency,
  type TileContentSource,
  type TileDebugSnapshot,
} from "./tile-residency";
import { WidgetTable } from "./widget-table";

interface GpuUploaderConfig {
  readonly metrics: CodeTextMetrics;
  readonly font: FontDefinition;
  readonly widgetBackground: string;
  readonly viewport: Viewport;
}

const DEFAULT_VISIBLE_LINES = 60;
// Text that has no token colour yet (D6 "Until tokens are available, the
// widget is drawn in a single color"); kept separate from the line-number
// colour so both survive a palette rebuild independently of token count.
const DEFAULT_TEXT_COLOR = "#D4D4D4";
const LINE_NUMBER_COLOR = "#5A6270";
// Wide enough for a 4-digit line number (narrowAdvance * 4 + padding) at the
// slice's font; line numbers are drawn only in the leftmost tile column
// (D6 "9.6 ... line numbers inside the tiles").
const LINE_NUMBER_GUTTER_CSS = 40;
const LINE_NUMBER_PADDING_CSS = 8;
const HEADER_PADDING_CSS = 16;
const MINIMAP_LABEL_PADDING_CSS = 12;
const MINIMAP_LABEL_FILL = "#FFFFFF";

export class GpuUploaderAdapter implements GpuUploader {
  readonly palette: PaletteTexture;
  readonly table = new WidgetTable();
  readonly minimapPass: MinimapPass;
  readonly residency: TileResidency;
  private path = "";
  private fileId = "";
  private layout: LineLayout | undefined;
  private visibleStart = 0;
  private visibleEnd = DEFAULT_VISIBLE_LINES;
  private tokens: TokenizedLines | undefined;
  private readonly metrics: CodeTextMetrics;
  private readonly font: FontDefinition;
  private readonly widgetBackground: string;
  private labelZoom = 1;
  private zoomGestureActive = false;
  private minimapActive = false;
  private labelNeedsLayout = false;

  constructor(gl: WebGL2RenderingContext, config: GpuUploaderConfig) {
    this.metrics = config.metrics;
    this.font = config.font;
    this.widgetBackground = config.widgetBackground;
    this.palette = new PaletteTexture(gl);
    this.minimapPass = new MinimapPass(gl, this.palette, config.font);
    this.residency = new TileResidency(gl, {
      metrics: config.metrics,
      font: config.font,
      viewport: config.viewport,
    });
  }

  setDocument(fileId: string, path: string, text: string, frame: Rect): void {
    this.fileId = fileId;
    this.path = path;
    this.layout = new LineLayout(text, this.metrics);
    this.table.setWidget(frame);
    this.tokens = undefined;
  }

  getTextMetricsProbe(): TextMetricsProbe {
    return {
      baseline: this.metrics.baseline,
      lines: visibleProbeLines(this.layout, this.visibleStart, this.visibleEnd),
    };
  }

  setVisibleRange(start: number, end: number): void {
    this.visibleStart = Math.max(0, start);
    this.visibleEnd = Math.max(this.visibleStart + 1, end);
  }

  uploadFallback(document: FallbackDocument): void {
    if (!this.isCurrent(document.fileId)) return;
    this.layout = new LineLayout(document.text, this.metrics);
    this.tokens = undefined;
    this.palette.update([]);
    this.refreshContentSource(document.contentVersion, false);
  }

  uploadTokens(document: TokenizedLines): void {
    if (!this.isCurrent(document.fileId)) return;
    this.tokens = document;
    this.palette.update(document.palette);
    this.refreshContentSource(document.contentVersion, true);
    if (document.minimap && document.minimapHeight) {
      this.minimapPass.upload(document.minimap, document.minimapHeight);
    }
  }

  drainTiles(
    camera: Camera,
    viewportCss: Viewport,
    bodyTopCss: number,
  ): number {
    if (
      this.labelNeedsLayout ||
      (!this.zoomGestureActive && camera.scale !== this.labelZoom)
    ) {
      this.refreshLabelSource(camera.scale);
      this.labelNeedsLayout = false;
    }
    return this.residency.drainTiles(
      camera,
      viewportCss,
      this.table.frame,
      bodyTopCss,
    );
  }

  buildFrameInstances(detailIsMinimap: boolean): FrameDrawMetrics {
    return this.residency.buildFrameInstances(detailIsMinimap);
  }

  setDetailLevel(detailIsMinimap: boolean, textWanted: boolean): void {
    if (detailIsMinimap && !this.minimapActive) this.labelNeedsLayout = true;
    this.minimapActive = detailIsMinimap;
    this.residency.setDetailLevel(detailIsMinimap, textWanted);
  }

  beginTextPrefetch(thresholdZoom: number): void {
    this.residency.beginTextPrefetch(thresholdZoom);
  }

  textReady(): boolean {
    return this.residency.textReady();
  }

  drawTiles(context: TileDrawContext): void {
    this.residency.draw(context);
  }

  rasterError(): string | undefined {
    return this.residency.rasterError();
  }

  onNeedsRedraw(callback: () => void): void {
    this.residency.onNeedsRedraw(callback);
  }

  debugSnapshot(): TileDebugSnapshot {
    return this.residency.debugSnapshot();
  }

  tilesCurrentFor(fileId: string, contentVersion: number): boolean {
    return (
      this.fileId === fileId && this.residency.tilesCurrentFor(contentVersion)
    );
  }

  setZoomGestureActive(active: boolean): void {
    this.zoomGestureActive = active;
    this.residency.setZoomGestureActive(active);
  }

  setZoomFocus(x: number, y: number, zoomOut: boolean): void {
    this.residency.setZoomFocus(x, y, zoomOut);
  }

  notifyGestureEnded(wasZoom: boolean, cameraScale: number): void {
    if (wasZoom && cameraScale !== this.labelZoom) {
      this.refreshLabelSource(cameraScale);
    }
    this.residency.notifyGestureEnded(wasZoom, cameraScale);
  }

  private refreshContentSource(
    contentVersion: number,
    highlighted: boolean,
  ): void {
    if (!this.layout) return;
    const layout = this.layout;
    const source: TileContentSource = {
      filePath: this.path,
      contentVersion,
      highlighted,
      contentWidth: this.table.frame.width,
      contentHeight: layout.lines.length * this.metrics.lineHeight,
      palette: this.buildJobPalette(),
      baseline: this.metrics.baseline,
      lineHeight: this.metrics.lineHeight,
      backgroundColor: this.widgetBackground,
      cellsFor: (column, row, rasterScale) =>
        this.buildContentCells(layout, column, row, rasterScale),
      headerCellsFor: (column, rasterScale) =>
        this.buildHeaderCells(column, rasterScale),
      label: this.buildLabelSource(this.labelZoom),
    };
    this.residency.setContentSource(source);
  }

  private refreshLabelSource(zoom: number): void {
    if (!this.layout) return;
    this.labelZoom = zoom;
    this.residency.setLabelSource(this.buildLabelSource(zoom));
  }

  private buildLabelSource(zoom: number) {
    const layout = this.layoutMinimapLabel(zoom);
    return {
      identity: `${this.path}\u0000${layout.text}\u0000${String(layout.fontSize)}`,
      x: layout.x / zoom,
      y: layout.y / zoom,
      width: layout.width / zoom,
      height: layout.height / zoom,
      jobFor: () =>
        buildMinimapLabelRasterJob({
          layout,
          zoom,
          font: this.font,
          fillColor: MINIMAP_LABEL_FILL,
        }),
    };
  }

  private layoutMinimapLabel(zoom: number): MinimapLabelLayout {
    return layoutMinimapLabel({
      filePath: this.path,
      widgetWidth: this.table.frame.width * zoom,
      widgetHeight: (this.table.frame.height - this.font.bodyTop) * zoom,
      padding: MINIMAP_LABEL_PADDING_CSS,
      baseFontSize: this.font.size,
      baseBaseline: this.metrics.baseline,
      baseLineHeight: this.metrics.lineHeight,
      advanceFor: this.metrics.advanceFor,
    });
  }

  private buildJobPalette(): string[] {
    return [
      DEFAULT_TEXT_COLOR,
      ...(this.tokens?.palette ?? []),
      LINE_NUMBER_COLOR,
    ];
  }

  private lineNumberColorIndex(): number {
    return 1 + (this.tokens?.palette.length ?? 0);
  }

  private colorIndexFor(line: number, offset: number): number {
    return this.tokens ? colorAt(this.tokens, line, offset) + 1 : 0;
  }

  private buildContentCells(
    layout: LineLayout,
    column: number,
    row: number,
    rasterScale: number,
  ): RasterCellInput[] {
    const size = tileContentSize(rasterScale);
    const lineHeight = this.metrics.lineHeight;
    const firstLine = Math.max(0, Math.floor((row * size) / lineHeight) - 1);
    const lastLine = Math.min(
      layout.lines.length,
      Math.ceil(((row + 1) * size) / lineHeight) + 1,
    );
    const cells: RasterCellInput[] = [];
    const position = { column, size };
    for (let line = firstLine; line < lastLine; line += 1) {
      this.appendLineCells(cells, layout, line, position);
      if (column === 0) this.appendLineNumberCells(cells, line);
    }
    return cells;
  }

  private appendLineCells(
    cells: RasterCellInput[],
    layout: LineLayout,
    line: number,
    position: { readonly column: number; readonly size: number },
  ): void {
    layout.cells(line).forEach((cell) => {
      if (cell.text === "\t") return;
      const localX =
        LINE_NUMBER_GUTTER_CSS + cell.x - position.column * position.size;
      if (localX < -position.size || localX > 2 * position.size) return;
      cells.push({
        cluster: cell.text,
        x: localX,
        line,
        colorIndex: this.colorIndexFor(line, cell.utf16Offset),
      });
    });
  }

  private appendLineNumberCells(cells: RasterCellInput[], line: number): void {
    const digits = new LineLayout(String(line + 1), this.metrics);
    const digitCells = digits.cells(0);
    const totalWidth = digits.width(0);
    const startX = Math.max(
      0,
      LINE_NUMBER_GUTTER_CSS - LINE_NUMBER_PADDING_CSS - totalWidth,
    );
    const colorIndex = this.lineNumberColorIndex();
    digitCells.forEach((cell) => {
      cells.push({ cluster: cell.text, x: startX + cell.x, line, colorIndex });
    });
  }

  private buildHeaderCells(
    column: number,
    rasterScale: number,
  ): RasterCellInput[] {
    const size = tileContentSize(rasterScale);
    const titleLayout = new LineLayout(this.path, this.metrics);
    const cells: RasterCellInput[] = [];
    titleLayout.cells(0).forEach((cell) => {
      if (cell.text === "\t") return;
      const localX = HEADER_PADDING_CSS + cell.x - column * size;
      if (localX < -size || localX > 2 * size) return;
      cells.push({ cluster: cell.text, x: localX, line: 0, colorIndex: 0 });
    });
    return cells;
  }

  private isCurrent(fileId: string): boolean {
    return Boolean(this.layout) && fileId === this.fileId;
  }
}

function visibleProbeLines(
  layout: LineLayout | undefined,
  visibleStart: number,
  visibleEnd: number,
): TextMetricsProbeLine[][] {
  if (!layout) return [];
  const lines: TextMetricsProbeLine[][] = Array.from(
    { length: Math.min(DEFAULT_VISIBLE_LINES, layout.lines.length) },
    () => [],
  );
  const start = Math.max(0, visibleStart);
  const end = Math.min(visibleEnd, lines.length);
  for (let line = start; line < end; line += 1) {
    lines[line] = layout
      .cells(line)
      .filter((cell) => !isWhitespaceCluster(cell.text))
      .map((cell) => ({ cluster: cell.text, x: cell.x }));
  }
  return lines;
}

function colorAt(
  document: TokenizedLines,
  line: number,
  offset: number,
): number {
  const start = document.lineRunOffsets[line] ?? 0;
  const end = document.lineRunOffsets[line + 1] ?? start;
  let color = 0;
  for (let index = start; index < end; index += 2) {
    const tokenOffset = document.runs[index] ?? 0;
    if (tokenOffset > offset) break;
    color = document.runs[index + 1] ?? color;
  }
  return color;
}
