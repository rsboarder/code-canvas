import type { CameraView } from "../../board/index";
import minimapFragment from "../shaders/minimap.frag.glsl?raw";
import minimapVertex from "../shaders/minimap.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { FontDefinition } from "../../shared/font";
import {
  MAX_WIDGET_ROWS,
  type WidgetId,
  type WidgetTable,
} from "../scene/widget-table";
import type { MinimapAtlas } from "../scene/minimap-atlas";
import type { PaletteTexture } from "../scene/palette-texture";
import type { Viewport } from "../viewport";

const INSTANCE_FLOATS = 3;
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

interface MinimapPassConfig {
  readonly palette: PaletteTexture;
  readonly atlas: MinimapAtlas;
  readonly tableTexture: WebGLTexture;
  readonly font: FontDefinition;
}

export class MinimapPass {
  private readonly program: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly scratch: Float32Array;
  private readonly resolution;
  private readonly devicePixelRatio;
  private readonly cameraOffset;
  private readonly cameraScale;
  private readonly bodyTop;
  private readonly lineHeight;
  private readonly bodyTopValue: number;
  private readonly lineHeightValue: number;
  private readonly atlas: MinimapAtlas;
  private readonly palette: PaletteTexture;
  private readonly tableTexture: WebGLTexture;
  private instanceCount = 0;
  private lastAtlasGeneration = -1;
  private lastRowsVersion = -1;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    config: MinimapPassConfig,
  ) {
    this.atlas = config.atlas;
    this.palette = config.palette;
    this.tableTexture = config.tableTexture;
    this.bodyTopValue = config.font.bodyTop;
    this.lineHeightValue = config.font.lineHeight;
    this.scratch = new Float32Array(MAX_WIDGET_ROWS * INSTANCE_FLOATS);
    this.program = createProgram(gl, "minimap", minimapVertex, minimapFragment);
    this.quadBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.scratch.byteLength, gl.DYNAMIC_DRAW);
    for (let attribute = 1; attribute <= INSTANCE_FLOATS; attribute += 1) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(
        attribute,
        1,
        gl.FLOAT,
        false,
        INSTANCE_FLOATS * 4,
        (attribute - 1) * 4,
      );
      gl.vertexAttribDivisor(attribute, 1);
    }
    gl.bindVertexArray(null);
    this.resolution = gl.getUniformLocation(this.program, "resolution");
    this.devicePixelRatio = gl.getUniformLocation(
      this.program,
      "devicePixelRatio",
    );
    this.cameraOffset = gl.getUniformLocation(this.program, "cameraOffset");
    this.cameraScale = gl.getUniformLocation(this.program, "cameraScale");
    this.bodyTop = gl.getUniformLocation(this.program, "bodyTop");
    this.lineHeight = gl.getUniformLocation(this.program, "lineHeight");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "minimap"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "palette"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "widgetTable"), 2);
  }

  draw(camera: CameraView, table: WidgetTable, viewport: Viewport): number {
    if (
      this.lastAtlasGeneration !== this.atlas.generation ||
      this.lastRowsVersion !== table.rowsVersion
    ) {
      this.rebuildInstances(table);
      this.lastAtlasGeneration = this.atlas.generation;
      this.lastRowsVersion = table.rowsVersion;
    }
    if (this.instanceCount === 0) return 0;
    const texture = this.atlas.texture;
    if (texture === undefined) return 0;
    this.gl.useProgram(this.program);
    this.gl.uniform2f(this.resolution, viewport.width, viewport.height);
    this.gl.uniform1f(this.devicePixelRatio, viewport.devicePixelRatio);
    this.gl.uniform2f(this.cameraOffset, camera.offsetX, camera.offsetY);
    this.gl.uniform1f(this.cameraScale, camera.scale);
    this.gl.uniform1f(this.bodyTop, this.bodyTopValue);
    this.gl.uniform1f(this.lineHeight, this.lineHeightValue);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, texture);
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.palette.texture);
    this.gl.activeTexture(this.gl.TEXTURE2);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tableTexture);
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArraysInstanced(
      this.gl.TRIANGLE_STRIP,
      0,
      4,
      this.instanceCount,
    );
    this.gl.bindVertexArray(null);
    return this.instanceCount;
  }

  private rebuildInstances(table: WidgetTable): void {
    this.instanceCount = 0;
    for (let index = 0; index < this.atlas.assignedCount; index += 1) {
      const rows = this.atlas.rowsAt(index);
      if (rows === 0 || this.instanceCount >= MAX_WIDGET_ROWS) continue;
      const fileId = this.atlas.fileIdAt(index);
      if (fileId === undefined) continue;
      const row = table.rowFor(fileId as WidgetId);
      if (row === undefined) continue;
      const offset = this.instanceCount * INSTANCE_FLOATS;
      this.scratch[offset] = row;
      this.scratch[offset + 1] = this.atlas.layerAt(index);
      this.scratch[offset + 2] = rows;
      this.instanceCount += 1;
    }
    if (this.instanceCount === 0) return;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferSubData(
      this.gl.ARRAY_BUFFER,
      0,
      this.scratch,
      0,
      this.instanceCount * INSTANCE_FLOATS,
    );
  }
}
