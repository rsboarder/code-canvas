import type { CameraView } from "../../board/index";
import tileFragment from "../shaders/tile.frag.glsl?raw";
import tileVertex from "../shaders/tile.vert.glsl?raw";
import { createProgram } from "../gl/program";
import type { TilePool } from "../scene/tile-pool";
import type { Viewport } from "../viewport";
import { WIDGET_SCROLL_GUTTER_WIDTH } from "../widget-colors";

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const TILE_INSTANCE_FLOATS = 10;

export interface TileInstance {
  localX: number;
  localY: number;
  width: number;
  height: number;
  uvMaxX: number;
  uvMaxY: number;
  widgetRow: number;
  region: number;
  uvOffsetX: number;
  uvOffsetY: number;
}

export interface TileDrawContext {
  camera: CameraView;
  viewport: Viewport;
  titleOnly: boolean;
  snapToDevicePixel: boolean;
  bodyTop: number;
}

// Replaces the glyph pass (design D6 "Text Tiles", "Tile pass"): one
// instanced draw of tile quads sampling a `TEXTURE_2D` atlas, clipped
// against the widget frame in the fragment shader — the same scheme the
// glyph pass used, just reading a tile atlas slot.
export class TilePass {
  private readonly program: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly titleVao: WebGLVertexArrayObject;
  private readonly bodyVao: WebGLVertexArrayObject;
  private scratch: Float32Array;
  private instanceCount = 0;
  private titleCount = 0;
  private readonly resolution;
  private readonly devicePixelRatio;
  private readonly cameraOffset;
  private readonly cameraScale;
  private readonly widgetTable;
  private readonly snapToDevicePixel;
  private readonly bodyTop;
  private readonly gutterWidth;
  private readonly slotUvScale;
  private readonly halfTexel;
  private readonly tableTexture: WebGLTexture;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly pool: TilePool,
    tableTexture: WebGLTexture,
    maxInstances: number,
  ) {
    this.tableTexture = tableTexture;
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
    this.widgetTable = gl.getUniformLocation(this.program, "widgetTable");
    this.snapToDevicePixel = gl.getUniformLocation(
      this.program,
      "snapToDevicePixel",
    );
    this.bodyTop = gl.getUniformLocation(this.program, "bodyTop");
    this.gutterWidth = gl.getUniformLocation(this.program, "gutterWidth");
    this.slotUvScale = gl.getUniformLocation(this.program, "slotUvScale");
    this.halfTexel = gl.getUniformLocation(this.program, "halfTexel");
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "tiles"), 0);
    gl.uniform1i(this.widgetTable, 1);
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

  ensureInstanceCapacity(maxInstances: number): void {
    if (maxInstances * TILE_INSTANCE_FLOATS <= this.scratch.length) return;
    this.scratch = new Float32Array(maxInstances * TILE_INSTANCE_FLOATS);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.instanceBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      this.scratch.byteLength,
      this.gl.DYNAMIC_DRAW,
    );
  }

  pushTileInstance(instance: TileInstance): void {
    if (this.instanceCount * TILE_INSTANCE_FLOATS >= this.scratch.length)
      return;
    const offset = this.instanceCount * TILE_INSTANCE_FLOATS;
    this.scratch[offset] = instance.localX;
    this.scratch[offset + 1] = instance.localY;
    this.scratch[offset + 2] = instance.width;
    this.scratch[offset + 3] = instance.height;
    this.scratch[offset + 4] = instance.uvMaxX;
    this.scratch[offset + 5] = instance.uvMaxY;
    this.scratch[offset + 6] = instance.widgetRow;
    this.scratch[offset + 7] = instance.region;
    this.scratch[offset + 8] = instance.uvOffsetX;
    this.scratch[offset + 9] = instance.uvOffsetY;
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
    const { camera, viewport, titleOnly, snapToDevicePixel, bodyTop } = context;
    const drawTitleOnly = titleOnly;
    const count = drawTitleOnly ? this.titleCount : this.instanceCount;
    if (count === 0) return;
    this.gl.useProgram(this.program);
    this.gl.uniform2f(this.resolution, viewport.width, viewport.height);
    this.gl.uniform1f(this.devicePixelRatio, viewport.devicePixelRatio);
    this.gl.uniform2f(this.cameraOffset, camera.offsetX, camera.offsetY);
    this.gl.uniform1f(this.cameraScale, camera.scale);
    this.gl.uniform1f(this.snapToDevicePixel, snapToDevicePixel ? 1 : 0);
    this.gl.uniform1f(this.bodyTop, bodyTop);
    this.gl.uniform1f(this.gutterWidth, WIDGET_SCROLL_GUTTER_WIDTH);
    this.gl.uniform2f(
      this.slotUvScale,
      this.pool.slotUvScaleX,
      this.pool.slotUvScaleY,
    );
    this.gl.uniform2f(
      this.halfTexel,
      0.5 / this.pool.atlasWidth,
      0.5 / this.pool.atlasHeight,
    );
    this.pool.bind(0);
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tableTexture);
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
    for (let attribute = 1; attribute <= 10; attribute += 1) {
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
