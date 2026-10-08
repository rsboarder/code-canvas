import type {
  GpuUploader,
  LineWindow,
  MinimapUpload,
  ThemePalette,
} from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { MinimapPass } from "../passes/minimap-pass";
import type { CodeTextMetrics } from "../text/text-metrics";
import type { Viewport } from "../viewport";
import type { VisibleBodyProjection } from "../visible-body-projection";
import { WIDGET_HEADER_COLOR } from "../widget-colors";
import { PaletteTexture } from "./palette-texture";
import { TileResidency } from "./tile-residency";
import type { TileContentSource } from "./tile-kind-jobs";
import { TileContentSourceBuilder } from "./tile-content-source";
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
  readonly visibleBodies: VisibleBodyProjection;
}

// Text that has no token colour yet (D6 "Until tokens are available, the
// widget is drawn in a single color"); kept separate from the line-number
// colour so both survive a palette rebuild independently of token count.
const DEFAULT_TEXT_COLOR = "#D4D4D4";

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
  private readonly tileContentSourceBuilder: TileContentSourceBuilder;
  private readonly table: WidgetTable;
  private readonly visibleBodies: VisibleBodyProjection;
  private readonly sourceFrame: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly windows = new Map<string, LineWindow>();
  private readonly minimaps = new Map<string, MinimapUpload>();
  private readonly restoredMinimapIds: string[] = [];
  private minimapFiles: readonly string[] = [];
  private restoredMinimapIndex = 0;
  private contextLost = false;

  constructor(gl: WebGL2RenderingContext, config: GpuUploaderConfig) {
    this.gl = gl;
    this.viewport = config.viewport;
    this.table = config.table;
    this.visibleBodies = config.visibleBodies;
    this.metrics = config.metrics;
    this.font = config.font;
    this.widgetBackground = config.palette.background;
    this.lineNumberColor = config.palette.lineNumber;
    this.themeColors = config.palette.colors;
    this.jobPalette = this.buildJobPalette();
    this.tileContentSourceBuilder = new TileContentSourceBuilder({
      metrics: this.metrics,
      font: this.font,
      palette: this.jobPalette,
      lineNumberColorIndex: this.lineNumberColorIndex(),
      baseline: this.metrics.baseline,
      lineHeight: this.metrics.lineHeight,
      backgroundColor: this.widgetBackground,
      headerBackgroundColor: WIDGET_HEADER_COLOR,
    });
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
    this.palette = new PaletteTexture(this.gl);
    this.palette.update(this.themeColors);
    this.minimapAtlas = new MinimapAtlas(this.gl);
    this.minimapPass = new MinimapPass(this.gl, {
      palette: this.palette,
      atlas: this.minimapAtlas,
      tableTexture,
      font: this.font,
    });
    this.residency.restore(this.gl, tableTexture);
    this.minimapAtlas.setFiles(this.minimapFiles);
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
    const source = this.tileContentSourceBuilder.contentSourceFor({
      fileId: window.fileId,
      filePath: path,
      contentVersion: window.contentVersion,
      highlighted: window.highlighted,
      contentWidth: frame.width,
      contentHeight: window.lineCount * this.metrics.lineHeight,
      window,
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
      visibleBodies: this.visibleBodies,
      titleSourceFor: (fileId, path) => this.titleSourceFor(fileId, path),
      labelSourceFor: (path, frame, zoom) =>
        this.labelSourceFor(path, frame, zoom),
    });
  }

  private queueRestoredMinimaps(): void {
    this.restoredMinimapIds.length = 0;
    this.restoredMinimapIndex = 0;
    for (const fileId of this.minimaps.keys())
      this.restoredMinimapIds.push(fileId);
  }

  private titleSourceFor(fileId: string, path: string): TileContentSource {
    return this.tileContentSourceBuilder.titleSourceFor(fileId, path);
  }

  private labelSourceFor(path: string, frame: Rect, zoom: number) {
    return this.tileContentSourceBuilder.labelSourceFor(path, frame, zoom);
  }

  private buildJobPalette(): string[] {
    return [DEFAULT_TEXT_COLOR, ...this.themeColors, this.lineNumberColor];
  }

  private lineNumberColorIndex(): number {
    return 1 + this.themeColors.length;
  }
}
