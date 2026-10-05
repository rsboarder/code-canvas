import { tileContentSize, tileKeyFor } from "../tile-plan";
import {
  createWidgetTileFrameState,
  type WidgetTileFrameState,
} from "./frame-state";

export const CONTENT_KIND = 0;
export const HEADER_KIND = 1;
export const LABEL_KIND = 2;

export interface TileSetRecordArrays {
  readonly active: Uint8Array;
  readonly ready: Uint8Array;
  readonly kind: Uint8Array;
  readonly labelIdentity?: (string | undefined)[];
  readonly rasterScale: Float64Array;
  readonly epoch: Int32Array;
  readonly contentVersion: Int32Array;
  readonly column: Int32Array;
  readonly row: Int32Array;
  readonly localX: Float64Array;
  readonly localY: Float64Array;
  readonly width: Float64Array;
  readonly height: Float64Array;
}

function createTileSetRecordArrays(capacity: number): TileSetRecordArrays {
  return {
    active: new Uint8Array(capacity),
    ready: new Uint8Array(capacity),
    kind: new Uint8Array(capacity),
    labelIdentity: new Array<string | undefined>(capacity),
    rasterScale: new Float64Array(capacity),
    epoch: new Int32Array(capacity),
    contentVersion: new Int32Array(capacity),
    column: new Int32Array(capacity),
    row: new Int32Array(capacity),
    localX: new Float64Array(capacity),
    localY: new Float64Array(capacity),
    width: new Float64Array(capacity),
    height: new Float64Array(capacity),
  };
}

export interface TileRecordSource {
  readonly fileId: string;
  readonly filePath: string;
  readonly contentVersion: number;
  readonly highlighted: boolean;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly label?: TileLabelSource;
}

export interface TileLabelSource {
  readonly identity: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TileRecordPool {
  release(key: string): void;
  isPinned(key: string): boolean;
}

interface TileRecordCallbacks {
  readonly onKeyReleased?: ((key: string) => void) | undefined;
}

export class TileRecords {
  readonly records: TileSetRecordArrays;

  readonly keys: (string | undefined)[];

  readonly headerPaths: (string | undefined)[];

  readonly labelIdentities: (string | undefined)[];

  readonly requestedContentVersion: Int32Array;

  readonly pending: Uint8Array;

  readonly highlighted: Uint8Array;

  private readonly keyTile = { column: 0, row: 0 };

  private source: TileRecordSource | undefined;

  private contentWidth = 0;

  constructor(
    private readonly pool: TileRecordPool,
    capacity: number,
    readonly frameState: WidgetTileFrameState = createWidgetTileFrameState(),
    private readonly callbacks: TileRecordCallbacks = {},
  ) {
    this.records = createTileSetRecordArrays(capacity);
    this.keys = new Array<string | undefined>(capacity);
    this.headerPaths = new Array<string | undefined>(capacity);
    this.labelIdentities = new Array<string | undefined>(capacity);
    this.requestedContentVersion = new Int32Array(capacity);
    this.pending = new Uint8Array(capacity);
    this.highlighted = new Uint8Array(capacity);
  }

  setContentSource(source: TileRecordSource, epoch?: number): void {
    const pathChanged = this.source?.filePath !== source.filePath;
    this.source = source;
    this.contentWidth = source.contentWidth;
    if (epoch !== undefined) this.frameState.epoch = epoch;
    if (pathChanged) {
      this.releaseStaleHeaders(source.filePath);
      this.releaseStaleLabels(source.label?.identity);
    }
    this.updateLabelGeometry(source);
  }

  setLabelSource(label: TileLabelSource): void {
    if (!this.source) return;
    this.source = { ...this.source, label };
    this.updateLabelGeometry(this.source);
  }

  setHeaderHeight(height: number): void {
    this.frameState.headerHeight = height;
  }

  setContentWidth(width: number): void {
    if (!this.source || this.contentWidth === width) return;
    this.contentWidth = width;
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (!this.records.active[index]) continue;
      this.setRecordGeometry(index);
    }
  }

  ensureRecord(
    kind: number,
    rasterScale: number,
    column: number,
    row: number,
  ): number {
    const existing = this.findRecord(kind, rasterScale, column, row);
    if (existing >= 0) return existing;
    const slot = this.findFreeRecord();
    const source = this.source;
    if (slot < 0 || !source) return -1;
    this.keyTile.column = column;
    this.keyTile.row = row;
    const key = tileKeyFor(
      tilePrefix(kind),
      rasterScale,
      this.keyTile,
      tileIdentity(kind, source, this.frameState.epoch),
    );
    this.keys[slot] = key;
    this.records.active[slot] = 1;
    this.records.kind[slot] = kind;
    this.headerPaths[slot] = headerPath(kind, source.filePath);
    this.labelIdentities[slot] = labelIdentity(kind, source);
    if (this.records.labelIdentity)
      this.records.labelIdentity[slot] = labelIdentity(kind, source);
    this.records.rasterScale[slot] = rasterScale;
    this.records.epoch[slot] = this.frameState.epoch;
    this.records.contentVersion[slot] = source.contentVersion;
    this.highlighted[slot] = source.highlighted ? 1 : 0;
    this.records.column[slot] = column;
    this.records.row[slot] = row;
    this.setRecordGeometry(slot);
    this.records.ready[slot] = 0;
    this.pending[slot] = 0;
    this.requestedContentVersion[slot] = -1;
    return slot;
  }

  findRecord(
    kind: number,
    rasterScale: number,
    column: number,
    row: number,
  ): number {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (
        this.records.active[index] &&
        this.records.kind[index] === kind &&
        this.records.rasterScale[index] === rasterScale &&
        this.records.column[index] === column &&
        this.records.row[index] === row &&
        (kind === HEADER_KIND
          ? this.headerPaths[index] === this.source?.filePath
          : kind === LABEL_KIND
            ? this.labelIdentities[index] === this.source?.label?.identity
            : this.records.epoch[index] === this.frameState.epoch)
      )
        return index;
    }
    return -1;
  }

  findRecordByKey(key: string): number {
    for (let index = 0; index < this.keys.length; index += 1) {
      if (this.records.active[index] && this.keys[index] === key) return index;
    }
    return -1;
  }

  recordKind(record: number): number {
    return this.records.kind[record] ?? CONTENT_KIND;
  }

  recordRasterScale(record: number): number {
    return this.records.rasterScale[record] ?? 1;
  }

  recordColumn(record: number): number {
    return this.records.column[record] ?? 0;
  }

  recordRow(record: number): number {
    return this.records.row[record] ?? 0;
  }

  recordWidth(record: number): number {
    return this.records.width[record] ?? 0;
  }

  recordHeight(record: number): number {
    return this.records.height[record] ?? 0;
  }

  recordEpoch(record: number): number {
    return this.records.epoch[record] ?? 0;
  }

  findFreeRecord(): number {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (!this.records.active[index]) return index;
    }
    for (let index = 0; index < this.records.active.length; index += 1) {
      const key = this.keys[index];
      if (key && !this.pending[index] && !this.pool.isPinned(key)) {
        this.pool.release(key);
        this.deactivate(index);
        return index;
      }
    }
    return -1;
  }

  releaseRecord(record: number): void {
    const key = this.keys[record];
    if (key) this.pool.release(key);
    this.deactivate(record);
  }

  releaseStaleHeaders(filePath: string): void {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (
        this.records.active[index] &&
        this.records.kind[index] === HEADER_KIND &&
        this.headerPaths[index] !== filePath
      )
        this.releaseRecord(index);
    }
  }

  releaseStaleLabels(identity: string | undefined): void {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (
        this.records.active[index] &&
        this.records.kind[index] === LABEL_KIND &&
        this.labelIdentities[index] !== identity
      )
        this.releaseRecord(index);
    }
  }

  deactivate(record: number): void {
    const key = this.keys[record];
    if (key) this.callbacks.onKeyReleased?.(key);
    this.records.active[record] = 0;
    this.records.ready[record] = 0;
    this.pending[record] = 0;
    this.highlighted[record] = 0;
    this.headerPaths[record] = undefined;
    this.labelIdentities[record] = undefined;
    if (this.records.labelIdentity)
      this.records.labelIdentity[record] = undefined;
    this.keys[record] = undefined;
  }

  deactivateByKey(key: string): void {
    const record = this.findRecordByKey(key);
    if (record >= 0) this.deactivate(record);
  }

  private setRecordGeometry(slot: number): void {
    const source = this.source;
    if (!source) return;
    const kind = this.records.kind[slot] ?? CONTENT_KIND;
    const rasterScale = this.records.rasterScale[slot] ?? 1;
    const column = this.records.column[slot] ?? 0;
    const row = this.records.row[slot] ?? 0;
    const size = tileContentSize(rasterScale);
    const label = kind === LABEL_KIND ? source.label : undefined;
    if (label) {
      this.records.localX[slot] = label.x;
      this.records.localY[slot] = label.y;
      this.records.width[slot] = label.width;
      this.records.height[slot] = label.height;
      return;
    }
    this.records.localX[slot] = column * size;
    this.records.localY[slot] = row * size;
    this.records.width[slot] = Math.min(
      size,
      this.contentWidth - column * size,
    );
    this.records.height[slot] =
      kind === HEADER_KIND
        ? Math.min(size, this.frameState.headerHeight)
        : Math.min(size, source.contentHeight - row * size);
  }

  private updateLabelGeometry(source: TileRecordSource): void {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (
        this.records.active[index] &&
        this.records.kind[index] === LABEL_KIND &&
        this.labelIdentities[index] === source.label?.identity
      ) {
        this.setRecordGeometry(index);
      }
    }
  }
}

function tilePrefix(kind: number): string {
  if (kind === HEADER_KIND) return "header";
  if (kind === LABEL_KIND) return "label";
  return "content";
}

function tileIdentity(
  kind: number,
  source: TileRecordSource,
  epoch: number,
): number | string {
  if (kind === HEADER_KIND) return `${source.fileId}:${source.filePath}`;
  if (kind === LABEL_KIND)
    return `${source.fileId}:${source.label?.identity ?? source.filePath}`;
  return `${source.fileId}:${String(epoch)}`;
}

function headerPath(kind: number, filePath: string): string | undefined {
  return kind === HEADER_KIND ? filePath : undefined;
}

function labelIdentity(
  kind: number,
  source: TileRecordSource,
): string | undefined {
  return kind === LABEL_KIND
    ? (source.label?.identity ?? source.filePath)
    : undefined;
}
