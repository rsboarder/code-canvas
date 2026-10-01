import {
  SLOT_TABLE_COMPONENTS,
  SLOT_TABLE_HEIGHT,
  SLOT_TABLE_ROWS,
  SLOT_TABLE_WIDTH,
  packSlotRecord,
  slotTableOffset,
  type RasterRect,
  type SlotRecord,
} from "./slot-table";
import type { FontDefinition } from "../../shared/font";
import type { CodeTextMetrics } from "./text-metrics";

interface GlyphSlot extends SlotRecord {
  readonly index: number;
  readonly cluster: string;
}

const COLUMNS = 16;
const BASE_RASTER_PADDING = 2;
const MAX_SLOTS = Math.min(SLOT_TABLE_WIDTH, COLUMNS * COLUMNS);

export class GlyphAtlas {
  readonly texture: WebGLTexture;
  readonly slotTableTexture: WebGLTexture;
  readonly size: number;
  private readonly slots = new Map<string, GlyphSlot>();
  private readonly slotData = new Float32Array(
    SLOT_TABLE_WIDTH * SLOT_TABLE_HEIGHT * SLOT_TABLE_COMPONENTS,
  );
  private readonly baseCellSize: number;
  private readonly baseRasterHeight: number;
  private readonly rasterPadding: number;
  private readonly cellSize: number;
  private readonly atlasSize: number;
  private readonly rasterScale: number;
  private readonly font: FontDefinition;
  private readonly rasterCanvas: OffscreenCanvas;
  private readonly rasterContext: OffscreenCanvasRenderingContext2D | null;
  private nextIndex = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    font: FontDefinition,
    private readonly metrics: CodeTextMetrics,
  ) {
    this.font = font;
    this.rasterScale = font.rasterScale > 0 ? font.rasterScale : 1;
    this.baseCellSize = Math.ceil(font.size * 2);
    this.baseRasterHeight = Math.ceil(font.size * 1.25);
    this.rasterPadding = Math.ceil(BASE_RASTER_PADDING * this.rasterScale);
    this.cellSize = Math.ceil(this.baseCellSize * this.rasterScale);
    this.atlasSize = this.cellSize * COLUMNS;
    this.size = this.atlasSize;
    this.rasterCanvas = new OffscreenCanvas(this.cellSize, this.cellSize);
    this.rasterContext = this.rasterCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!this.rasterContext)
      throw new Error("GlyphAtlas: 2D raster context unavailable");
    this.texture = this.createAtlasTexture();
    this.slotTableTexture = this.createSlotTableTexture();
  }

  getSlot(cluster: string, advance: number): GlyphSlot {
    const existing = this.slots.get(cluster);
    if (existing) return existing;
    if (this.nextIndex >= MAX_SLOTS)
      return this.slots.get("") ?? this.createSlot("", advance);
    const slot = this.createSlot(cluster, advance);
    this.slots.set(cluster, slot);
    this.rasterize(slot);
    return slot;
  }

  syncSlotTable(): void {
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.slotTableTexture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      SLOT_TABLE_WIDTH,
      SLOT_TABLE_HEIGHT,
      this.gl.RGBA,
      this.gl.FLOAT,
      this.slotData,
    );
  }

  private createSlot(cluster: string, advance: number): GlyphSlot {
    const index = this.nextIndex++;
    const rasterX = (index % COLUMNS) * this.cellSize;
    const rasterY = Math.floor(index / COLUMNS) * this.cellSize;
    const baseWidth = Math.max(1, Math.min(this.baseCellSize - 4, advance));
    const raster: RasterRect = {
      x: rasterX + this.rasterPadding,
      y: rasterY,
      width: Math.max(1, Math.ceil(baseWidth * this.rasterScale)),
      height: Math.ceil(this.baseRasterHeight * this.rasterScale),
    };
    const slot: GlyphSlot = {
      index,
      cluster,
      raster,
      baseline: this.metrics.baseline,
      advance,
    };
    const packed = packSlotRecord(slot, this.atlasSize, this.rasterScale);
    this.slotData.set(
      packed.uv,
      slotTableOffset(index, SLOT_TABLE_ROWS.uv, SLOT_TABLE_WIDTH),
    );
    this.slotData.set(
      packed.geometry,
      slotTableOffset(index, SLOT_TABLE_ROWS.geometry, SLOT_TABLE_WIDTH),
    );
    return slot;
  }

  private rasterize(slot: GlyphSlot): void {
    const context = this.rasterContext;
    if (!context) throw new Error("GlyphAtlas: 2D raster context unavailable");
    context.clearRect(0, 0, this.cellSize, this.cellSize);
    const rasterFontSize = this.font.size * this.rasterScale;
    context.font = `${String(rasterFontSize)}px ${this.font.family}`;
    context.fillStyle = "white";
    context.textBaseline = "alphabetic";
    context.fillText(
      slot.cluster,
      this.rasterPadding,
      slot.baseline * this.rasterScale + 2 * this.rasterScale,
    );
    const source = context.getImageData(
      0,
      0,
      this.cellSize,
      this.cellSize,
    ).data;
    const alpha = new Uint8Array(this.cellSize * this.cellSize);
    for (let row = 0; row < this.cellSize; row += 1) {
      for (let column = 0; column < this.cellSize; column += 1) {
        alpha[row * this.cellSize + column] =
          source[(row * this.cellSize + column) * 4 + 3] ?? 0;
      }
    }
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      slot.raster.x - this.rasterPadding,
      slot.raster.y,
      this.cellSize,
      this.cellSize,
      this.gl.RED,
      this.gl.UNSIGNED_BYTE,
      alpha,
    );
  }

  private createAtlasTexture(): WebGLTexture {
    const texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.LINEAR,
    );
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.R8,
      this.atlasSize,
      this.atlasSize,
      0,
      this.gl.RED,
      this.gl.UNSIGNED_BYTE,
      null,
    );
    return texture;
  }

  private createSlotTableTexture(): WebGLTexture {
    const texture = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MIN_FILTER,
      this.gl.NEAREST,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_MAG_FILTER,
      this.gl.NEAREST,
    );
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA32F,
      SLOT_TABLE_WIDTH,
      SLOT_TABLE_HEIGHT,
      0,
      this.gl.RGBA,
      this.gl.FLOAT,
      this.slotData,
    );
    return texture;
  }
}
