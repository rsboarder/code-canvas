import {
  encodeRasterCells,
  type RasterJob,
  type RasterResult,
} from "../text/raster-job";
import { usesCell, writeTileKindJob } from "./tile-kind-jobs";
import type { SlotAcquireResult } from "./tile-slot-allocator";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  type TileRecordView,
  TileRecords,
} from "./widget-tile-set/tile-records";
import type { WidgetTiles } from "./widget-tile-set/widget-tiles";

type WritableRasterJob = {
  -readonly [Key in keyof RasterJob]: RasterJob[Key];
};

interface TileRequestInput {
  kind: number;
  scale: number;
  column: number;
  row: number;
}

const RECORD_VIEW: TileRecordView = {
  key: undefined,
  active: false,
  ready: false,
  pending: false,
  kind: CONTENT_KIND,
  rasterScale: 1,
  epoch: 0,
  contentVersion: -1,
  column: 0,
  row: 0,
  localX: 0,
  localY: 0,
  width: 0,
  height: 0,
  highlighted: false,
};

interface TileLifecyclePool {
  touch(key: string): void;
  setPinned(key: string, pinned: boolean): void;
  isPinned(key: string): boolean;
  acquire(key: string, pinned: boolean, cell: boolean): SlotAcquireResult;
  release(key: string): void;
  upload(key: string, bitmap: ImageBitmap): boolean;
}

interface TileLifecycleQueue {
  readonly inFlightCount: number;
  readonly postedTotal: number;
  beginFrame(deadline: number): void;
  canPost(): boolean;
  post(job: RasterJob): void;
  drainResults(out: RasterResult[]): number;
}

interface TileLifecycleConfig {
  readonly pool: TileLifecyclePool;
  readonly jobQueue: TileLifecycleQueue;
  readonly rasterFont: string;
}

export class TileLifecycle {
  private pool: TileLifecyclePool;

  private jobQueue: TileLifecycleQueue;

  private readonly widgets = new Set<WidgetTiles>();

  private readonly owners = new Map<string, WidgetTiles>();

  private readonly pinnedKeys: string[] = [];

  private readonly results: RasterResult[] = [];

  private readonly singleRecord = new Int32Array(1);

  private readonly requestInput: TileRequestInput = {
    kind: CONTENT_KIND,
    scale: 1,
    column: 0,
    row: 0,
  };

  private readonly rasterJob: WritableRasterJob = {
    tileKey: "",
    contentVersion: 0,
    rasterScale: 1,
    backgroundColor: "",
    palette: [],
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

  private readonly rasterFont: string;

  private pinnedCount = 0;

  private staleTotalValue = 0;

  private uploadFailedTotalValue = 0;

  private requestedTotalValue = 0;

  private missingTotalValue = 0;

  constructor(config: TileLifecycleConfig) {
    this.pool = config.pool;
    this.jobQueue = config.jobQueue;
    this.rasterFont = config.rasterFont;
  }

  get inFlightCount(): number {
    return this.jobQueue.inFlightCount;
  }

  get postedTotal(): number {
    return this.jobQueue.postedTotal;
  }

  get staleTotal(): number {
    return this.staleTotalValue;
  }

  get uploadFailedTotal(): number {
    return this.uploadFailedTotalValue;
  }

  get requestedTotal(): number {
    return this.requestedTotalValue;
  }

  get missingTotal(): number {
    return this.missingTotalValue;
  }

  attach(widget: WidgetTiles): void {
    this.widgets.add(widget);
  }

  detach(widget: WidgetTiles): void {
    this.unpin(widget);
    const records = widget.tileRecords;
    for (let record = 0; record < records.records.active.length; record += 1) {
      if (records.records.active[record]) this.release(widget, record);
    }
    this.widgets.delete(widget);
  }

  beginFrame(deadline: number): void {
    this.unpinPrevious();
    this.pinnedCount = 0;
    this.requestedTotalValue = 0;
    this.missingTotalValue = 0;
    this.jobQueue.beginFrame(deadline);
  }

  request(widget: WidgetTiles): void {
    if (!widget.contentSource) return;
    if (widget.requestLabel) {
      this.requestInput.kind = LABEL_KIND;
      this.requestInput.scale = widget.requestScale(LABEL_KIND);
      this.requestInput.column = 0;
      this.requestInput.row = 0;
      const record = this.ensure(widget, this.requestInput);
      if (record >= 0) this.ensureTile(widget, record);
    }
    for (let header = 0; header < widget.requestHeaderCount; header += 1) {
      this.requestInput.kind = HEADER_KIND;
      this.requestInput.scale = widget.requestScale(HEADER_KIND);
      this.requestInput.column = widget.requestHeaderColumns[header] ?? 0;
      this.requestInput.row = 0;
      const record = this.ensure(widget, this.requestInput);
      if (record >= 0) this.ensureTile(widget, record);
    }
    for (let request = 0; request < widget.requestCount; request += 1) {
      this.requestInput.kind = CONTENT_KIND;
      this.requestInput.scale = widget.requestScales[request] ?? 1;
      this.requestInput.column = widget.requestColumns[request] ?? 0;
      this.requestInput.row = widget.requestRows[request] ?? 0;
      const record = this.ensure(widget, this.requestInput);
      if (record < 0) continue;
      this.requestedTotalValue += 1;
      this.ensureTile(widget, record);
      this.read(widget.tileRecords, record);
      if (!RECORD_VIEW.ready) this.missingTotalValue += 1;
    }
  }

  private unpin(widget: WidgetTiles): void {
    for (let index = 0; index < this.pinnedCount; index += 1) {
      const key = this.pinnedKeys[index];
      if (key && this.owners.get(key) === widget)
        this.pool.setPinned(key, false);
    }
  }

  pin(widget: WidgetTiles): void {
    const drawSet = widget.drawSet;
    this.pinRecords(
      widget.tileRecords,
      drawSet.drawFallback,
      drawSet.drawFallbackCount,
    );
    this.pinRecords(
      widget.tileRecords,
      drawSet.drawCurrent,
      drawSet.drawCurrentCount,
    );
    this.pinRecords(
      widget.tileRecords,
      drawSet.drawHeaderFallback,
      drawSet.drawHeaderFallbackCount,
    );
    this.pinRecords(
      widget.tileRecords,
      drawSet.drawHeaderCurrent,
      drawSet.drawHeaderCurrentCount,
    );
    this.pinRecords(
      widget.tileRecords,
      drawSet.drawLabelFallback,
      drawSet.drawLabelFallbackCount,
    );
    this.pinRecords(
      widget.tileRecords,
      drawSet.drawLabelCurrent,
      drawSet.drawLabelCurrentCount,
    );
    this.pinPrefetch(widget);
  }

  drainResults(): number {
    const count = this.jobQueue.drainResults(this.results);
    let uploaded = 0;
    for (let index = 0; index < count; index += 1) {
      const result = this.results[index];
      if (!result) continue;
      const widget = this.owners.get(result.tileKey);
      const record = widget?.tileRecords.findRecordByKey(result.tileKey) ?? -1;
      if (!widget || record < 0 || !this.isCurrent(widget, record, result)) {
        result.bitmap.close();
        this.staleTotalValue += 1;
        if (widget && record >= 0) this.release(widget, record);
        continue;
      }
      if (!this.pool.upload(result.tileKey, result.bitmap)) {
        result.bitmap.close();
        this.uploadFailedTotalValue += 1;
        this.release(widget, record);
        continue;
      }
      result.bitmap.close();
      widget.tileRecords.setState(record, "pending", false);
      widget.tileRecords.setState(record, "ready", true);
      uploaded += 1;
    }
    return uploaded;
  }

  sourceChanged(
    widget: WidgetTiles,
    nextPath: string,
    nextLabel: string | undefined,
  ): void {
    const oldSource = widget.contentSource;
    if (!oldSource || oldSource.filePath === nextPath) return;
    const records = widget.tileRecords;
    for (let record = 0; record < records.records.active.length; record += 1) {
      if (!records.records.active[record]) continue;
      records.read(record, RECORD_VIEW);
      const staleHeader =
        RECORD_VIEW.kind === HEADER_KIND &&
        records.headerPaths[record] !== nextPath;
      const staleLabel =
        RECORD_VIEW.kind === LABEL_KIND &&
        records.labelIdentities[record] !== nextLabel;
      if (staleHeader || staleLabel) this.release(widget, record);
    }
  }

  restorePool(pool: TileLifecyclePool, jobQueue: TileLifecycleQueue): void {
    this.unpinPrevious();
    this.pinnedCount = 0;
    for (const widget of this.widgets) {
      const records = widget.tileRecords;
      for (
        let record = 0;
        record < records.records.active.length;
        record += 1
      ) {
        if (records.records.active[record]) this.release(widget, record);
      }
    }
    this.owners.clear();
    this.pool = pool;
    this.jobQueue = jobQueue;
    for (const widget of this.widgets) widget.restoreResidency();
  }

  private ensure(widget: WidgetTiles, input: TileRequestInput): number {
    const records = widget.tileRecords;
    let record = records.findRecord(
      input.kind,
      input.scale,
      input.column,
      input.row,
    );
    if (record >= 0) return this.rememberOwner(widget, record);
    if (record < 0 && records.findFreeRecord() < 0) {
      this.evictFirstAvailable(widget);
    }
    record = records.ensureRecord(
      input.kind,
      input.scale,
      input.column,
      input.row,
    );
    if (record < 0) return -1;
    return this.rememberOwner(widget, record);
  }

  private rememberOwner(widget: WidgetTiles, record: number): number {
    const records = widget.tileRecords;
    const key = records.keys[record];
    if (key && !this.owners.has(key)) this.owners.set(key, widget);
    return record;
  }

  private ensureTile(widget: WidgetTiles, record: number): void {
    const records = widget.tileRecords;
    this.read(records, record);
    const key = RECORD_VIEW.key;
    const source = widget.contentSource;
    if (!key || !source) return;
    this.pool.touch(key);
    if (RECORD_VIEW.ready || RECORD_VIEW.pending) return;
    if (!this.jobQueue.canPost()) return;
    const acquired = this.pool.acquire(key, false, usesCell(records, record));
    if (acquired.slot < 0) return;
    if (acquired.evictedKey) this.evictKey(acquired.evictedKey);
    this.rasterJob.tileKey = key;
    this.rasterJob.contentVersion = source.contentVersion;
    this.rasterJob.rasterScale = RECORD_VIEW.rasterScale;
    this.rasterJob.font = this.rasterFont;
    if (!writeTileKindJob(source, records, record, this.rasterJob)) {
      this.pool.release(key);
      records.clear(record);
      this.owners.delete(key);
      return;
    }
    records.setRequestedContentVersion(record, source.contentVersion);
    records.setState(record, "pending", true);
    this.jobQueue.post(this.rasterJob);
  }

  private pinRecords(
    records: TileRecords,
    values: Int32Array,
    count: number,
  ): void {
    for (let index = 0; index < count; index += 1) {
      const record = values[index] ?? -1;
      if (record < 0) continue;
      records.read(record, RECORD_VIEW);
      const key = RECORD_VIEW.key;
      if (!key) continue;
      this.pool.setPinned(key, true);
      this.pinnedKeys[this.pinnedCount] = key;
      this.pinnedCount += 1;
    }
  }

  private pinPrefetch(widget: WidgetTiles): void {
    const scale = widget.plan.prefetchScale();
    if (scale <= 0) return;
    const records = widget.tileRecords;
    for (let record = 0; record < records.records.active.length; record += 1) {
      if (
        !records.records.active[record] ||
        records.records.kind[record] !== CONTENT_KIND ||
        records.records.epoch[record] !== widget.epoch ||
        records.records.rasterScale[record] !== scale
      )
        continue;
      this.singleRecord[0] = record;
      this.pinRecords(records, this.singleRecord, 1);
    }
  }

  private unpinPrevious(): void {
    for (let index = 0; index < this.pinnedCount; index += 1) {
      const key = this.pinnedKeys[index];
      if (key) this.pool.setPinned(key, false);
    }
  }

  private evictFirstAvailable(widget: WidgetTiles): void {
    const records = widget.tileRecords;
    for (let record = 0; record < records.records.active.length; record += 1) {
      if (!records.records.active[record] || records.pending[record]) continue;
      const key = records.keys[record];
      if (!key || this.pool.isPinned(key)) continue;
      this.release(widget, record);
      return;
    }
  }

  private evictKey(key: string): void {
    const widget = this.owners.get(key);
    if (!widget) return;
    const record = widget.tileRecords.findRecordByKey(key);
    if (record >= 0) widget.tileRecords.clear(record);
    this.owners.delete(key);
  }

  private release(widget: WidgetTiles, record: number): void {
    const records = widget.tileRecords;
    records.read(record, RECORD_VIEW);
    const key = RECORD_VIEW.key;
    if (key) {
      this.pool.release(key);
      this.owners.delete(key);
    }
    records.clear(record);
  }

  private read(records: TileRecords, record: number): void {
    records.read(record, RECORD_VIEW);
  }

  private isCurrent(
    widget: WidgetTiles,
    record: number,
    result: Pick<RasterResult, "rasterScale" | "contentVersion">,
  ): boolean {
    const records = widget.tileRecords;
    this.read(records, record);
    if (RECORD_VIEW.rasterScale !== result.rasterScale) return false;
    if (RECORD_VIEW.kind === HEADER_KIND)
      return this.isHeaderRequested(widget, RECORD_VIEW.column);
    if (RECORD_VIEW.kind === LABEL_KIND)
      return (
        widget.requestLabel &&
        RECORD_VIEW.rasterScale === widget.requestScale(LABEL_KIND)
      );
    if (RECORD_VIEW.epoch !== widget.epoch) return false;
    if (records.requestedContentVersion[record] !== result.contentVersion)
      return false;
    return widget.plan.isRequested(
      result.rasterScale,
      RECORD_VIEW.column,
      RECORD_VIEW.row,
      RECORD_VIEW.epoch,
    );
  }

  private isHeaderRequested(widget: WidgetTiles, column: number): boolean {
    if (RECORD_VIEW.rasterScale !== widget.requestScale(HEADER_KIND))
      return false;
    for (let index = 0; index < widget.requestHeaderCount; index += 1) {
      if (widget.requestHeaderColumns[index] === column) return true;
    }
    return false;
  }
}
