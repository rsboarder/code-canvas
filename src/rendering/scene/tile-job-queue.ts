import type { RasterResult } from "../text/raster-job";
import { encodeRasterCells } from "../text/raster-job";
import { RasterWorkerPool } from "../text/raster-worker-pool";
import type { CodeTextMetrics } from "../text/text-metrics";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  type TileRecordView,
} from "./widget-tile-set";
import {
  type TileKindRecordReader,
  usesCell,
  writeTileKindJob,
  type TileContentSource,
} from "./tile-kind-jobs";
import type { TilePool } from "./tile-pool";

const MAX_JOBS_PER_FRAME = 4;

export interface TileJobOwner extends TileKindRecordReader {
  readonly contentSource: TileContentSource | undefined;
  readonly epoch: number;
  readonly recordCapacity: number;
  readRecord(record: number): TileRecordView;
  recordKey(record: number): string | undefined;
  recordEpoch(record: number): number;
  findRecordByKey(key: string): number;
  releaseRecord(record: number): void;
  deactivateRecordByKey(key: string): void;
  setRecordPending(record: number, pending: boolean): void;
  setRecordReady(record: number, ready: boolean): void;
  setRequestedContentVersion(record: number, version: number): void;
  isRecordActive(record: number): boolean;
  drawRecords(kind: number, fallback: boolean): Int32Array;
  drawRecordCount(kind: number, fallback: boolean): number;
  prefetchScale(): number;
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
    width: 0,
    height: 0,
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
    const view = owner.readRecord(record);
    const key = view.key;
    const source = owner.contentSource;
    if (!key || !source) return;
    this.config.pool.touch(key);
    if (view.ready || view.pending) return;
    if (this.jobsPosted >= MAX_JOBS_PER_FRAME) return;
    if (this.jobsPosted > 0 && performance.now() >= this.deadline) return;
    const acquired = this.config.pool.acquire(
      key,
      false,
      usesCell(owner, record),
    );
    if (acquired.slot < 0) return;
    if (acquired.evictedKey) {
      const evictedOwner = this.config.ownerForKey(acquired.evictedKey);
      evictedOwner?.deactivateRecordByKey(acquired.evictedKey);
    }
    owner.setRecordPending(record, true);
    if (!this.postJob(owner, record)) {
      owner.releaseRecord(record);
      return;
    }
    this.jobsPosted += 1;
    this.postedTotalValue += 1;
  }

  drainResults(ownerForKey: (key: string) => TileJobOwner | undefined): number {
    let uploadedTiles = 0;
    const results = this.workerPool.drainResults();
    this.jobsInFlight = Math.max(0, this.jobsInFlight - results.length);
    for (const result of results) {
      const owner = ownerForKey(result.tileKey);
      const record = owner?.findRecordByKey(result.tileKey) ?? -1;
      if (!owner || record < 0 || !owner.isResultCurrent(record, result)) {
        result.bitmap.close();
        this.staleTotalValue += 1;
        if (owner && record >= 0) owner.releaseRecord(record);
        continue;
      }
      if (!this.config.pool.upload(result.tileKey, result.bitmap)) {
        result.bitmap.close();
        this.uploadFailedTotalValue += 1;
        owner.releaseRecord(record);
        continue;
      }
      result.bitmap.close();
      owner.setRecordPending(record, false);
      owner.setRecordReady(record, true);
      uploadedTiles += 1;
    }
    return uploadedTiles;
  }

  unpinRecords(owner: TileJobOwner): void {
    for (let index = 0; index < owner.recordCapacity; index += 1) {
      if (!owner.isRecordActive(index)) continue;
      const key = owner.recordKey(index);
      if (key) this.config.pool.setPinned(key, false);
    }
  }

  pinDrawSet(owner: TileJobOwner): void {
    this.pinRecords(owner, CONTENT_KIND, true);
    this.pinRecords(owner, CONTENT_KIND, false);
    this.pinRecords(owner, HEADER_KIND, true);
    this.pinRecords(owner, HEADER_KIND, false);
    this.pinRecords(owner, LABEL_KIND, true);
    this.pinRecords(owner, LABEL_KIND, false);
    const prefetchScale = owner.prefetchScale();
    if (prefetchScale <= 0) return;
    for (let index = 0; index < owner.recordCapacity; index += 1) {
      if (!owner.isRecordActive(index)) continue;
      if (
        owner.recordKind(index) === CONTENT_KIND &&
        owner.recordEpoch(index) === owner.epoch &&
        owner.recordRasterScale(index) === prefetchScale
      ) {
        const key = owner.recordKey(index);
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

  private postJob(owner: TileJobOwner, record: number): boolean {
    const source = owner.contentSource;
    if (!source) return false;
    const rasterScale = owner.recordRasterScale(record);
    const key = owner.recordKey(record);
    if (!key) return false;
    this.rasterJob.tileKey = key;
    this.rasterJob.contentVersion = source.contentVersion;
    this.rasterJob.rasterScale = rasterScale;
    this.rasterJob.font = this.config.rasterFont;
    if (!writeTileKindJob(source, owner, record, this.rasterJob)) return false;
    owner.setRequestedContentVersion(record, source.contentVersion);
    this.workerPool.post(this.rasterJob);
    this.jobsInFlight += 1;
    return true;
  }

  private pinRecords(
    owner: TileJobOwner,
    kind: number,
    fallback: boolean,
  ): void {
    const drawRecords = owner.drawRecords(kind, fallback);
    const count = owner.drawRecordCount(kind, fallback);
    for (let index = 0; index < count; index += 1) {
      const record = drawRecords[index] ?? -1;
      const key = record >= 0 ? owner.recordKey(record) : undefined;
      if (key) this.config.pool.setPinned(key, true);
    }
  }
}
