import type { Camera } from "../../board/index";
import minimapFragment from "../shaders/minimap.frag.glsl?raw";
import minimapVertex from "../shaders/minimap.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { FontDefinition } from "../../shared/font";
import type { PaletteTexture } from "../scene/palette-texture";
import type { WidgetTable } from "../scene/widget-table";
import type { Viewport } from "../viewport";

const WIDTH = 256;
const HEIGHT = 512;
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

export class MinimapPass {
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly texture: WebGLTexture;
  private readonly resolution;
  private readonly devicePixelRatio;
  private readonly cameraOffset;
  private readonly cameraScale;
  private readonly widget;
  private readonly bodyTop;
  private readonly lineHeight;
  private readonly uploadedRows;
  private readonly bodyTopValue: number;
  private readonly lineHeightValue: number;
  private uploadedRowCount = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly palette: PaletteTexture,
    font: FontDefinition,
  ) {
    this.bodyTopValue = font.bodyTop;
    this.lineHeightValue = font.lineHeight;
    this.program = createProgram(gl, "minimap", minimapVertex, minimapFragment);
    this.buffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      WIDTH,
      HEIGHT,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      null,
    );
    this.resolution = gl.getUniformLocation(this.program, "resolution");
    this.devicePixelRatio = gl.getUniformLocation(
      this.program,
      "devicePixelRatio",
    );
    this.cameraOffset = gl.getUniformLocation(this.program, "cameraOffset");
    this.cameraScale = gl.getUniformLocation(this.program, "cameraScale");
    this.widget = gl.getUniformLocation(this.program, "widget");
    this.bodyTop = gl.getUniformLocation(this.program, "bodyTop");
    this.lineHeight = gl.getUniformLocation(this.program, "lineHeight");
    this.uploadedRows = gl.getUniformLocation(this.program, "uploadedRows");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "minimap"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "palette"), 1);
  }

  upload(bytes: Uint8Array, height: number): void {
    this.uploadedRowCount = Math.min(HEIGHT, Math.max(1, height));
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      WIDTH,
      Math.min(HEIGHT, height),
      this.gl.RED,
      this.gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  draw(camera: Camera, table: WidgetTable, viewport: Viewport): void {
    const values = table.values;
    this.gl.useProgram(this.program);
    this.gl.uniform2f(this.resolution, viewport.width, viewport.height);
    this.gl.uniform1f(this.devicePixelRatio, viewport.devicePixelRatio);
    this.gl.uniform2f(this.cameraOffset, camera.offsetX, camera.offsetY);
    this.gl.uniform1f(this.cameraScale, camera.scale);
    this.gl.uniform4f(
      this.widget,
      values[0] ?? 0,
      values[1] ?? 0,
      values[2] ?? 0,
      values[3] ?? 0,
    );
    this.gl.uniform1f(this.bodyTop, this.bodyTopValue);
    this.gl.uniform1f(this.lineHeight, this.lineHeightValue);
    this.gl.uniform1f(this.uploadedRows, this.uploadedRowCount);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.palette.texture);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.gl.bindVertexArray(null);
  }
}
