import type { Camera } from "../../board/index";
import glyphFragment from "../shaders/glyph.frag.glsl?raw";
import glyphVertex from "../shaders/glyph.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { FontDefinition } from "../../shared/font";
import type { GlyphAtlas } from "../text/glyph-atlas";
import type { PaletteTexture } from "../scene/palette-texture";
import type { WidgetTable } from "../scene/widget-table";
import type { Viewport } from "../viewport";

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const INSTANCE_STRIDE = 6;

export interface GlyphDrawContext {
  camera: Camera;
  table: WidgetTable;
  viewport: Viewport;
  titleOnly: boolean;
  bodyVisible: boolean;
}

export class GlyphPass {
  private readonly program: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly titleVao: WebGLVertexArrayObject;
  private readonly bodyVao: WebGLVertexArrayObject;
  private instanceCapacity = 0;
  private instanceCount = 0;
  private titleCount = 0;
  private readonly resolution;
  private readonly devicePixelRatio;
  private readonly cameraOffset;
  private readonly cameraScale;
  private readonly widget;
  private readonly bodyTop;
  private readonly lineHeight;
  private readonly contentScroll;
  private readonly bodyTopValue: number;
  private readonly lineHeightValue: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly atlas: GlyphAtlas,
    private readonly palette: PaletteTexture,
    font: FontDefinition,
  ) {
    this.bodyTopValue = font.bodyTop;
    this.lineHeightValue = font.lineHeight;
    this.program = createProgram(gl, "glyph", glyphVertex, glyphFragment);
    this.quadBuffer = createBuffer(gl, QUAD, gl.STATIC_DRAW);
    this.instanceBuffer = gl.createBuffer();
    this.titleVao = gl.createVertexArray();
    this.bodyVao = gl.createVertexArray();
    this.resolution = gl.getUniformLocation(this.program, "resolution");
    this.cameraOffset = gl.getUniformLocation(this.program, "cameraOffset");
    this.cameraScale = gl.getUniformLocation(this.program, "cameraScale");
    this.widget = gl.getUniformLocation(this.program, "widget");
    this.bodyTop = gl.getUniformLocation(this.program, "bodyTop");
    this.lineHeight = gl.getUniformLocation(this.program, "lineHeight");
    this.contentScroll = gl.getUniformLocation(this.program, "contentScroll");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "atlas"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "slotTable"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "palette"), 2);
    this.devicePixelRatio = gl.getUniformLocation(
      this.program,
      "devicePixelRatio",
    );
  }

  setInstances(data: Float32Array, titleCount: number): void {
    this.titleCount = titleCount;
    this.instanceCount = data.length / INSTANCE_STRIDE;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    if (data.length > this.instanceCapacity) {
      this.instanceCapacity = data.length;
      this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
    } else {
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, data);
    }
    this.configureVao(this.titleVao, 0);
    this.configureVao(
      this.bodyVao,
      this.titleCount * INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT,
    );
    this.gl.bindVertexArray(null);
  }

  draw(context: GlyphDrawContext): void {
    const { camera, table, viewport, titleOnly, bodyVisible } = context;
    const bodyCount = this.instanceCount - this.titleCount;
    const count = titleOnly ? this.titleCount : bodyVisible ? bodyCount : 0;
    if (count === 0) return;
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
    this.gl.uniform1f(this.contentScroll, values[4] ?? 0);
    this.bindTextureUnits();
    this.gl.bindVertexArray(titleOnly ? this.titleVao : this.bodyVao);
    this.gl.drawArraysInstanced(this.gl.TRIANGLE_STRIP, 0, 4, count);
    this.gl.bindVertexArray(null);
  }

  private bindTextureUnits(): void {
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.atlas.texture);
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.atlas.slotTableTexture);
    this.gl.activeTexture(this.gl.TEXTURE2);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.palette.texture);
  }

  private configureVao(
    vao: WebGLVertexArrayObject,
    instanceOffset: number,
  ): void {
    this.gl.bindVertexArray(vao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quadBuffer);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let attribute = 1; attribute <= 5; attribute += 1) {
      this.gl.enableVertexAttribArray(attribute);
      this.gl.vertexAttribPointer(
        attribute,
        1,
        this.gl.FLOAT,
        false,
        INSTANCE_STRIDE * 4,
        instanceOffset + (attribute - 1) * 4,
      );
      this.gl.vertexAttribDivisor(attribute, 1);
    }
  }
}

function createBuffer(
  gl: WebGL2RenderingContext,
  data: Float32Array,
  usage: number,
): WebGLBuffer {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  return buffer;
}
