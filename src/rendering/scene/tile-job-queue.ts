import type {
  EncodedRasterCells,
  RasterCellInput,
  RasterResult,
} from "../text/raster-job";
import { encodeRasterCells } from "../text/raster-job";
import { RasterWorkerPool } from "../text/raster-worker-pool";
import type { CodeTextMetrics } from "../text/text-metrics";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  TileRecords,
} from "./tile-records";
import { TILE_DEVICE_SIZE, tileContentSize } from "./tile-plan";
import { TILE_CELL_HEIGHT } from "./tile-pool";
import type { TilePool } from "./tile-pool";
import type { TileSetPlanner } from "./tile-sets";

const MAX_JOBS_PER_FRAME = 4;

export interface TileContentSource {
  readonly fileId: string;
  readonly filePath: string;
  readonly hasText: boolean;
  readonly contentVersion: number;
  readonly highlighted: boolean;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly palette: readonly string[];
  readonly baseline: number;
  readonly lineHeight: number;
  readonly backgroundColor: string;
  readonly headerBackgroundColor: string;
  cellsFor(
    column: number,
    row: number,
    rasterScale: number,
  ): EncodedRasterCells;
  headerCellsFor(column: number, rasterScale: number): EncodedRasterCells;
  readonly label?: TileLabelContentSource;
}

export interface TileLabelContentSource {
  readonly identity: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  jobFor(rasterScale: number): {
    readonly cells: readonly RasterCellInput[];
    readonly font: string;
    readonly baseline: number;
    readonly lineHeight: number;
    readonly originY: number;
    readonly backgroundColor: string;
    readonly palette: readonly string[];
    readonly outlineColor: string;
    readonly outlineWidth: number;
  };
}

export interface TileJobOwner {
  readonly records: TileRecords;
  readonly planner: TileSetPlanner;
  readonly contentSource: TileContentSource | undefined;
  readonly epoch: number;
  isResultCurrent(
    record: number,
    result: Pick<RasterResult, "rasterScale" | "contentVersion">,
  ): boolean;
}

export class TileJobQueue {
  private readonly workerPool: RasterWorkerPool;
  private readonly rasterJob = {
    tileKey: "",
    contentVersion: 0,
    rasterScale: 1,
    backgroundColor: "",
    palette: [] as readonly string[],
    font: "",
    baseline: 0,
    lineHeight: 0,
    originY: 0,
    outlineColor: "",
    outlineWidth: 0,
    width: TILE_DEVICE_SIZE,
    height: TILE_DEVICE_SIZE,
    cells: encodeRasterCells([]),
  };
  private jobsPosted = 0;
  private deadline = 0;
  private jobsInFlight = 0;
  private postedTotalValue = 0;
  private staleTotalValue = 0;
  private uploadFailedTotalValue = 0;

  constructor(
    private readonly config: {
      readonly pool: TilePool;
      readonly metrics: Pick<CodeTextMetrics, "narrowAdvance">;
      readonly rasterFont: string;
      readonly ownerForKey: (key: string) => TileJobOwner | undefined;
    },
  ) {
    this.workerPool = new RasterWorkerPool(config.metrics);
  }

  beginFrame(deadline: number): void {
    this.jobsPosted = 0;
    this.deadline = deadline;
  }

  get inFlightCount(): number {
    return this.jobsInFlight;
  }

  get postedTotal(): number {
    return this.postedTotalValue;
  }

  get staleTotal(): number {
    return this.staleTotalValue;
  }

  get uploadFailedTotal(): number {
    return this.uploadFailedTotalValue;
  }

  ensureTile(owner: TileJobOwner, record: number): void {
    const key = owner.records.keys[record];
    const source = owner.contentSource;
    if (!key || !source) return;
    this.config.pool.touch(key);
    if (owner.records.records.ready[record] || owner.records.pending[record])
      return;
    if (this.jobsPosted >= MAX_JOBS_PER_FRAME) return;
    if (this.jobsPosted > 0 && performance.now() >= this.deadline) return;
    const acquired = this.config.pool.acquire(
      key,
      false,
      usesCell(owner.records, record),
    );
    if (acquired.slot < 0) return;
    if (acquired.evictedKey) {
      const evictedOwner = this.config.ownerForKey(acquired.evictedKey);
      evictedOwner?.records.deactivateByKey(acquired.evictedKey);
    }
    owner.records.pending[record] = 1;
    this.postJob(owner, record);
    this.jobsPosted += 1;
    this.postedTotalValue += 1;
  }

  drainResults(ownerForKey: (key: string) => TileJobOwner | undefined): number {
    let uploadedTiles = 0;
    const results = this.workerPool.drainResults();
    this.jobsInFlight = Math.max(0, this.jobsInFlight - results.length);
    for (const result of results) {
      const owner = ownerForKey(result.tileKey);
      const record = owner?.records.findRecordByKey(result.tileKey) ?? -1;
      if (!owner || record < 0 || !owner.isResultCurrent(record, result)) {
        result.bitmap.close();
        this.staleTotalValue += 1;
        if (owner && record >= 0) owner.records.releaseRecord(record);
        continue;
      }
      if (!this.config.pool.upload(result.tileKey, result.bitmap)) {
        result.bitmap.close();
        this.uploadFailedTotalValue += 1;
        owner.records.releaseRecord(record);
        continue;
      }
      result.bitmap.close();
      owner.records.pending[record] = 0;
      owner.records.records.ready[record] = 1;
      uploadedTiles += 1;
    }
    return uploadedTiles;
  }

  unpinRecords(owner: TileJobOwner): void {
    const records = owner.records;
    for (let index = 0; index < records.records.active.length; index += 1) {
      if (!records.records.active[index]) continue;
      const key = records.keys[index];
      if (key) this.config.pool.setPinned(key, false);
    }
  }

  pinDrawSet(owner: TileJobOwner): void {
    const planner = owner.planner;
    this.pinRecords(
      owner.records,
      planner.drawFallback,
      planner.drawFallbackCount,
    );
    this.pinRecords(
      owner.records,
      planner.drawCurrent,
      planner.drawCurrentCount,
    );
    this.pinRecords(
      owner.records,
      planner.drawHeaderFallback,
      planner.drawHeaderFallbackCount,
    );
    this.pinRecords(
      owner.records,
      planner.drawHeaderCurrent,
      planner.drawHeaderCurrentCount,
    );
    this.pinRecords(
      owner.records,
      planner.drawLabelFallback,
      planner.drawLabelFallbackCount,
    );
    this.pinRecords(
      owner.records,
      planner.drawLabelCurrent,
      planner.drawLabelCurrentCount,
    );
    if (planner.prefetchScale() <= 0) return;
    const records = owner.records;
    for (let index = 0; index < records.records.active.length; index += 1) {
      if (
        records.records.active[index] &&
        records.records.kind[index] === CONTENT_KIND &&
        records.records.epoch[index] === owner.epoch &&
        records.records.rasterScale[index] === planner.prefetchScale()
      ) {
        const key = records.keys[index];
        if (key) this.config.pool.setPinned(key, true);
      }
    }
  }

  rasterError(): string | undefined {
    return this.workerPool.rasterError();
  }

  onResult(callback: () => void): void {
    this.workerPool.onResult(callback);
  }

  dispose(): void {
    this.workerPool.dispose();
  }

  private postJob(owner: TileJobOwner, record: number): void {
    const source = owner.contentSource;
    if (!source) return;
    const kind = owner.records.records.kind[record] ?? CONTENT_KIND;
    const column = owner.records.records.column[record] ?? 0;
    const row = owner.records.records.row[record] ?? 0;
    const rasterScale = owner.records.records.rasterScale[record] ?? 1;
    const size = tileContentSize(rasterScale);
    const labelJob =
      kind === LABEL_KIND ? source.label?.jobFor(rasterScale) : undefined;
    const cells =
      kind === HEADER_KIND
        ? source.headerCellsFor(column, rasterScale)
        : labelJob
          ? encodeRasterCells(labelJob.cells)
          : source.cellsFor(column, row, rasterScale);
    const key = owner.records.keys[record];
    if (!key) return;
    this.rasterJob.tileKey = key;
    this.rasterJob.contentVersion = source.contentVersion;
    this.rasterJob.rasterScale = rasterScale;
    this.rasterJob.backgroundColor =
      kind === HEADER_KIND
        ? source.headerBackgroundColor
        : source.backgroundColor;
    this.rasterJob.palette = source.palette;
    this.rasterJob.font = this.config.rasterFont;
    this.rasterJob.baseline = source.baseline;
    this.rasterJob.lineHeight = source.lineHeight;
    this.rasterJob.originY = kind === HEADER_KIND ? 0 : row * size;
    this.rasterJob.outlineColor = "";
    this.rasterJob.outlineWidth = 0;
    const cell = usesCell(owner.records, record);
    this.rasterJob.width = TILE_DEVICE_SIZE;
    this.rasterJob.height = cell ? TILE_CELL_HEIGHT : TILE_DEVICE_SIZE;
    if (labelJob) {
      this.rasterJob.backgroundColor = labelJob.backgroundColor;
      this.rasterJob.palette = labelJob.palette;
      this.rasterJob.font = labelJob.font;
      this.rasterJob.baseline = labelJob.baseline;
      this.rasterJob.lineHeight = labelJob.lineHeight;
      this.rasterJob.originY = labelJob.originY;
      this.rasterJob.outlineColor = labelJob.outlineColor;
      this.rasterJob.outlineWidth = labelJob.outlineWidth;
    }
    this.rasterJob.cells = cells;
    owner.records.requestedContentVersion[record] = source.contentVersion;
    this.workerPool.post(this.rasterJob);
    this.jobsInFlight += 1;
  }

  private pinRecords(
    records: TileRecords,
    drawRecords: Int32Array,
    count: number,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const record = drawRecords[index] ?? -1;
      const key = record >= 0 ? records.keys[record] : undefined;
      if (key) this.config.pool.setPinned(key, true);
    }
  }
}

function usesCell(records: TileRecords, record: number): boolean {
  const kind = records.records.kind[record];
  if (kind !== HEADER_KIND && kind !== LABEL_KIND) return false;
  const rasterScale = records.records.rasterScale[record] ?? 1;
  return (
    (records.records.height[record] ?? 0) * rasterScale <=
      TILE_CELL_HEIGHT - 1 &&
    (records.records.width[record] ?? 0) * rasterScale <= TILE_DEVICE_SIZE
  );
}
