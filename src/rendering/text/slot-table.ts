export const SLOT_TABLE_ROWS = {
  uv: 0,
  geometry: 1,
} as const;

export const SLOT_TABLE_COMPONENTS = 4;
export const SLOT_TABLE_WIDTH = 256;
export const SLOT_TABLE_HEIGHT = 2;

export interface RasterRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SlotRecord {
  readonly raster: RasterRect;
  readonly advance: number;
  readonly baseline: number;
}

interface PackedSlotRecord {
  readonly uv: readonly [number, number, number, number];
  readonly geometry: readonly [number, number, number, number];
}

export function packSlotRecord(
  record: SlotRecord,
  atlasSize: number,
  rasterScale = 1,
): PackedSlotRecord {
  const { raster } = record;
  return {
    uv: [
      raster.x / atlasSize,
      raster.y / atlasSize,
      (raster.x + raster.width) / atlasSize,
      (raster.y + raster.height) / atlasSize,
    ],
    geometry: [
      raster.width / rasterScale,
      raster.height / rasterScale,
      record.advance,
      record.baseline,
    ],
  };
}

export function slotTableOffset(
  slot: number,
  row: number,
  width = SLOT_TABLE_WIDTH,
): number {
  return (row * width + slot) * SLOT_TABLE_COMPONENTS;
}
