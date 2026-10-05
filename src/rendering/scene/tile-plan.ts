// Content-anchored tile planning (design D6 "Text Tiles", "Tile pool"): a
// pure function with no GL and no DOM, so the grid math is unit-tested
// without a browser. Tile (column, row) always covers content
// [column*s, (column+1)*s) x [row*s, (row+1)*s), s = TILE_DEVICE_SIZE /
// rasterScale CSS px — independent of scroll, which only shifts which
// window of rows is requested (Content Scroll is 0 in the slice; kept as an
// explicit input so in-widget scroll can reuse this unchanged, D6 "Line
// window").

export const TILE_DEVICE_SIZE = 512;

// Tiles beyond the strictly-visible range, kept resident so a small pan does
// not stall on a freshly empty tile (D6 "Tile pool": "a one-tile margin
// ring").
export const MARGIN_RING_TILES = 1;

interface TileCoordinate {
  readonly column: number;
  readonly row: number;
}

export function tileContentSize(rasterScale: number): number {
  return TILE_DEVICE_SIZE / rasterScale;
}

export function tileKeyFor(
  prefix: string,
  rasterScale: number,
  tile: TileCoordinate,
  identity: number | string,
): string {
  return (
    prefix +
    ":" +
    String(rasterScale) +
    ":" +
    String(tile.column) +
    ":" +
    String(tile.row) +
    ":" +
    String(identity)
  );
}

// D6 "Tile pool": "sized from the viewport — the visible tiles, a one-tile
// margin ring and the old-scale tiles kept while a zoom settles". The tile
// count covering a viewport at any zoom is independent of zoom (a smaller
// raster scale covers proportionally more content per tile), so this only
// depends on the viewport's device-pixel size.
export function computeTilePoolCapacity(
  viewportWidthCss: number,
  viewportHeightCss: number,
  devicePixelRatio: number,
): number {
  const columns =
    Math.ceil((viewportWidthCss * devicePixelRatio) / TILE_DEVICE_SIZE) +
    2 * MARGIN_RING_TILES;
  const rows =
    Math.ceil((viewportHeightCss * devicePixelRatio) / TILE_DEVICE_SIZE) +
    2 * MARGIN_RING_TILES;
  return columns * rows * 2;
}

export function tilePoolGrowthTarget(
  need: number,
  capacity: number,
  columns: number,
  maxSlots: number,
): number {
  if (need <= capacity) return capacity;
  const target = Math.ceil((need * 1.25) / columns) * columns;
  const capped = Math.floor(maxSlots / columns) * columns;
  return Math.max(capacity, Math.min(target, capped));
}
