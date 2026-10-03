import type { CameraView } from "../../board/index";
import type {
  GpuUploader,
  LineWindow,
  MinimapUpload,
} from "../../code-view/index";
import { LineLayout } from "../../code-view/index";
import type { ThemePalette } from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { MinimapPass } from "../passes/minimap-pass";
import type { TileDrawContext } from "../passes/tile-pass";
import {
  encodeRasterCells,
  RasterCellWriter,
  type CellPlacement,
  type EncodedRasterCells,
  type RasterCellInput,
} from "../text/raster-job";
import { LineNumberLayout } from "../text/line-number-layout";
import {
  isWhitespaceCluster,
  type CodeTextMetrics,
  type TextMetricsProbe,
  type TextMetricsProbeLine,
} from "../text/text-metrics";
import type { Viewport } from "../viewport";
import { WIDGET_HEADER_COLOR } from "../widget-colors";
import { PaletteTexture } from "./palette-texture";
import type { FrameDrawMetrics } from "./frame-draw-metrics";
import {
  buildMinimapLabelRasterJob,
  layoutMinimapLabel,
  type MinimapLabelLayout,
} from "./minimap-label";
import { tileContentSize } from "./tile-plan";
import { TileResidency, type TileDebugSnapshot } from "./tile-residency";
import type { TileDemand } from "./tile-residency";
import type {
  TileContentSource,
  TileLabelContentSource,
} from "./tile-job-queue";
import { WidgetTable } from "./widget-table";
import type { WidgetId } from "./widget-table";
import { MinimapAtlas } from "./minimap-atlas";

interface GpuUploaderConfig {
  readonly metrics: CodeTextMetrics;
  readonly font: FontDefinition;
  readonly palette: ThemePalette;
  readonly viewport: Viewport;
  readonly table: WidgetTable;
  readonly tableTexture: WebGLTexture;
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
  palette: PaletteTexture;
  minimapPass: MinimapPass;
  private minimapAtlas: MinimapAtlas;
  residency: TileResidency;
  private fileId = "";
  private paths: ReadonlyMap<string, string> = new Map();
  private window: LineWindow | undefined;
  private visibleStart = 0;
  private visibleEnd = DEFAULT_VISIBLE_LINES;
  private readonly metrics: CodeTextMetrics;
  private readonly font: FontDefinition;
  private readonly gl: WebGL2RenderingContext;
  private readonly viewport: Viewport;
  private readonly widgetBackground: string;
  private readonly themeColors: readonly string[];
  private readonly table: WidgetTable;
  private readonly sourceFrame: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly windows = new Map<string, LineWindow>();
  private readonly minimaps = new Map<string, MinimapUpload>();
  private readonly restoredMinimapIds: string[] = [];
  private minimapFiles: readonly string[] = [];
  private restoredMinimapIndex = 0;
  private redrawCallback: (() => void) | undefined;
  private contextLost = false;
  private minimapActive = false;
  private textWanted = false;
  private hiddenBodyId: string | undefined;
  private documentPath = "";
  private readonly rasterCellWriter = new RasterCellWriter();
  private readonly cellPlacement: CellPlacement = {
    x: 0,
    line: 0,
    colorIndex: 0,
  };
  private readonly contentPosition = { column: 0, size: 0 };
  private lineNumberLayout: LineNumberLayout | undefined;

  constructor(gl: WebGL2RenderingContext, config: GpuUploaderConfig) {
    this.gl = gl;
    this.viewport = config.viewport;
    this.table = config.table;
    this.metrics = config.metrics;
    this.font = config.font;
    this.widgetBackground = config.palette.background;
    this.themeColors = config.palette.colors;
    this.palette = new PaletteTexture(gl);
    this.palette.update(config.palette.colors);
    this.minimapAtlas = new MinimapAtlas(gl);
    this.minimapPass = new MinimapPass(gl, {
      palette: this.palette,
      atlas: this.minimapAtlas,
      tableTexture: config.tableTexture,
      font: config.font,
    });
    this.residency = this.createResidency(gl, config.tableTexture);
  }

  setDocument(fileId: string, path: string): void {
    this.fileId = fileId;
    this.documentPath = path;
    this.table.setDocumentId(fileId);
    this.window = undefined;
    this.residency.setDocument(fileId);
  }

  setFilePaths(paths: ReadonlyMap<string, string>): void {
    this.paths = paths;
    for (const fileId of this.windows.keys()) {
      if (!paths.has(fileId)) this.windows.delete(fileId);
    }
    for (const fileId of this.minimaps.keys()) {
      if (!paths.has(fileId)) this.minimaps.delete(fileId);
    }
    if (this.fileId && !paths.has(this.fileId)) this.window = undefined;
    this.residency.setFilePaths(paths);
  }

  setMinimapFiles(fileIds: readonly string[]): void {
    this.minimapFiles = fileIds;
    if (this.contextLost) return;
    this.minimapAtlas.setFiles(fileIds);
  }

  setHiddenBody(fileId: string | undefined): void {
    this.hiddenBodyId = fileId;
    this.residency.setHiddenBody(fileId);
  }

  getTextMetricsProbe(): TextMetricsProbe {
    return {
      baseline: this.metrics.baseline,
      lines: visibleProbeLines(this.window, this.visibleStart, this.visibleEnd),
    };
  }

  cellColors(): { cluster: string; colorIndex: number }[][] {
    return visibleProbeCells(
      this.window,
      this.visibleStart,
      this.visibleEnd,
    ).map((line) =>
      line
        .filter((cell) => !isWhitespaceCluster(cell.cluster))
        .map(({ cluster, colorIndex }) => ({ cluster, colorIndex })),
    );
  }

  setVisibleRange(start: number, end: number): void {
    this.visibleStart = Math.max(0, start);
    this.visibleEnd = Math.max(this.visibleStart + 1, end);
  }

  uploadLineWindow(window: LineWindow): void {
    if (!this.residency.isRegistered(window.fileId)) return;
    this.windows.set(window.fileId, window);
    if (this.isCurrent(window.fileId)) this.window = window;
    this.refreshContentSource(window);
  }

  uploadMinimap(minimap: MinimapUpload): void {
    this.minimaps.set(minimap.fileId, minimap);
    if (this.contextLost) return;
    this.minimapAtlas.upload(minimap.fileId, minimap.bytes, minimap.height);
  }

  highlighted(): boolean {
    return this.window?.highlighted === true;
  }

  drainTiles(
    camera: CameraView,
    viewportCss: Viewport,
    bodyTopCss: number,
    deadline: number,
  ): number {
    if (this.contextLost) return 0;
    const uploadedTiles = this.residency.drainTiles(
      camera,
      viewportCss,
      bodyTopCss,
      deadline,
    );
    return uploadedTiles + this.drainRestoredMinimaps();
  }

  buildFrameInstances(detailIsMinimap: boolean): FrameDrawMetrics {
    return this.residency.buildFrameInstances(detailIsMinimap);
  }

  setDetailLevel(detailIsMinimap: boolean, textWanted: boolean): void {
    this.minimapActive = detailIsMinimap;
    this.textWanted = textWanted;
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
    this.redrawCallback = callback;
    this.residency.onNeedsRedraw(callback);
  }

  setContextLost(lost: boolean): void {
    this.contextLost = lost;
  }

  settled(): boolean {
    return !this.contextLost && this.residency.settled();
  }

  restore(tableTexture: WebGLTexture): void {
    this.residency.dispose();
    this.palette = new PaletteTexture(this.gl);
    this.palette.update(this.themeColors);
    this.minimapAtlas = new MinimapAtlas(this.gl);
    this.minimapPass = new MinimapPass(this.gl, {
      palette: this.palette,
      atlas: this.minimapAtlas,
      tableTexture,
      font: this.font,
    });
    this.residency = this.createResidency(this.gl, tableTexture);
    this.replayState();
    this.queueRestoredMinimaps();
  }

  debugSnapshot(): TileDebugSnapshot {
    return this.residency.debugSnapshot();
  }

  tileDemand(out: TileDemand): void {
    this.residency.tileDemand(out);
  }

  tilesCurrentFor(fileId: string, contentVersion: number): boolean {
    return this.residency.tilesCurrentFor(fileId, contentVersion);
  }

  setZoomGestureActive(active: boolean): void {
    this.residency.setZoomGestureActive(active);
  }

  setZoomFocus(x: number, y: number, zoomOut: boolean): void {
    this.residency.setZoomFocus(x, y, zoomOut);
  }

  notifyGestureEnded(wasZoom: boolean, cameraScale: number): void {
    this.residency.notifyGestureEnded(wasZoom, cameraScale);
  }

  private refreshContentSource(window: LineWindow): void {
    const path = this.pathFor(window.fileId);
    if (!path) return;
    const frame = this.sourceFrame;
    this.table.readFrame(
      this.table.rowFor(window.fileId as WidgetId) ?? -1,
      frame,
    );
    const source: TileContentSource = {
      fileId: window.fileId,
      filePath: path,
      hasText: true,
      contentVersion: window.contentVersion,
      highlighted: window.highlighted,
      contentWidth: frame.width,
      contentHeight: window.lineCount * this.metrics.lineHeight,
      palette: this.buildJobPalette(),
      baseline: this.metrics.baseline,
      lineHeight: this.metrics.lineHeight,
      backgroundColor: this.widgetBackground,
      headerBackgroundColor: WIDGET_HEADER_COLOR,
      cellsFor: (column, row, rasterScale) =>
        this.buildContentCells(window, column, row, rasterScale),
      headerCellsFor: (column, rasterScale) =>
        this.buildHeaderCells(path, column, rasterScale),
    };
    this.residency.setContentSource(window.fileId, source);
  }

  private pathFor(fileId: string): string | undefined {
    return (
      this.paths.get(fileId) ??
      (fileId === this.fileId ? this.documentPath : undefined)
    );
  }

  private createResidency(
    gl: WebGL2RenderingContext,
    tableTexture: WebGLTexture,
  ): TileResidency {
    return new TileResidency(gl, {
      metrics: this.metrics,
      font: this.font,
      viewport: this.viewport,
      table: this.table,
      tableTexture,
      titleSourceFor: (fileId, path) => this.titleSourceFor(fileId, path),
      labelSourceFor: (path, frame, zoom) =>
        this.labelSourceFor(path, frame, zoom),
    });
  }

  private replayState(): void {
    this.residency.setFilePaths(this.paths);
    if (this.fileId) {
      this.residency.setDocument(this.fileId);
      this.window = this.windows.get(this.fileId);
    }
    this.residency.setDetailLevel(this.minimapActive, this.textWanted);
    this.residency.setHiddenBody(this.hiddenBodyId);
    if (this.redrawCallback) this.residency.onNeedsRedraw(this.redrawCallback);
    for (const window of this.windows.values())
      this.refreshContentSource(window);
    this.minimapAtlas.setFiles(this.minimapFiles);
  }

  private queueRestoredMinimaps(): void {
    this.restoredMinimapIds.length = 0;
    this.restoredMinimapIndex = 0;
    for (const fileId of this.minimaps.keys())
      this.restoredMinimapIds.push(fileId);
  }

  private drainRestoredMinimaps(): number {
    let uploaded = 0;
    while (
      this.restoredMinimapIndex < this.restoredMinimapIds.length &&
      uploaded < 8
    ) {
      const fileId = this.restoredMinimapIds[this.restoredMinimapIndex];
      this.restoredMinimapIndex += 1;
      if (!fileId) continue;
      const minimap = this.minimaps.get(fileId);
      if (!minimap) continue;
      this.minimapAtlas.upload(fileId, minimap.bytes, minimap.height);
      uploaded += 1;
    }
    if (this.restoredMinimapIndex >= this.restoredMinimapIds.length) {
      this.restoredMinimapIds.length = 0;
      this.restoredMinimapIndex = 0;
    }
    return uploaded;
  }

  private titleSourceFor(fileId: string, path: string): TileContentSource {
    return {
      fileId,
      filePath: path,
      hasText: false,
      contentVersion: -1,
      highlighted: false,
      contentWidth: 0,
      contentHeight: 0,
      palette: this.buildJobPalette(),
      baseline: this.metrics.baseline,
      lineHeight: this.metrics.lineHeight,
      backgroundColor: this.widgetBackground,
      headerBackgroundColor: WIDGET_HEADER_COLOR,
      cellsFor: () => encodeRasterCells([]),
      headerCellsFor: (column, rasterScale) =>
        this.buildHeaderCells(path, column, rasterScale),
    };
  }

  private labelSourceFor(
    path: string,
    frame: Rect,
    zoom: number,
  ): TileLabelContentSource {
    const layout = this.layoutMinimapLabel(path, frame, zoom);
    return {
      identity: `${path}\u0000${layout.text}\u0000${String(layout.fontSize)}`,
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

  private layoutMinimapLabel(
    path: string,
    frame: Rect,
    zoom: number,
  ): MinimapLabelLayout {
    return layoutMinimapLabel({
      filePath: path,
      widgetWidth: frame.width * zoom,
      widgetHeight: (frame.height - this.font.bodyTop) * zoom,
      padding: MINIMAP_LABEL_PADDING_CSS,
      baseFontSize: this.font.size,
      baseBaseline: this.metrics.baseline,
      baseLineHeight: this.metrics.lineHeight,
      advanceFor: this.metrics.advanceFor,
    });
  }

  private buildJobPalette(): string[] {
    return [DEFAULT_TEXT_COLOR, ...this.themeColors, LINE_NUMBER_COLOR];
  }

  private lineNumberColorIndex(): number {
    return 1 + this.themeColors.length;
  }

  private buildContentCells(
    window: LineWindow,
    column: number,
    row: number,
    rasterScale: number,
  ): EncodedRasterCells {
    const size = tileContentSize(rasterScale);
    const lineHeight = this.metrics.lineHeight;
    const firstLine = Math.max(
      window.firstLine,
      Math.floor((row * size) / lineHeight) - 1,
    );
    const lastLine = Math.min(
      window.firstLine + window.lines.length,
      Math.ceil(((row + 1) * size) / lineHeight) + 1,
    );
    this.rasterCellWriter.reset();
    this.contentPosition.column = column;
    this.contentPosition.size = size;
    for (let line = firstLine; line < lastLine; line += 1) {
      this.appendLineCells(window, line, this.contentPosition);
      if (column === 0) this.appendLineNumberCells(line);
    }
    return this.rasterCellWriter.finish();
  }

  private appendLineCells(
    window: LineWindow,
    line: number,
    position: { readonly column: number; readonly size: number },
  ): void {
    const lineIndex = line - window.firstLine;
    const lineStart = window.lineCellOffsets[lineIndex] ?? 0;
    const lineEnd = window.lineCellOffsets[lineIndex + 1] ?? lineStart;
    const sourceLine = window.lines[lineIndex] ?? "";
    for (let cell = lineStart; cell < lineEnd; cell += 1) {
      const start = window.cellStarts[cell] ?? 0;
      const end = window.cellEnds[cell] ?? start;
      if (end - start === 1 && sourceLine.charCodeAt(start) === 9) continue;
      const localX =
        LINE_NUMBER_GUTTER_CSS +
        (window.cellXs[cell] ?? 0) -
        position.column * position.size;
      if (localX < -position.size || localX > 2 * position.size) continue;
      this.cellPlacement.x = localX;
      this.cellPlacement.line = line;
      this.cellPlacement.colorIndex = window.cellColors[cell] ?? 0;
      this.rasterCellWriter.appendCluster(
        sourceLine,
        start,
        end,
        this.cellPlacement,
      );
    }
  }

  private appendLineNumberCells(line: number): void {
    const digits = this.getLineNumberLayout();
    const totalWidth = digits.width(line + 1);
    const startX = Math.max(
      0,
      LINE_NUMBER_GUTTER_CSS - LINE_NUMBER_PADDING_CSS - totalWidth,
    );
    this.cellPlacement.x = startX;
    this.cellPlacement.line = line;
    this.cellPlacement.colorIndex = this.lineNumberColorIndex();
    digits.write(this.rasterCellWriter, line + 1, this.cellPlacement);
  }

  private getLineNumberLayout(): LineNumberLayout {
    this.lineNumberLayout ??= new LineNumberLayout(this.metrics.advanceFor);
    return this.lineNumberLayout;
  }

  private buildHeaderCells(
    path: string,
    column: number,
    rasterScale: number,
  ): EncodedRasterCells {
    const size = tileContentSize(rasterScale);
    const titleLayout = new LineLayout(path, this.metrics);
    const cells: RasterCellInput[] = [];
    titleLayout.cells(0).forEach((cell) => {
      if (cell.text === "\t") return;
      const localX = HEADER_PADDING_CSS + cell.x - column * size;
      if (localX < -size || localX > 2 * size) return;
      cells.push({ cluster: cell.text, x: localX, line: 0, colorIndex: 0 });
    });
    return encodeRasterCells(cells);
  }

  private isCurrent(fileId: string): boolean {
    return fileId === this.fileId;
  }
}

function visibleProbeLines(
  window: LineWindow | undefined,
  visibleStart: number,
  visibleEnd: number,
): TextMetricsProbeLine[][] {
  return visibleProbeCells(window, visibleStart, visibleEnd).map((line) =>
    line.map(({ cluster, x }) => ({ cluster, x })),
  );
}

interface VisibleProbeCell {
  readonly cluster: string;
  readonly x: number;
  readonly colorIndex: number;
}

function visibleProbeCells(
  window: LineWindow | undefined,
  visibleStart: number,
  visibleEnd: number,
): VisibleProbeCell[][] {
  if (!window) return [];
  const lines: VisibleProbeCell[][] = Array.from(
    { length: Math.min(DEFAULT_VISIBLE_LINES, window.lineCount) },
    () => [],
  );
  const start = Math.max(0, visibleStart);
  const end = Math.min(visibleEnd, lines.length);
  for (let line = start; line < end; line += 1) {
    const windowLine = line - window.firstLine;
    if (windowLine < 0 || windowLine >= window.lines.length) continue;
    const sourceLine = window.lines[windowLine] ?? "";
    const cells: VisibleProbeCell[] = [];
    const startCell = window.lineCellOffsets[windowLine] ?? 0;
    const endCell = window.lineCellOffsets[windowLine + 1] ?? startCell;
    for (let cell = startCell; cell < endCell; cell += 1) {
      const startOffset = window.cellStarts[cell] ?? 0;
      const endOffset = window.cellEnds[cell] ?? startOffset;
      cells.push({
        cluster: sourceLine.slice(startOffset, endOffset),
        x: window.cellXs[cell] ?? 0,
        colorIndex: window.cellColors[cell] ?? 0,
      });
    }
    lines[line] = cells;
  }
  return lines;
}
