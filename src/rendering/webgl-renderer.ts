import * as twgl from "twgl.js";

import { Camera, type CameraView, type DetailLevelName } from "../board/index";
import type {
  GpuUploader,
  LineRange,
  LineWindow,
  MinimapUpload,
  ThemePalette,
} from "../code-view/index";
import type { FontDefinition } from "../shared/font";
import type { GesturePhase } from "../shared/frame";
import type { Rect } from "../shared/geometry/geometry";
import { CANVAS_CLEAR_COLOR } from "./clear-color";
import { BackgroundPass } from "./passes/background-pass";
import type { TileDrawContext } from "./passes/tile-pass";
import type { FrameDrawMetrics } from "./scene/frame-draw-metrics";
import { GpuUploaderAdapter } from "./scene/gpu-uploader";
import { WidgetTableTexture } from "./scene/widget-table-texture";
import { MAX_WIDGET_ROWS, WidgetTable } from "./scene/widget-table";
import type { WidgetId, WidgetTableBoard } from "./scene/widget-table";
import type {
  TileDebugSnapshot,
  TileDemand,
  TileResidency,
} from "./scene/tile-residency";
import type { RenderingProbeSource } from "./probe";
import {
  bodyViewWindow,
  type BodyViewWindowInput,
  type ViewWindow,
} from "./scene/tile-view-window";
import {
  type MutableLineRange,
  visibleLineRange,
} from "./scene/visible-line-ranges";
import type { CodeTextMetrics } from "./text/text-metrics";
import type { Viewport } from "./viewport";

export class WebGlRenderer implements GpuUploader {
  private readonly gl: WebGL2RenderingContext;
  private readonly table: WidgetTable;
  private tableTexture: WidgetTableTexture;
  private background: BackgroundPass;
  private readonly uploader: GpuUploaderAdapter;
  private readonly probe: RenderingProbeSource;
  private readonly tileDraw: TileDrawContext;
  private readonly viewport: Viewport = {
    width: 0,
    height: 0,
    devicePixelRatio: 1,
  };
  private readonly bodyTopCss: number;
  private readonly lineHeight: number;
  private readonly backgroundColor: string;
  private readonly visibleRanges = new Map<string, readonly LineRange[]>();
  private readonly previousRowIds: (WidgetId | undefined)[] = [];
  private readonly rangesByRow: (MutableLineRange | undefined)[] = [];
  private readonly rangeListsByRow: (readonly LineRange[] | undefined)[] = [];
  private readonly cullFrame: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly cullWindow: ViewWindow = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  private readonly cullInput: BodyViewWindowInput = {
    camera: new Camera(),
    viewport: this.viewport,
    frame: this.cullFrame,
    bodyTop: 0,
    contentScroll: 0,
  };
  private previousRowCount = 0;
  private detail: DetailLevelName = "text";
  private textWanted = false;
  private gestureInProgress = false;
  private contextLost = false;
  private redrawCallback: (() => void) | undefined;
  private hiddenBodyId: string | undefined;
  private priorityFileId: string | undefined;
  private gesturePhase: GesturePhase | undefined;
  private lastMetrics: FrameDrawMetrics = {
    tileMemoryBytes: 0,
    missingTile: false,
    visibleWidgetCount: 0,
    drawnTileCount: 0,
    drawnLabelTileCount: 0,
    drawnMinimapCount: 0,
    drawnFallbackTileCount: 0,
    drawnUnhighlightedTileCount: 0,
    lowestEpochDrawn: -1,
    lowestContentVersion: -1,
    timeToSharpMs: Number.NaN,
  };

  constructor(
    canvas: HTMLCanvasElement,
    metrics: CodeTextMetrics,
    font: FontDefinition,
    palette: ThemePalette,
  ) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is required for the canvas renderer");
    this.gl = gl;
    this.table = new WidgetTable();
    this.tableTexture = new WidgetTableTexture(gl);
    this.backgroundColor = palette.background;
    this.bodyTopCss = font.bodyTop;
    this.lineHeight = font.lineHeight;
    for (let row = 0; row < MAX_WIDGET_ROWS; row += 1) {
      const range: MutableLineRange = { start: 0, end: 0 };
      this.rangesByRow[row] = range;
      this.rangeListsByRow[row] = [range];
    }
    this.background = new BackgroundPass(
      gl,
      palette.background,
      this.tableTexture.texture,
      this.bodyTopCss,
    );
    this.uploader = new GpuUploaderAdapter(gl, {
      metrics,
      font,
      palette,
      viewport: this.cssViewport(canvas),
      table: this.table,
      tableTexture: this.tableTexture.texture,
    });
    this.probe = {
      lineWindows: this.uploader.lineWindows,
      baseline: metrics.baseline,
      tileDebug: (fileId) => this.debugSnapshot(fileId),
    };
    this.tileDraw = {
      camera: new Camera(),
      viewport: { width: 0, height: 0, devicePixelRatio: 1 },
      titleOnly: false,
      snapToDevicePixel: true,
      bodyTop: this.bodyTopCss,
    };
    this.configureContextState();
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.uploader.setContextLost(true);
    });
    canvas.addEventListener("webglcontextrestored", () => {
      if (this.gl.isContextLost()) return;
      this.restoreContext();
    });
  }

  setFilePaths(paths: ReadonlyMap<string, string>): void {
    this.uploader.setFilePaths(paths);
    this.residency.setFilePaths(paths);
  }

  setMinimapFiles(fileIds: readonly string[]): void {
    this.uploader.setMinimapFiles(fileIds);
  }

  syncWidgetTable(board: WidgetTableBoard): void {
    this.table.sync(board);
    if (this.contextLost) return;
    this.tableTexture.upload(this.table);
  }

  setDetailLevel(detail: DetailLevelName, textWanted: boolean): void {
    this.detail = detail;
    this.textWanted = textWanted;
    this.residency.setDetailLevel(detail === "minimap", textWanted);
  }

  cull(camera: CameraView): ReadonlyMap<string, readonly LineRange[]> {
    const textActive = this.detail !== "minimap" || this.textWanted;
    const rowCount = this.table.rowCount;
    this.removeRowsBeyond(rowCount);
    if (!textActive && this.visibleRanges.size > 0) this.visibleRanges.clear();
    this.cullInput.camera = camera;
    this.cullInput.bodyTop = this.bodyTopCss;
    this.cssViewport(this.gl.canvas as HTMLCanvasElement);
    for (let row = 0; row < rowCount; row += 1) this.cullRow(row, textActive);
    this.previousRowCount = rowCount;
    return this.visibleRanges;
  }

  private cullRow(row: number, textActive: boolean): void {
    const id = this.table.widgetIdAt(row);
    const previousId = this.previousRowIds[row];
    const idChanged = previousId !== id;
    if (idChanged) {
      if (
        previousId !== undefined &&
        this.table.rowFor(previousId) === undefined
      )
        this.removeVisible(previousId);
      this.previousRowIds[row] = id;
    }
    if (id === undefined || !textActive) return;
    if (!this.table.readFrame(row, this.cullFrame)) return;
    this.cullInput.contentScroll = this.table.contentScrollAt(row);
    if (!bodyViewWindow(this.cullInput, this.cullWindow)) {
      this.removeVisible(id);
      return;
    }
    const range = this.rangesByRow[row];
    const ranges = this.rangeListsByRow[row];
    if (!range || !ranges) return;
    visibleLineRange(this.cullWindow, this.lineHeight, range);
    if (idChanged || !this.visibleRanges.has(id))
      this.visibleRanges.set(id, ranges);
  }

  textReady(): boolean {
    return this.residency.textReady();
  }

  setHiddenBody(fileId: string | undefined): void {
    this.hiddenBodyId = fileId;
    this.residency.setHiddenBody(fileId);
  }

  uploadLineWindow(window: LineWindow): void {
    this.uploader.uploadLineWindow(window);
  }

  uploadMinimap(minimap: MinimapUpload): void {
    this.uploader.uploadMinimap(minimap);
  }

  rasterError(): string | undefined {
    return this.residency.rasterError();
  }

  settled(): boolean {
    return !this.contextLost && this.residency.settled();
  }

  // A raster result arrives asynchronously, outside any FrameLoop tick
  // (design D8): this schedules the tick that drains and draws it, so the
  // loop never goes idle with resident work still waiting.
  onNeedsRedraw(callback: () => void): void {
    this.redrawCallback = callback;
    this.residency.onNeedsRedraw(callback);
  }

  debugSnapshot(fileId?: string): TileDebugSnapshot {
    return this.residency.debugSnapshot(fileId);
  }

  tileDemand(out: TileDemand): void {
    this.residency.tileDemand(out);
  }

  exitViewCovered(widgetId: string, contentVersion: number): boolean {
    return this.residency.exitViewCovered(widgetId, contentVersion);
  }

  frameMetrics(): FrameDrawMetrics {
    return this.lastMetrics;
  }

  setPriorityFile(fileId: string | undefined): void {
    this.priorityFileId = fileId;
    this.residency.setPriorityFile(fileId);
  }

  setGesturePhase(phase: GesturePhase): void {
    this.gesturePhase = phase;
    this.gestureInProgress = phase.gestureInProgress;
    this.residency.setGesturePhase(phase);
  }

  // Posts raster jobs and uploads tiles that came back (design D7
  // "GpuUploader"): called from the same per-frame budgeted slot as
  // `DocumentResidency.drain`, never from a worker's message handler.
  drainTiles(camera: CameraView, budgetMs: number): number {
    const deadline = performance.now() + budgetMs;
    if (this.contextLost) return 0;
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const uploadedTiles = this.residency.drainTiles(
      camera,
      this.cssViewport(canvas),
      this.bodyTopCss,
      deadline,
    );
    return uploadedTiles + this.uploader.drainRestoredMinimaps();
  }

  draw(camera: CameraView): FrameDrawMetrics {
    if (this.contextLost) return this.lastMetrics;
    const devicePixelRatio = window.devicePixelRatio || 1;
    twgl.resizeCanvasToDisplaySize(
      this.gl.canvas as HTMLCanvasElement,
      devicePixelRatio,
    );
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
    this.tileDraw.camera = camera;
    this.tileDraw.viewport.width = this.gl.canvas.width;
    this.tileDraw.viewport.height = this.gl.canvas.height;
    this.tileDraw.viewport.devicePixelRatio = devicePixelRatio;
    this.tileDraw.snapToDevicePixel = !this.gestureInProgress;
    this.gl.clearColor(
      CANVAS_CLEAR_COLOR.red,
      CANVAS_CLEAR_COLOR.green,
      CANVAS_CLEAR_COLOR.blue,
      CANVAS_CLEAR_COLOR.alpha,
    );
    this.gl.depthMask(true);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.depthFunc(this.gl.LESS);
    this.background.draw(
      camera,
      this.table,
      this.tileDraw.viewport,
      this.detail === "text" ? 0 : 1,
    );
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.depthFunc(this.gl.LEQUAL);
    this.gl.depthMask(false);
    const metrics = this.residency.buildFrameInstances(
      this.detail === "minimap",
    );
    this.lastMetrics = metrics;
    this.drawContent();
    return metrics;
  }

  private drawContent(): void {
    if (this.detail === "minimap") {
      this.lastMetrics.drawnMinimapCount = this.uploader.minimapPass.draw(
        this.tileDraw.camera,
        this.table,
        this.tileDraw.viewport,
      );
      this.tileDraw.titleOnly = true;
      this.residency.draw(this.tileDraw);
      return;
    }
    this.lastMetrics.drawnMinimapCount = 0;
    this.tileDraw.titleOnly = false;
    this.residency.draw(this.tileDraw);
  }

  private configureContextState(): void {
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.depthFunc(this.gl.LESS);
  }

  private restoreContext(): void {
    this.tableTexture = new WidgetTableTexture(this.gl);
    this.tableTexture.uploadAll(this.table);
    this.background = new BackgroundPass(
      this.gl,
      this.backgroundColor,
      this.tableTexture.texture,
      this.bodyTopCss,
    );
    this.uploader.restore(this.tableTexture.texture);
    this.residency.setDetailLevel(this.detail === "minimap", this.textWanted);
    this.residency.setHiddenBody(this.hiddenBodyId);
    this.residency.setPriorityFile(this.priorityFileId);
    if (this.gesturePhase) this.residency.setGesturePhase(this.gesturePhase);
    if (this.redrawCallback) this.residency.onNeedsRedraw(this.redrawCallback);
    this.configureContextState();
    this.contextLost = false;
    this.uploader.setContextLost(false);
    this.redrawCallback?.();
  }

  probeSource(): RenderingProbeSource {
    return this.probe;
  }

  private get residency(): TileResidency {
    return this.uploader.residency;
  }

  private cssViewport(canvas: HTMLCanvasElement): Viewport {
    this.viewport.width = canvas.clientWidth || window.innerWidth;
    this.viewport.height = canvas.clientHeight || window.innerHeight;
    this.viewport.devicePixelRatio = window.devicePixelRatio || 1;
    return this.viewport;
  }

  private removeRowsBeyond(rowCount: number): void {
    for (let row = rowCount; row < this.previousRowCount; row += 1) {
      const id = this.previousRowIds[row];
      if (id !== undefined) this.removeVisible(id);
      this.previousRowIds[row] = undefined;
    }
  }

  private removeVisible(id: string): void {
    if (this.visibleRanges.has(id)) this.visibleRanges.delete(id);
  }
}
