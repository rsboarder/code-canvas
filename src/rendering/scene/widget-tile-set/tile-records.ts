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

export interface TileRecordView {
  key: string | undefined;
  active: boolean;
  ready: boolean;
  pending: boolean;
  kind: number;
  rasterScale: number;
  epoch: number;
  contentVersion: number;
  column: number;
  row: number;
  localX: number;
  localY: number;
  width: number;
  height: number;
  highlighted: boolean;
}

export interface TileLabelSource {
  readonly identity: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export class TileRecords {
  readonly frameState: WidgetTileFrameState;

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
    capacity: number,
    frameState: WidgetTileFrameState = createWidgetTileFrameState(),
  ) {
    this.frameState = frameState;
    this.records = createTileSetRecordArrays(capacity);
    this.keys = new Array<string | undefined>(capacity);
    this.headerPaths = new Array<string | undefined>(capacity);
    this.labelIdentities = new Array<string | undefined>(capacity);
    this.requestedContentVersion = new Int32Array(capacity);
    this.pending = new Uint8Array(capacity);
    this.highlighted = new Uint8Array(capacity);
  }

  setContentSource(source: TileRecordSource, epoch?: number): void {
    this.source = source;
    this.contentWidth = source.contentWidth;
    if (epoch !== undefined) this.frameState.epoch = epoch;
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

  read(record: number, out: TileRecordView): void {
    out.key = this.keys[record];
    out.active = this.records.active[record] === 1;
    out.ready = this.records.ready[record] === 1;
    out.pending = this.pending[record] === 1;
    out.kind = this.records.kind[record] ?? CONTENT_KIND;
    out.rasterScale = this.records.rasterScale[record] ?? 1;
    out.epoch = this.records.epoch[record] ?? 0;
    out.contentVersion = this.records.contentVersion[record] ?? -1;
    out.column = this.records.column[record] ?? 0;
    out.row = this.records.row[record] ?? 0;
    out.localX = this.records.localX[record] ?? 0;
    out.localY = this.records.localY[record] ?? 0;
    out.width = this.records.width[record] ?? 0;
    out.height = this.records.height[record] ?? 0;
    out.highlighted = this.highlighted[record] === 1;
  }

  findFreeRecord(): number {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (!this.records.active[index]) return index;
    }
    return -1;
  }

  clear(record: number): void {
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

  setState(record: number, state: "pending" | "ready", value: boolean): void {
    if (state === "pending") this.pending[record] = value ? 1 : 0;
    if (state === "ready") this.records.ready[record] = value ? 1 : 0;
  }

  setRequestedContentVersion(record: number, version: number): void {
    this.requestedContentVersion[record] = version;
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
