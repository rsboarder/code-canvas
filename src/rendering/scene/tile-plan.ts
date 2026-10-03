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
const MARGIN_RING_TILES = 1;

interface TileCoordinate {
  readonly column: number;
  readonly row: number;
}

export function rasterScaleFor(zoom: number, devicePixelRatio: number): number {
  return zoom * devicePixelRatio;
}

export function tileContentSize(rasterScale: number): number {
  return TILE_DEVICE_SIZE / rasterScale;
}

interface TilePlanInput {
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly visibleLeft: number;
  readonly visibleTop: number;
  readonly visibleRight: number;
  readonly visibleBottom: number;
  readonly contentScroll: number;
  readonly zoom: number;
  readonly devicePixelRatio: number;
}

function clampedRange(
  visibleStart: number,
  visibleEnd: number,
  size: number,
  contentExtent: number,
): { readonly first: number; readonly last: number } | undefined {
  if (contentExtent <= 0) return undefined;
  const maxIndex = Math.max(0, Math.ceil(contentExtent / size) - 1);
  const first = Math.max(
    0,
    Math.floor(visibleStart / size) - MARGIN_RING_TILES,
  );
  const last = Math.min(
    maxIndex,
    Math.floor(visibleEnd / size) + MARGIN_RING_TILES,
  );
  if (last < first) return undefined;
  return { first, last };
}

// Pure: every call recomputes the same result from its inputs, so the
// per-frame caller (GpuUploaderAdapter) only invokes it when the camera,
// viewport or content actually changed rather than on every tick.
export function planVisibleTiles(input: TilePlanInput): TileCoordinate[] {
  const rasterScale = rasterScaleFor(input.zoom, input.devicePixelRatio);
  const size = tileContentSize(rasterScale);
  const columns = clampedRange(
    input.visibleLeft,
    input.visibleRight,
    size,
    input.contentWidth,
  );
  const rows = clampedRange(
    input.visibleTop + input.contentScroll,
    input.visibleBottom + input.contentScroll,
    size,
    input.contentHeight,
  );
  if (!columns || !rows) return [];
  const tiles: TileCoordinate[] = [];
  for (let row = rows.first; row <= rows.last; row += 1) {
    for (let column = columns.first; column <= columns.last; column += 1) {
      tiles.push({ column, row });
    }
  }
  return tiles;
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
