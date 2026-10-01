import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import type { LayoutCell } from "../../src/code-view/domain/line-layout";
import type { createTextMetrics } from "../../src/rendering/text/text-metrics";
import { drawRasterCells } from "../h/renderer";
import { median, percentile } from "./pure";
import {
  DPR,
  TILE_DEVICE_SIZE,
  TILE_MEMORY_BUDGET,
  TILE_SLOTS,
  colorForLine,
  required,
  scrollOffsetFor,
  type RendererName,
  type ScrollOffsets,
  type Tile,
  type Widget,
} from "./model";
import {
  BODY_HEIGHT,
  HEADER_HEIGHT,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  WIDGET_WIDTH,
} from "./pure";
import { SceneGpu } from "./scene-gpu";

function tileWorldSize(rasterZoom: number): number {
  return TILE_DEVICE_SIZE / (DPR * rasterZoom);
}

// The content origin for a tile's slot, in world px: the on-screen slot
// (tileY) is fixed, but scrollBucket (whole tile rows) shifts which source
// lines are painted into it.
function tileContentOriginY(tile: Tile, size: number): number {
  return (tile.tileY + tile.scrollBucket) * size;
}

function tileLines(
  tile: Tile,
): { readonly cell: LayoutCell; readonly lineIndex: number }[] {
  const size = tileWorldSize(tile.rasterZoom);
  const originY = tileContentOriginY(tile, size);
  const firstLine = Math.max(
    0,
    Math.floor(originY / DEFAULT_CODE_FONT.lineHeight) - 1,
  );
  const lastLine = Math.min(
    tile.widget.cells.length,
    Math.ceil((originY + size) / DEFAULT_CODE_FONT.lineHeight) + 1,
  );
  const cells: { readonly cell: LayoutCell; readonly lineIndex: number }[] = [];
  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex += 1)
    for (const cell of tile.widget.cells[lineIndex] ?? [])
      cells.push({ cell, lineIndex });
  return cells;
}

function paintTile(tile: Tile, baseline: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(TILE_DEVICE_SIZE, TILE_DEVICE_SIZE);
  const context = required(canvas.getContext("2d"), "a tile Canvas2D context");
  context.fillStyle = "#181e28";
  context.fillRect(0, 0, TILE_DEVICE_SIZE, TILE_DEVICE_SIZE);
  const scale = DPR * tile.rasterZoom;
  const size = tileWorldSize(tile.rasterZoom);
  const originY = tileContentOriginY(tile, size);
  context.scale(scale, scale);
  const glyphCount = drawRasterCells(
    context,
    tileLines(tile).map((item) => ({
      text: item.cell.text,
      x: item.cell.x - tile.tileX * size,
      y: item.lineIndex * DEFAULT_CODE_FONT.lineHeight - originY + baseline,
      color: colorForLine(item.lineIndex),
    })),
    `${String(DEFAULT_CODE_FONT.size)}px ${DEFAULT_CODE_FONT.family}`,
  );
  tile.glyphCount = glyphCount;
  return canvas;
}

const WORKER_SOURCE = `const drawRasterCells = ${drawRasterCells.toString()}; self.onmessage = async (event) => { const job = event.data; const startedAt = performance.now(); const canvas = new OffscreenCanvas(job.size, job.size); const context = canvas.getContext('2d'); context.fillStyle = '#181e28'; context.fillRect(0, 0, job.size, job.size); context.scale(job.scale, job.scale); const glyphCount = drawRasterCells(context, job.cells, job.font); const bitmap = await createImageBitmap(canvas); self.postMessage({ id: job.id, tileKey: job.tileKey, generation: job.generation, bitmap, glyphCount, rasterMs: performance.now() - startedAt }, [bitmap]); };`;

export class TileRenderer {
  private readonly tiles = new Map<string, Tile>();
  private readonly slots: {
    readonly x: number;
    readonly y: number;
    used: boolean;
  }[] = [];
  private readonly worker: Worker | undefined;
  private rasterZoom: number;
  private nextJobId = 0;
  private tick = 0;
  private readonly rasterTimes: number[] = [];
  private readonly uploadTimes: number[] = [];
  private readonly transferUploadTimes: number[] = [];
  private readonly workerResults: {
    readonly id: number;
    readonly tileKey: string;
    readonly generation: number;
    readonly bitmap: ImageBitmap;
    readonly glyphCount: number;
    readonly rasterMs: number;
  }[] = [];
  private readonly pendingTimes = new Map<number, number>();
  private tilesRasterized = 0;
  private tilesUploaded = 0;
  private tilesRasterizedDuringGesture = 0;
  private emptyTileFrames = 0;
  private coveredTileArea = 0;
  private replacementStartedAt: number | undefined;
  private replacementReadyAt: number | undefined;
  private fallbackTiles: Tile[] = [];
  private replacementActive = false;
  private generation = 0;

  private readonly baseline: number;

  constructor(
    private readonly gpu: SceneGpu,
    private readonly widgets: readonly Widget[],
    renderer: RendererName,
    textMetrics: ReturnType<typeof createTextMetrics>,
  ) {
    // Matches the atlas renderer's baseline (AtlasRenderer reads the same
    // textMetrics.baseline): a hardcoded constant here previously drifted
    // from the font's real ascent/descent, offsetting tile text vertically
    // from the atlas's.
    this.baseline = textMetrics.baseline;
    this.rasterZoom = 1;
    for (let y = 0; y < TILE_SLOTS; y += 1)
      for (let x = 0; x < TILE_SLOTS; x += 1)
        this.slots.push({
          x: x * TILE_DEVICE_SIZE,
          y: y * TILE_DEVICE_SIZE,
          used: false,
        });
    if (renderer === "tiles-worker") {
      const url = URL.createObjectURL(
        new Blob([WORKER_SOURCE], { type: "application/javascript" }),
      );
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = (
        event: MessageEvent<{
          readonly id: number;
          readonly tileKey: string;
          readonly generation: number;
          readonly bitmap: ImageBitmap;
          readonly glyphCount: number;
          readonly rasterMs: number;
        }>,
      ) => {
        this.workerResult(event.data);
      };
    }
  }

  reset(): void {
    this.tiles.clear();
    for (const slot of this.slots) slot.used = false;
    this.rasterTimes.length = 0;
    this.uploadTimes.length = 0;
    this.transferUploadTimes.length = 0;
    for (const result of this.workerResults) result.bitmap.close();
    this.workerResults.length = 0;
    this.pendingTimes.clear();
    this.tilesRasterized = 0;
    this.tilesUploaded = 0;
    this.tilesRasterizedDuringGesture = 0;
    this.emptyTileFrames = 0;
    this.coveredTileArea = 0;
    this.rasterZoom = 1;
    this.replacementStartedAt = undefined;
    this.replacementReadyAt = undefined;
    this.fallbackTiles = [];
    this.replacementActive = false;
    this.generation += 1;
  }

  settleZoom(zoom: number): void {
    const nextRasterZoom = Math.max(0.05, Math.min(4, zoom));
    if (nextRasterZoom === this.rasterZoom) return;
    this.fallbackTiles = [...this.tiles.values()].filter((tile) => tile.ready);
    this.rasterZoom = nextRasterZoom;
    this.replacementStartedAt = performance.now();
    this.replacementReadyAt = undefined;
    this.replacementActive = this.fallbackTiles.length > 0;
    this.generation += 1;
  }

  visibleTiles(
    cameraX: number,
    cameraY: number,
    zoom: number,
    zoomGestureActive = false,
    scrollOffsets: ScrollOffsets = new Map(),
  ): Tile[] {
    const size = tileWorldSize(this.rasterZoom);
    const result: Tile[] = [];
    for (const widget of this.widgets) {
      const screenLeft = (widget.x - cameraX) * zoom;
      const screenTop = (widget.y + HEADER_HEIGHT - cameraY) * zoom;
      if (
        screenLeft > VIEW_WIDTH ||
        screenTop > VIEW_HEIGHT ||
        screenLeft + WIDGET_WIDTH * zoom < 0 ||
        screenTop + BODY_HEIGHT * zoom < 0
      )
        continue;
      const scrollBucket = Math.floor(
        scrollOffsetFor(scrollOffsets, widget.index) / size,
      );
      const columns = Math.ceil(WIDGET_WIDTH / size);
      const rows = Math.ceil(BODY_HEIGHT / size);
      for (let tileY = 0; tileY < rows; tileY += 1)
        for (let tileX = 0; tileX < columns; tileX += 1) {
          const worldX = widget.x + tileX * size;
          const worldY = widget.y + HEADER_HEIGHT + tileY * size;
          if (
            worldX - cameraX > VIEW_WIDTH / zoom ||
            worldY - cameraY > VIEW_HEIGHT / zoom ||
            worldX + size < cameraX ||
            worldY + size < cameraY
          )
            continue;
          const tile = this.getTile(
            widget,
            tileX,
            tileY,
            worldX,
            worldY,
            size,
            zoomGestureActive,
            scrollBucket,
          );
          if (tile) result.push(tile);
        }
    }
    return result;
  }

  prepare(
    tiles: readonly Tile[],
    budgetMs: number,
    zoomGestureActive: boolean,
    gestureActiveForMetrics: boolean,
  ): void {
    if (zoomGestureActive) return;
    const start = performance.now();
    let workerJobs = 0;
    if (this.worker)
      this.drainWorkerResults(budgetMs, start, gestureActiveForMetrics);
    for (const tile of tiles) {
      tile.lastUsed = ++this.tick;
      if (tile.ready || tile.pending) continue;
      if (this.worker) {
        if (workerJobs >= 4 || performance.now() - start >= budgetMs) break;
        tile.pending = true;
        this.postWorker(tile);
        workerJobs += 1;
      } else {
        tile.pending = true;
        const rasterStart = performance.now();
        const canvas = paintTile(tile, this.baseline);
        this.rasterTimes.push(performance.now() - rasterStart);
        this.tilesRasterized += 1;
        this.upload(tile, canvas, gestureActiveForMetrics);
      }
      if (!this.worker && performance.now() - start >= budgetMs) break;
    }
  }

  draw(
    tiles: readonly Tile[],
    cameraX: number,
    cameraY: number,
    zoom: number,
  ): number {
    const replacementsReady =
      tiles.length > 0 && tiles.every((tile) => tile.ready);
    const fallback =
      this.replacementActive && !replacementsReady
        ? this.visibleFallbackTiles(cameraX, cameraY, zoom)
        : [];
    const drawTiles = replacementsReady
      ? tiles
      : [...fallback, ...tiles.filter((tile) => tile.ready)];
    if (this.replacementActive && replacementsReady) {
      this.replacementReadyAt = performance.now();
      this.replacementActive = false;
      this.fallbackTiles = [];
      this.releaseObsoleteTiles();
    }
    const missing =
      drawTiles.length === 0 || drawTiles.some((tile) => !tile.ready);
    if (missing) this.emptyTileFrames += 1;
    const coverageTiles = fallback.length > 0 ? fallback : tiles;
    this.coveredTileArea = coverageTiles.reduce(
      (area, tile) =>
        area +
        (tile.ready
          ? Math.max(
              0,
              Math.min(tile.worldX + tile.width, cameraX + VIEW_WIDTH / zoom) -
                Math.max(tile.worldX, cameraX),
            ) *
            Math.max(
              0,
              Math.min(
                tile.worldY + tile.height,
                cameraY + VIEW_HEIGHT / zoom,
              ) - Math.max(tile.worldY, cameraY),
            )
          : 0),
      0,
    );
    this.gpu.drawTexture(drawTiles, cameraX, cameraY, zoom);
    return drawTiles
      .filter((tile) => tile.ready)
      .reduce((total, tile) => total + tile.glyphCount, 0);
  }

  metrics(): {
    readonly tilesRasterized: number;
    readonly tilesUploaded: number;
    readonly residentTileGlyphs: number;
    readonly tilesRasterizedDuringGesture: number;
    readonly rasterMsMedian: number;
    readonly rasterMsP99: number;
    readonly uploadMsMedian: number;
    readonly imageBitmapTransferUploadMsMedian: number;
    readonly emptyTileFrames: number;
    readonly timeToSharpMs: number | "not measured";
    readonly tileMemoryBytes: number;
    readonly coveredTileArea: number;
  } {
    return {
      tilesRasterized: this.tilesRasterized,
      tilesUploaded: this.tilesUploaded,
      residentTileGlyphs: Array.from(this.tiles.values()).reduce(
        (total, tile) => total + tile.glyphCount,
        0,
      ),
      tilesRasterizedDuringGesture: this.tilesRasterizedDuringGesture,
      rasterMsMedian: median(this.rasterTimes),
      rasterMsP99: percentile(this.rasterTimes, 0.99),
      uploadMsMedian: median(this.uploadTimes),
      imageBitmapTransferUploadMsMedian: median(this.transferUploadTimes),
      emptyTileFrames: this.emptyTileFrames,
      timeToSharpMs:
        this.replacementStartedAt !== undefined &&
        this.replacementReadyAt !== undefined
          ? this.replacementReadyAt - this.replacementStartedAt
          : "not measured",
      tileMemoryBytes: TILE_MEMORY_BUDGET,
      coveredTileArea: this.coveredTileArea,
    };
  }

  private getTile(
    widget: Widget,
    tileX: number,
    tileY: number,
    worldX: number,
    worldY: number,
    size: number,
    zoomGestureActive: boolean,
    scrollBucket: number,
  ): Tile | undefined {
    // scrollBucket is part of the key: a widget that scrolls by a whole tile
    // row needs a different raster for the same on-screen (tileX, tileY)
    // slot, so this naturally falls into the same "rasterize what's missing
    // within budget" path pan already uses — the previous bucket's tile is
    // simply no longer requested and is evicted by takeSlot's LRU like any
    // other stale tile, no separate scroll fallback bookkeeping needed.
    const key = `${String(this.rasterZoom)}:${String(widget.index)}:${String(tileX)}:${String(tileY)}:${String(scrollBucket)}`;
    const cached = this.tiles.get(key);
    if (cached) return cached;
    // During a zoom gesture nothing is rasterized (prepare() is gated), so
    // a widget that only becomes visible at a transient low zoom must not
    // claim a slot here: with 36 slots total, a wide low-zoom trough could
    // otherwise evict the resident tiles a post-gesture settle needs as its
    // fallback, which is the tiles-after-zoom regression this guards.
    if (zoomGestureActive) return undefined;
    const slot = this.takeSlot();
    const width = Math.min(size, WIDGET_WIDTH - tileX * size);
    const height = Math.min(size, BODY_HEIGHT - tileY * size);
    const tile: Tile = {
      key,
      widget,
      tileX,
      tileY,
      rasterZoom: this.rasterZoom,
      scrollBucket,
      worldX,
      worldY,
      width,
      height,
      uvWidth: width / size,
      uvHeight: height / size,
      slotX: slot.x,
      slotY: slot.y,
      ready: false,
      pending: false,
      lastUsed: ++this.tick,
      glyphCount: 0,
    };
    this.tiles.set(key, tile);
    return tile;
  }

  private takeSlot(): { readonly x: number; readonly y: number } {
    const free = this.slots.find((slot) => !slot.used);
    if (free) {
      free.used = true;
      return free;
    }
    const fallbackKeys = new Set(this.fallbackTiles.map((tile) => tile.key));
    const oldestTile = [...this.tiles.values()]
      .filter((tile) => !fallbackKeys.has(tile.key))
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (oldestTile) {
      this.tiles.delete(oldestTile.key);
      return { x: oldestTile.slotX, y: oldestTile.slotY };
    }
    return { x: 0, y: 0 };
  }

  private postWorker(tile: Tile): void {
    if (!this.worker) return;
    const size = tileWorldSize(tile.rasterZoom);
    const originY = tileContentOriginY(tile, size);
    const cells = tileLines(tile).map((item) => ({
      text: item.cell.text,
      x: item.cell.x - tile.tileX * size,
      y:
        item.lineIndex * DEFAULT_CODE_FONT.lineHeight - originY + this.baseline,
      color: colorForLine(item.lineIndex),
    }));
    const id = this.nextJobId++;
    this.pendingTimes.set(id, performance.now());
    this.worker.postMessage({
      id,
      tileKey: tile.key,
      generation: this.generation,
      size: TILE_DEVICE_SIZE,
      scale: DPR * tile.rasterZoom,
      font: `${String(DEFAULT_CODE_FONT.size)}px ${DEFAULT_CODE_FONT.family}`,
      cells,
      startedAt: performance.now(),
    });
  }

  private workerResult(result: {
    readonly id: number;
    readonly tileKey: string;
    readonly generation: number;
    readonly bitmap: ImageBitmap;
    readonly glyphCount: number;
    readonly rasterMs: number;
  }): void {
    if (result.generation !== this.generation) {
      this.pendingTimes.delete(result.id);
      result.bitmap.close();
      return;
    }
    const tile = this.tiles.get(result.tileKey);
    const postedAt = this.pendingTimes.get(result.id);
    if (postedAt !== undefined)
      this.transferUploadTimes.push(performance.now() - postedAt);
    this.pendingTimes.delete(result.id);
    if (!tile) {
      result.bitmap.close();
      return;
    }
    this.workerResults.push(result);
  }

  private drainWorkerResults(
    budgetMs: number,
    startedAt: number,
    gestureActive: boolean,
  ): void {
    while (
      this.workerResults.length > 0 &&
      performance.now() - startedAt < budgetMs
    ) {
      const result = this.workerResults.shift();
      if (!result) break;
      if (result.generation !== this.generation) {
        result.bitmap.close();
        continue;
      }
      const tile = this.tiles.get(result.tileKey);
      if (!tile) {
        result.bitmap.close();
        continue;
      }
      const postedAt = this.pendingTimes.get(result.id);
      if (postedAt !== undefined)
        this.transferUploadTimes.push(performance.now() - postedAt);
      this.pendingTimes.delete(result.id);
      tile.glyphCount = result.glyphCount;
      this.rasterTimes.push(result.rasterMs);
      this.tilesRasterized += 1;
      this.upload(tile, result.bitmap, gestureActive);
      result.bitmap.close();
    }
  }

  private upload(
    tile: Tile,
    source: TexImageSource,
    gestureActive = false,
  ): void {
    const uploadMs = this.gpu.uploadTile(tile, source);
    this.uploadTimes.push(uploadMs);
    this.tilesUploaded += 1;
    if (gestureActive) this.tilesRasterizedDuringGesture += 1;
    tile.ready = true;
    tile.pending = false;
  }

  private visibleFallbackTiles(
    cameraX: number,
    cameraY: number,
    zoom: number,
  ): Tile[] {
    return this.fallbackTiles.filter(
      (tile) =>
        tile.worldX < cameraX + VIEW_WIDTH / zoom &&
        tile.worldX + tile.width > cameraX &&
        tile.worldY < cameraY + VIEW_HEIGHT / zoom &&
        tile.worldY + tile.height > cameraY,
    );
  }

  private releaseObsoleteTiles(): void {
    for (const tile of [...this.tiles.values()]) {
      if (tile.rasterZoom === this.rasterZoom) continue;
      this.tiles.delete(tile.key);
      const slot = this.slots.find(
        (candidate) => candidate.x === tile.slotX && candidate.y === tile.slotY,
      );
      if (slot) slot.used = false;
    }
  }
}
