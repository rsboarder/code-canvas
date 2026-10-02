import * as twgl from "twgl.js";

import { Camera, type DetailLevelName } from "../board/index";
import type {
  FallbackDocument,
  GpuUploader,
  TokenizedLines,
} from "../code-view/index";
import type { FontDefinition } from "../shared/font";
import type { Rect } from "../shared/geometry/geometry";
import { BackgroundPass } from "./passes/background-pass";
import type { TileDrawContext } from "./passes/tile-pass";
import type { FrameDrawMetrics } from "./scene/frame-draw-metrics";
import { GpuUploaderAdapter } from "./scene/gpu-uploader";
import type { TileDebugSnapshot } from "./scene/tile-residency";
import type { CodeTextMetrics, TextMetricsProbe } from "./text/text-metrics";
import type { Viewport } from "./viewport";

export class WebGlRenderer implements GpuUploader {
  private readonly gl: WebGL2RenderingContext;
  private readonly background: BackgroundPass;
  private readonly uploader: GpuUploaderAdapter;
  private readonly tileDraw: TileDrawContext;
  private readonly viewport: Viewport = {
    width: 0,
    height: 0,
    devicePixelRatio: 1,
  };
  private readonly bodyTopCss: number;
  private detail: DetailLevelName = "text";
  private bodyVisible = true;
  private gestureInProgress = false;
  private lastMetrics: FrameDrawMetrics = {
    tileMemoryBytes: 0,
    missingTile: false,
    drawnTileCount: 0,
    drawnLabelTileCount: 0,
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
    widgetBackground: string,
  ) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is required for the canvas renderer");
    this.gl = gl;
    this.bodyTopCss = font.bodyTop;
    this.background = new BackgroundPass(gl, widgetBackground);
    this.uploader = new GpuUploaderAdapter(gl, {
      metrics,
      font,
      widgetBackground,
      viewport: this.cssViewport(canvas),
    });
    this.tileDraw = {
      camera: new Camera(),
      table: this.uploader.table,
      viewport: { width: 0, height: 0, devicePixelRatio: 1 },
      titleOnly: false,
      bodyVisible: true,
      snapToDevicePixel: true,
    };
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setDocument(fileId: string, path: string, text: string, frame: Rect): void {
    this.uploader.setDocument(fileId, path, text, frame);
  }

  getTextMetricsProbe(): TextMetricsProbe {
    return this.uploader.getTextMetricsProbe();
  }

  setVisibleRange(start: number, end: number): void {
    this.uploader.setVisibleRange(start, end);
  }

  setDetailLevel(detail: DetailLevelName, textWanted: boolean): void {
    this.detail = detail;
    this.uploader.setDetailLevel(detail === "minimap", textWanted);
  }

  beginTextPrefetch(thresholdZoom: number): void {
    this.uploader.beginTextPrefetch(thresholdZoom);
  }

  textReady(): boolean {
    return this.uploader.textReady();
  }

  setWidgetVisible(visible: boolean): void {
    this.bodyVisible = visible;
  }

  uploadFallback(document: FallbackDocument): void {
    this.uploader.uploadFallback(document);
  }

  uploadTokens(document: TokenizedLines): void {
    this.uploader.uploadTokens(document);
  }

  rasterError(): string | undefined {
    return this.uploader.rasterError();
  }

  // A raster result arrives asynchronously, outside any FrameLoop tick
  // (design D8): this schedules the tick that drains and draws it, so the
  // loop never goes idle with resident work still waiting.
  onNeedsRedraw(callback: () => void): void {
    this.uploader.onNeedsRedraw(callback);
  }

  debugSnapshot(): TileDebugSnapshot {
    return this.uploader.debugSnapshot();
  }

  tilesCurrentFor(widgetId: string, contentVersion: number): boolean {
    return this.uploader.tilesCurrentFor(widgetId, contentVersion);
  }

  frameMetrics(): FrameDrawMetrics {
    return this.lastMetrics;
  }

  setGestureInProgress(inProgress: boolean): void {
    this.gestureInProgress = inProgress;
  }

  setZoomGestureActive(active: boolean): void {
    this.uploader.setZoomGestureActive(active);
  }

  setZoomFocus(x: number, y: number, zoomOut: boolean): void {
    this.uploader.setZoomFocus(x, y, zoomOut);
  }

  notifyGestureEnded(wasZoom: boolean, cameraScale: number): void {
    this.uploader.notifyGestureEnded(wasZoom, cameraScale);
  }

  // Posts raster jobs and uploads tiles that came back (design D7
  // "GpuUploader"): called from the same per-frame budgeted slot as
  // `DocumentResidency.drain`, never from a worker's message handler.
  drainTiles(camera: Camera): number {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    return this.uploader.drainTiles(
      camera,
      this.cssViewport(canvas),
      this.bodyTopCss,
    );
  }

  draw(camera: Camera): FrameDrawMetrics {
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
    this.tileDraw.bodyVisible = this.bodyVisible;
    this.tileDraw.snapToDevicePixel = !this.gestureInProgress;
    this.gl.clearColor(0.055, 0.07, 0.11, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.background.draw(camera, this.uploader.table, this.tileDraw.viewport);
    const metrics = this.uploader.buildFrameInstances(
      this.detail === "minimap",
    );
    if (!this.bodyVisible) {
      metrics.drawnTileCount = 0;
      metrics.drawnFallbackTileCount = 0;
      metrics.drawnUnhighlightedTileCount = 0;
      metrics.lowestEpochDrawn = -1;
      metrics.lowestContentVersion = -1;
    }
    this.lastMetrics = metrics;
    this.drawContent();
    return metrics;
  }

  private drawContent(): void {
    if (this.detail === "minimap") {
      this.uploader.minimapPass.draw(
        this.tileDraw.camera,
        this.uploader.table,
        this.tileDraw.viewport,
      );
      this.tileDraw.titleOnly = true;
      this.uploader.drawTiles(this.tileDraw);
      return;
    }
    this.tileDraw.titleOnly = false;
    this.uploader.drawTiles(this.tileDraw);
  }

  private cssViewport(canvas: HTMLCanvasElement): Viewport {
    this.viewport.width = canvas.clientWidth || window.innerWidth;
    this.viewport.height = canvas.clientHeight || window.innerHeight;
    this.viewport.devicePixelRatio = window.devicePixelRatio || 1;
    return this.viewport;
  }
}
