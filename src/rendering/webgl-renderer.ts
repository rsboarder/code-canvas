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
import type { GlyphDrawContext } from "./passes/glyph-pass";
import { GpuUploaderAdapter } from "./scene/gpu-uploader";
import type { CodeTextMetrics, TextMetricsProbe } from "./text/text-metrics";

export class WebGlRenderer implements GpuUploader {
  private readonly gl: WebGL2RenderingContext;
  private readonly background: BackgroundPass;
  private readonly uploader: GpuUploaderAdapter;
  private readonly glyphDraw: GlyphDrawContext;
  private detail: DetailLevelName = "text";
  private bodyVisible = true;

  constructor(
    canvas: HTMLCanvasElement,
    metrics: CodeTextMetrics,
    font: FontDefinition,
    widgetBackground: string,
  ) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is required for the canvas renderer");
    this.gl = gl;
    this.background = new BackgroundPass(gl, widgetBackground);
    this.uploader = new GpuUploaderAdapter(gl, metrics, font);
    this.glyphDraw = {
      camera: new Camera(),
      table: this.uploader.table,
      viewport: { width: 0, height: 0, devicePixelRatio: 1 },
      titleOnly: false,
      bodyVisible: true,
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

  setDetailLevel(detail: DetailLevelName): void {
    this.detail = detail;
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

  draw(camera: Camera): void {
    const devicePixelRatio = window.devicePixelRatio || 1;
    twgl.resizeCanvasToDisplaySize(
      this.gl.canvas as HTMLCanvasElement,
      devicePixelRatio,
    );
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
    this.glyphDraw.camera = camera;
    this.glyphDraw.viewport.width = this.gl.canvas.width;
    this.glyphDraw.viewport.height = this.gl.canvas.height;
    this.glyphDraw.viewport.devicePixelRatio = devicePixelRatio;
    this.glyphDraw.bodyVisible = this.bodyVisible;
    this.gl.clearColor(0.055, 0.07, 0.11, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.background.draw(camera, this.uploader.table, this.glyphDraw.viewport);
    if (this.detail === "minimap") {
      this.uploader.minimapPass.draw(
        camera,
        this.uploader.table,
        this.glyphDraw.viewport,
      );
      this.glyphDraw.titleOnly = true;
      this.uploader.glyphPass.draw(this.glyphDraw);
      return;
    }
    this.glyphDraw.titleOnly = false;
    this.uploader.glyphPass.draw(this.glyphDraw);
  }
}
