// The GL-backed half of the tile pool (design D6 "Tile pool"): fixed RGBA
// slots allocated outside the frame as a `TEXTURE_2D` atlas (`texStorage2D`).
// LRU/pinning bookkeeping is delegated to
// `TileSlotAllocator`, which is unit-tested without a GL context.
import { TILE_DEVICE_SIZE } from "./tile-plan";
import {
  TileSlotAllocator,
  type SlotAcquireResult,
} from "./tile-slot-allocator";

interface TilePoolTexelOrigin {
  x: number;
  y: number;
}

export const TILE_CELL_HEIGHT = 32;
export const TILE_CELL_LAYERS = 32;
export const TILE_CELLS_PER_LAYER = TILE_DEVICE_SIZE / TILE_CELL_HEIGHT;

export interface TilePoolRegion {
  uvOffsetX: number;
  uvOffsetY: number;
}

export class TilePool {
  private texture: WebGLTexture;
  private readonly fullAllocator: TileSlotAllocator;
  private readonly cellAllocator: TileSlotAllocator;
  private readonly regionOrigin: TilePoolTexelOrigin = { x: 0, y: 0 };
  private readonly uploadOrigin: TilePoolTexelOrigin = { x: 0, y: 0 };
  private readonly columns: number;
  private readonly maxFullSlotsValue: number;
  private readonly atlasWidthValue: number;
  private atlasHeightValue: number;
  private readonly maxTextureSizeValue: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    initialFullCapacity: number,
  ) {
    const maxTextureSizeParameter = gl.getParameter(
      gl.MAX_TEXTURE_SIZE,
    ) as unknown;
    const maxTextureSize =
      typeof maxTextureSizeParameter === "number"
        ? maxTextureSizeParameter
        : 4096;
    this.maxTextureSizeValue = maxTextureSize;
    this.columns = Math.min(16, Math.floor(maxTextureSize / TILE_DEVICE_SIZE));
    const fullCapacity =
      Math.ceil(initialFullCapacity / this.columns) * this.columns;
    this.maxFullSlotsValue = this.calculateMaxFullSlots();
    const rows = this.rowsFor(fullCapacity);
    this.atlasWidthValue = this.columns * TILE_DEVICE_SIZE;
    this.atlasHeightValue = rows * TILE_DEVICE_SIZE;
    if (this.atlasHeightValue > this.maxTextureSizeValue) {
      throw new Error(
        `TilePool atlas ${String(this.atlasWidthValue)}x${String(this.atlasHeightValue)} exceeds MAX_TEXTURE_SIZE ${String(this.maxTextureSizeValue)}`,
      );
    }
    this.fullAllocator = new TileSlotAllocator(fullCapacity);
    this.cellAllocator = new TileSlotAllocator(
      TILE_CELL_LAYERS * TILE_CELLS_PER_LAYER,
    );
    this.texture = this.createTexture(this.atlasHeightValue);
  }

  touch(key: string): void {
    this.allocatorForKey(key)?.touch(key);
  }

  setPinned(key: string, pinned: boolean): void {
    this.allocatorForKey(key)?.setPinned(key, pinned);
  }

  isPinned(key: string): boolean {
    return this.allocatorForKey(key)?.isPinned(key) ?? false;
  }

  acquire(key: string, pinned: boolean, cell: boolean): SlotAcquireResult {
    const allocator = cell ? this.cellAllocator : this.fullAllocator;
    return allocator.acquire(key, pinned);
  }

  release(key: string): void {
    this.allocatorForKey(key)?.release(key);
  }

  regionFor(key: string, out: TilePoolRegion): boolean {
    if (!this.texelOriginFor(key, this.regionOrigin)) return false;
    out.uvOffsetX = this.regionOrigin.x / this.atlasWidthValue;
    out.uvOffsetY = this.regionOrigin.y / this.atlasHeightValue;
    return true;
  }

  // `texSubImage2D` from the `ImageBitmap` (D6 "Tile pool"): never
  // `UNPACK_FLIP_Y_WEBGL`, the flip lives in the tile UVs instead.
  upload(key: string, bitmap: ImageBitmap): boolean {
    if (!this.texelOriginFor(key, this.uploadOrigin)) return false;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.uploadOrigin.x,
      this.uploadOrigin.y,
      bitmap.width,
      bitmap.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      bitmap,
    );
    return true;
  }

  bind(textureUnit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + textureUnit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
  }

  get memoryBytes(): number {
    return this.atlasWidthValue * this.atlasHeightValue * 4;
  }

  get fullCapacity(): number {
    return this.fullAllocator.capacity;
  }

  get maxFullSlots(): number {
    return this.maxFullSlotsValue;
  }

  get columnCount(): number {
    return this.columns;
  }

  grow(newFullCapacity: number): boolean {
    if (
      newFullCapacity <= this.fullCapacity ||
      newFullCapacity % this.columns !== 0 ||
      newFullCapacity > this.maxFullSlotsValue
    )
      return false;
    const oldTexture = this.texture;
    const oldFullHeight = this.fullHeight;
    const newHeight = this.rowsFor(newFullCapacity) * TILE_DEVICE_SIZE;
    const newTexture = this.createTexture(newHeight);
    const framebuffer = this.gl.createFramebuffer();
    this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, framebuffer);
    this.gl.framebufferTexture2D(
      this.gl.READ_FRAMEBUFFER,
      this.gl.COLOR_ATTACHMENT0,
      this.gl.TEXTURE_2D,
      oldTexture,
      0,
    );
    this.gl.bindTexture(this.gl.TEXTURE_2D, newTexture);
    this.gl.copyTexSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      0,
      0,
      0,
      this.atlasWidthValue,
      oldFullHeight,
    );
    this.gl.copyTexSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      0,
      (newFullCapacity / this.columns) * TILE_DEVICE_SIZE,
      0,
      oldFullHeight,
      this.atlasWidthValue,
      this.cellHeight,
    );
    this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, null);
    this.gl.deleteFramebuffer(framebuffer);
    this.gl.deleteTexture(oldTexture);
    this.texture = newTexture;
    this.fullAllocator.grow(newFullCapacity);
    this.atlasHeightValue = newHeight;
    return true;
  }

  fullPinnedCount(): number {
    return this.fullAllocator.pinnedCount();
  }

  get slotUvScaleX(): number {
    return TILE_DEVICE_SIZE / this.atlasWidthValue;
  }

  get slotUvScaleY(): number {
    return TILE_DEVICE_SIZE / this.atlasHeightValue;
  }

  get atlasWidth(): number {
    return this.atlasWidthValue;
  }

  get atlasHeight(): number {
    return this.atlasHeightValue;
  }

  private get fullHeight(): number {
    return (this.fullCapacity / this.columns) * TILE_DEVICE_SIZE;
  }

  private get cellHeight(): number {
    return this.cellRows * TILE_DEVICE_SIZE;
  }

  private get cellRows(): number {
    return Math.ceil(TILE_CELL_LAYERS / this.columns);
  }

  private rowsFor(fullCapacity: number): number {
    return fullCapacity / this.columns + this.cellRows;
  }

  private calculateMaxFullSlots(): number {
    const availableRows = Math.floor(
      this.maxTextureSizeValue / TILE_DEVICE_SIZE,
    );
    return Math.max(0, availableRows - this.cellRows) * this.columns;
  }

  private createTexture(height: number): WebGLTexture {
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
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_S,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texParameteri(
      this.gl.TEXTURE_2D,
      this.gl.TEXTURE_WRAP_T,
      this.gl.CLAMP_TO_EDGE,
    );
    this.gl.texStorage2D(
      this.gl.TEXTURE_2D,
      1,
      this.gl.RGBA8,
      this.atlasWidthValue,
      height,
    );
    return texture;
  }

  private allocatorForKey(key: string): TileSlotAllocator | undefined {
    if (this.fullAllocator.slotFor(key) !== undefined)
      return this.fullAllocator;
    if (this.cellAllocator.slotFor(key) !== undefined)
      return this.cellAllocator;
    return undefined;
  }

  private texelOriginFor(key: string, out: TilePoolTexelOrigin): boolean {
    const fullSlot = this.fullAllocator.slotFor(key);
    if (fullSlot !== undefined) {
      out.x = (fullSlot % this.columns) * TILE_DEVICE_SIZE;
      out.y = Math.floor(fullSlot / this.columns) * TILE_DEVICE_SIZE;
      return true;
    }
    const cellSlot = this.cellAllocator.slotFor(key);
    if (cellSlot === undefined) return false;
    const slot =
      this.fullCapacity + Math.floor(cellSlot / TILE_CELLS_PER_LAYER);
    out.x = (slot % this.columns) * TILE_DEVICE_SIZE;
    out.y =
      Math.floor(slot / this.columns) * TILE_DEVICE_SIZE +
      (cellSlot % TILE_CELLS_PER_LAYER) * TILE_CELL_HEIGHT;
    return true;
  }
}
