// The GL-backed half of the tile pool (design D6 "Tile pool"): fixed RGBA
// slots allocated once outside the frame as a `TEXTURE_2D_ARRAY`
// (`texStorage3D`), so sampling never bleeds between slots the way a packed
// atlas with shared edges can. LRU/pinning bookkeeping is delegated to
// `TileSlotAllocator`, which is unit-tested without a GL context.
import { TILE_DEVICE_SIZE } from "./tile-plan";
import {
  TileSlotAllocator,
  type SlotAcquireResult,
} from "./tile-slot-allocator";

export class TilePool {
  private readonly texture: WebGLTexture;
  private readonly allocator: TileSlotAllocator;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly layerCount: number,
  ) {
    this.allocator = new TileSlotAllocator(layerCount);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      TILE_DEVICE_SIZE,
      TILE_DEVICE_SIZE,
      layerCount,
    );
  }

  layerFor(key: string): number | undefined {
    return this.allocator.slotFor(key);
  }

  touch(key: string): void {
    this.allocator.touch(key);
  }

  setPinned(key: string, pinned: boolean): void {
    this.allocator.setPinned(key, pinned);
  }

  isPinned(key: string): boolean {
    return this.allocator.isPinned(key);
  }

  acquire(key: string, pinned: boolean): SlotAcquireResult {
    return this.allocator.acquire(key, pinned);
  }

  release(key: string): void {
    this.allocator.release(key);
  }

  // `texSubImage3D` from the `ImageBitmap` (D6 "Tile pool"): never
  // `UNPACK_FLIP_Y_WEBGL`, the flip lives in the tile UVs instead.
  upload(layer: number, bitmap: ImageBitmap): void {
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, this.texture);
    this.gl.texSubImage3D(
      this.gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      layer,
      TILE_DEVICE_SIZE,
      TILE_DEVICE_SIZE,
      1,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      bitmap,
    );
  }

  bind(textureUnit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + textureUnit);
    this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, this.texture);
  }

  get memoryBytes(): number {
    return this.layerCount * TILE_DEVICE_SIZE * TILE_DEVICE_SIZE * 4;
  }
}
