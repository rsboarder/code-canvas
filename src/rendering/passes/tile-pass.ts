import type { Camera } from "../../board/index";
import tileFragment from "../shaders/tile.frag.glsl?raw";
import tileVertex from "../shaders/tile.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { TilePool } from "../scene/tile-pool";
import type { WidgetTable } from "../scene/widget-table";
import type { Viewport } from "../viewport";

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const TILE_INSTANCE_FLOATS = 7;

export interface TileInstance {
  localX: number;
  localY: number;
  width: number;
  height: number;
  layer: number;
  uvMaxX: number;
  uvMaxY: number;
}

export interface TileDrawContext {
  camera: Camera;
  table: WidgetTable;
  viewport: Viewport;
  titleOnly: boolean;
  bodyVisible: boolean;
  snapToDevicePixel: boolean;
}

// Replaces the glyph pass (design D6 "Text Tiles", "Tile pass"): one
// instanced draw of tile quads sampling a `TEXTURE_2D_ARRAY`, clipped
// against the widget frame in the fragment shader — the same scheme the
// glyph pass used, just reading a tile layer instead of an atlas slot.
export class TilePass {
  private readonly program: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly titleVao: WebGLVertexArrayObject;
  private readonly bodyVao: WebGLVertexArrayObject;
  private readonly scratch: Float32Array;
  private instanceCount = 0;
  private titleCount = 0;
  private readonly resolution;
  private readonly devicePixelRatio;
  private readonly cameraOffset;
  private readonly cameraScale;
  private readonly widget;
  private readonly snapToDevicePixel;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly pool: TilePool,
    maxInstances: number,
  ) {
    this.scratch = new Float32Array(maxInstances * TILE_INSTANCE_FLOATS);
    this.program = createProgram(gl, "tile", tileVertex, tileFragment);
    this.quadBuffer = createBuffer(gl, QUAD, gl.STATIC_DRAW);
    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.scratch.byteLength, gl.DYNAMIC_DRAW);
    this.titleVao = gl.createVertexArray();
    this.bodyVao = gl.createVertexArray();
    this.resolution = gl.getUniformLocation(this.program, "resolution");
    this.cameraOffset = gl.getUniformLocation(this.program, "cameraOffset");
    this.cameraScale = gl.getUniformLocation(this.program, "cameraScale");
    this.widget = gl.getUniformLocation(this.program, "widget");
    this.snapToDevicePixel = gl.getUniformLocation(
      this.program,
      "snapToDevicePixel",
    );
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "tiles"), 0);
    this.devicePixelRatio = gl.getUniformLocation(
      this.program,
      "devicePixelRatio",
    );
  }

  // Called once per frame before pushing this tick's visible instances
  // (title/label instances first, then body content instances) — Text draws
  // both ranges, while Minimap selects the title range. The scratch buffer
  // is reused every frame, never reallocated (AGENTS.md "no allocations per
  // frame").
  beginFrame(): void {
    this.instanceCount = 0;
    this.titleCount = 0;
  }

  pushTileInstance(instance: TileInstance): void {
    if (this.instanceCount * TILE_INSTANCE_FLOATS >= this.scratch.length)
      return;
    const offset = this.instanceCount * TILE_INSTANCE_FLOATS;
    this.scratch[offset] = instance.localX;
    this.scratch[offset + 1] = instance.localY;
    this.scratch[offset + 2] = instance.width;
    this.scratch[offset + 3] = instance.height;
    this.scratch[offset + 4] = instance.layer;
    this.scratch[offset + 5] = instance.uvMaxX;
    this.scratch[offset + 6] = instance.uvMaxY;
    this.instanceCount += 1;
  }

  // Marks the boundary between title/label instances and body content so
  // Minimap detail can draw only the label overlay.
  markTitleBoundary(): void {
    this.titleCount = this.instanceCount;
  }

  endFrame(): void {
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferSubData(
      this.gl.ARRAY_BUFFER,
      0,
      this.scratch,
      0,
      this.instanceCount * TILE_INSTANCE_FLOATS,
    );
    this.configureVao(this.titleVao, 0);
    this.configureVao(this.bodyVao, 0);
    this.gl.bindVertexArray(null);
  }

  draw(context: TileDrawContext): void {
    const { camera, viewport, titleOnly, bodyVisible, snapToDevicePixel } =
      context;
    const drawTitleOnly = titleOnly || !bodyVisible;
    const count = drawTitleOnly ? this.titleCount : this.instanceCount;
    if (count === 0) return;
    const values = context.table.values;
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
    this.gl.uniform1f(this.snapToDevicePixel, snapToDevicePixel ? 1 : 0);
    this.pool.bind(0);
    this.gl.bindVertexArray(drawTitleOnly ? this.titleVao : this.bodyVao);
    this.gl.drawArraysInstanced(this.gl.TRIANGLE_STRIP, 0, 4, count);
    this.gl.bindVertexArray(null);
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
    for (let attribute = 1; attribute <= 7; attribute += 1) {
      this.gl.enableVertexAttribArray(attribute);
      this.gl.vertexAttribPointer(
        attribute,
        1,
        this.gl.FLOAT,
        false,
        TILE_INSTANCE_FLOATS * 4,
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
