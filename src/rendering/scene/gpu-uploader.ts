import type {
  GpuUploader,
  LineWindow,
  MinimapUpload,
  ThemePalette,
} from "../../code-view/index";
import { LineLayout } from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { MinimapPass } from "../passes/minimap-pass";
import {
  encodeRasterCells,
  RasterCellWriter,
  type CellPlacement,
  type EncodedRasterCells,
  type RasterCellInput,
} from "../text/raster-job";
import { LineNumberLayout } from "../text/line-number-layout";
import type { CodeTextMetrics } from "../text/text-metrics";
import type { Viewport } from "../viewport";
import { WIDGET_HEADER_COLOR } from "../widget-colors";
import { PaletteTexture } from "./palette-texture";
import {
  buildMinimapLabelRasterJob,
  layoutMinimapLabel,
  type MinimapLabelLayout,
} from "./minimap-label";
import { tileContentSize } from "./tile-plan";
import { TileResidency } from "./tile-residency";
import type {
  TileContentSource,
  TileLabelContentSource,
} from "./tile-kind-jobs";
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

// Text that has no token colour yet (D6 "Until tokens are available, the
// widget is drawn in a single color"); kept separate from the line-number
// colour so both survive a palette rebuild independently of token count.
const DEFAULT_TEXT_COLOR = "#D4D4D4";
const HEADER_PADDING_CSS = 16;
const MINIMAP_LABEL_PADDING_CSS = 12;
const MINIMAP_LABEL_FILL = "#FFFFFF";

export class GpuUploaderAdapter implements GpuUploader {
  palette: PaletteTexture;
  minimapPass: MinimapPass;
  private minimapAtlas: MinimapAtlas;
  residency: TileResidency;
  private paths: ReadonlyMap<string, string> = new Map();
  private readonly metrics: CodeTextMetrics;
  private readonly font: FontDefinition;
  private readonly gl: WebGL2RenderingContext;
  private readonly viewport: Viewport;
  private readonly widgetBackground: string;
  private readonly lineNumberColor: string;
  private readonly themeColors: readonly string[];
  private readonly jobPalette: readonly string[];
  private readonly table: WidgetTable;
  private readonly sourceFrame: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly windows = new Map<string, LineWindow>();
  private readonly minimaps = new Map<string, MinimapUpload>();
  private readonly restoredMinimapIds: string[] = [];
  private minimapFiles: readonly string[] = [];
  private restoredMinimapIndex = 0;
  private contextLost = false;
  private readonly rasterCellWriter = new RasterCellWriter();
  private readonly cellPlacement: CellPlacement = {
    x: 0,
    line: 0,
    colorIndex: 0,
  };
  private readonly contentPosition = { column: 0, size: 0, gutterWidth: 0 };
  private lineNumberLayout: LineNumberLayout | undefined;

  constructor(gl: WebGL2RenderingContext, config: GpuUploaderConfig) {
    this.gl = gl;
    this.viewport = config.viewport;
    this.table = config.table;
    this.metrics = config.metrics;
    this.font = config.font;
    this.widgetBackground = config.palette.background;
    this.lineNumberColor = config.palette.lineNumber;
    this.themeColors = config.palette.colors;
    this.jobPalette = this.buildJobPalette();
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

  setFilePaths(paths: ReadonlyMap<string, string>): void {
    this.paths = paths;
    for (const fileId of this.windows.keys()) {
      if (!paths.has(fileId)) this.windows.delete(fileId);
    }
    for (const fileId of this.minimaps.keys()) {
      if (!paths.has(fileId)) this.minimaps.delete(fileId);
    }
  }

  setMinimapFiles(fileIds: readonly string[]): void {
    this.minimapFiles = fileIds;
    if (this.contextLost) return;
    this.minimapAtlas.setFiles(fileIds);
  }

  uploadLineWindow(window: LineWindow): void {
    if (!this.residency.isRegistered(window.fileId)) return;
    this.windows.set(window.fileId, window);
    this.refreshContentSource(window);
  }

  get lineWindows(): ReadonlyMap<string, LineWindow> {
    return this.windows;
  }

  uploadMinimap(minimap: MinimapUpload): void {
    this.minimaps.set(minimap.fileId, minimap);
    if (this.contextLost) return;
    this.minimapAtlas.upload(minimap.fileId, minimap.bytes, minimap.height);
  }

  drainRestoredMinimaps(): number {
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

  setContextLost(lost: boolean): void {
    this.contextLost = lost;
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

  private refreshContentSource(window: LineWindow): void {
    const path = this.pathFor(window.fileId);
    if (!path) return;
    const frame = this.sourceFrame;
    this.table.readFrame(
      this.table.rowFor(window.fileId as WidgetId) ?? -1,
      frame,
    );
    const source = this.buildContentSource({
      fileId: window.fileId,
      filePath: path,
      hasText: true,
      contentVersion: window.contentVersion,
      highlighted: window.highlighted,
      contentWidth: frame.width,
      contentHeight: window.lineCount * this.metrics.lineHeight,
      cellsFor: (column, row, rasterScale) =>
        this.buildContentCells(window, column, row, rasterScale),
      headerCellsFor: (column, rasterScale) =>
        this.buildHeaderCells(path, column, rasterScale),
    });
    this.residency.setContentSource(window.fileId, source);
  }

  private pathFor(fileId: string): string | undefined {
    return this.paths.get(fileId);
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

  private titleSourceFor(fileId: string, path: string): TileContentSource {
    return this.buildContentSource({
      fileId,
      filePath: path,
      hasText: false,
      contentVersion: -1,
      highlighted: false,
      contentWidth: 0,
      contentHeight: 0,
      cellsFor: () => encodeRasterCells([]),
      headerCellsFor: (column, rasterScale) =>
        this.buildHeaderCells(path, column, rasterScale),
    });
  }

  private buildContentSource(
    input: Pick<
      TileContentSource,
      | "fileId"
      | "filePath"
      | "hasText"
      | "contentVersion"
      | "highlighted"
      | "contentWidth"
      | "contentHeight"
      | "cellsFor"
      | "headerCellsFor"
    >,
  ): TileContentSource {
    return {
      ...input,
      palette: this.jobPalette,
      baseline: this.metrics.baseline,
      lineHeight: this.metrics.lineHeight,
      backgroundColor: this.widgetBackground,
      headerBackgroundColor: WIDGET_HEADER_COLOR,
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
    return [DEFAULT_TEXT_COLOR, ...this.themeColors, this.lineNumberColor];
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
    const gutter = this.metrics.lineNumberGutter;
    const numberAreaWidth = gutter.numberAreaWidth(window.lineCount);
    this.contentPosition.gutterWidth = gutter.codeLeft(window.lineCount);
    for (let line = firstLine; line < lastLine; line += 1) {
      this.appendLineCells(window, line, this.contentPosition);
      if (column === 0) this.appendLineNumberCells(line, numberAreaWidth);
    }
    return this.rasterCellWriter.finish();
  }

  private appendLineCells(
    window: LineWindow,
    line: number,
    position: {
      readonly column: number;
      readonly size: number;
      readonly gutterWidth: number;
    },
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
        position.gutterWidth +
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

  private appendLineNumberCells(line: number, numberAreaWidth: number): void {
    const digits = this.getLineNumberLayout();
    const totalWidth = digits.width(line + 1);
    const startX = Math.max(0, numberAreaWidth - totalWidth);
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
}
