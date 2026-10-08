import { MARGIN_RING_TILES, TILE_DEVICE_SIZE } from "../tile-plan";
import { TileDrawSet } from "./tile-draw-set";
import {
  createWidgetTileFrameState,
  type WidgetTileFrameState,
} from "./frame-state";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  type TileSetRecordArrays,
} from "./tile-records";
import {
  requestScale as textTileRequestScale,
  revealPrefetchScale,
} from "./text-tile-raster-scale-rule";

export function previousPowerOfTwo(scale: number): number {
  const lower = 2 ** Math.floor(Math.log2(scale));
  return Math.abs(scale - lower) < Number.EPSILON * Math.max(1, scale)
    ? lower / 2
    : lower;
}

export class TileSetPlanner {
  readonly requestColumns: Int32Array;

  readonly requestRows: Int32Array;

  readonly requestScales: Float64Array;

  readonly requestHeaderColumns: Int32Array;

  requestLabel = false;

  requestCount = 0;

  requestHeaderCount = 0;

  get visibleFirstColumn(): number {
    return this.frameState.visibleFirstColumn;
  }

  get visibleLastColumn(): number {
    return this.frameState.visibleLastColumn;
  }

  get visibleFirstRow(): number {
    return this.frameState.visibleFirstRow;
  }

  get visibleLastRow(): number {
    return this.frameState.visibleLastRow;
  }

  get drawFallback(): Int32Array {
    return this.drawSet.drawFallback;
  }

  get drawCurrent(): Int32Array {
    return this.drawSet.drawCurrent;
  }

  get drawHeaderFallback(): Int32Array {
    return this.drawSet.drawHeaderFallback;
  }

  get drawHeaderCurrent(): Int32Array {
    return this.drawSet.drawHeaderCurrent;
  }

  get drawLabelFallback(): Int32Array {
    return this.drawSet.drawLabelFallback;
  }

  get drawLabelCurrent(): Int32Array {
    return this.drawSet.drawLabelCurrent;
  }

  get drawFallbackCount(): number {
    return this.drawSet.drawFallbackCount;
  }

  get drawCurrentCount(): number {
    return this.drawSet.drawCurrentCount;
  }

  get drawHeaderFallbackCount(): number {
    return this.drawSet.drawHeaderFallbackCount;
  }

  get drawHeaderCurrentCount(): number {
    return this.drawSet.drawHeaderCurrentCount;
  }

  get drawLabelFallbackCount(): number {
    return this.drawSet.drawLabelFallbackCount;
  }

  get drawLabelCurrentCount(): number {
    return this.drawSet.drawLabelCurrentCount;
  }

  get missingTile(): boolean {
    return this.drawSet.missingTile;
  }

  get drawSetView(): TileDrawSet {
    return this.drawSet;
  }

  private readonly drawSet: TileDrawSet;
  private readonly frameState: WidgetTileFrameState;

  private prefetchActive = false;

  private prefetchZoom = 0;

  private contentRequestScale = 1;

  private columnRangeFirst = 0;

  private columnRangeLast = -1;

  private minimapActive = false;

  private textWanted = false;

  private labelActive = true;

  private prefetchLeft = 0;

  private prefetchTop = 0;

  private prefetchRight = 0;

  private prefetchBottom = 0;

  constructor(
    records: TileSetRecordArrays,
    capacity: number,
    frameState: WidgetTileFrameState = createWidgetTileFrameState(),
  ) {
    this.frameState = frameState;
    this.drawSet = new TileDrawSet(records, capacity, this.frameState);
    this.requestColumns = new Int32Array(capacity);
    this.requestRows = new Int32Array(capacity);
    this.requestScales = new Float64Array(capacity);
    this.requestHeaderColumns = new Int32Array(capacity);
  }

  // Kept for standalone planner tests; WidgetTiles.prepare writes frameState directly.
  setContentSize(width: number, height: number): void {
    this.frameState.contentWidth = width;
    this.frameState.contentHeight = height;
  }

  // Kept for standalone planner tests; WidgetTiles.prepare writes frameState directly.
  setHeaderHeight(height: number): void {
    this.frameState.headerHeight = height;
  }

  // Kept for standalone planner tests; WidgetTiles.prepare writes frameState directly.
  setVisibleBounds(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    this.frameState.visibleLeft = left;
    this.frameState.visibleTop = top;
    this.frameState.visibleRight = right;
    this.frameState.visibleBottom = bottom;
  }

  setZoom(
    zoom: number,
    devicePixelRatio: number,
    gestureActive: boolean,
  ): void {
    this.frameState.zoom = zoom;
    this.frameState.devicePixelRatio = devicePixelRatio;
    this.frameState.zoomGestureActive = gestureActive;
  }

  // Kept for standalone planner tests; WidgetTiles.prepare writes frameState directly.
  setEpoch(epoch: number): void {
    this.frameState.epoch = epoch;
  }

  // Kept for standalone planner tests; WidgetTiles.prepare writes frameState directly.
  setAtRestScale(scale: number): void {
    this.frameState.atRestScale = scale;
  }

  setPrefetchActive(active: boolean): void {
    this.prefetchActive = active;
  }

  setPrefetchZoom(zoom: number): void {
    this.prefetchZoom = zoom;
  }

  setMinimapActive(active: boolean): void {
    this.minimapActive = active;
  }

  setTextWanted(wanted: boolean): void {
    this.textWanted = wanted;
  }

  setLabelActive(active: boolean): void {
    this.labelActive = active;
  }

  prefetchScale(): number {
    return this.prefetchZoom > 0
      ? revealPrefetchScale(this.frameState, this.prefetchZoom)
      : 0;
  }

  requestScale(kind: number): number {
    return textTileRequestScale(kind, this.frameState);
  }

  setPrefetchBounds(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    this.prefetchLeft = left;
    this.prefetchTop = top;
    this.prefetchRight = right;
    this.prefetchBottom = bottom;
  }

  build(recordCount: number): void {
    this.reset();
    this.frameState.gestureTargetScale =
      this.frameState.zoom * this.frameState.devicePixelRatio;
    this.contentRequestScale = this.requestScale(CONTENT_KIND);
    const size = TILE_DEVICE_SIZE / this.contentRequestScale;
    this.setVisibleRange(size);
    this.frameState.recordCount = recordCount;
    const contentRangeEmpty =
      this.frameState.contentWidth <= 0 ||
      this.frameState.contentHeight <= 0 ||
      this.visibleLastColumn < this.visibleFirstColumn ||
      this.visibleLastRow < this.visibleFirstRow;
    if (!contentRangeEmpty) {
      this.buildRequests(size);
      this.drawSet.build(CONTENT_KIND);
    }
    this.buildHeaderRequests();
    this.requestLabel = this.minimapActive && this.labelActive;
    this.drawSet.build(HEADER_KIND);
    this.drawSet.build(LABEL_KIND);
  }

  isRequested(
    rasterScale: number,
    column: number,
    row: number,
    epoch: number,
  ): boolean {
    if (epoch !== this.frameState.epoch) return false;
    for (let index = 0; index < this.requestCount; index += 1) {
      if (
        this.requestScales[index] === rasterScale &&
        this.requestColumns[index] === column &&
        this.requestRows[index] === row
      )
        return true;
    }
    return false;
  }

  exactVisibleReady(): boolean {
    return this.drawSet.exactVisibleReady(this.contentRequestScale);
  }

  textReady(): boolean {
    return this.drawSet.textReady();
  }

  private reset(): void {
    this.requestCount = 0;
    this.requestHeaderCount = 0;
    this.requestLabel = false;
    this.drawSet.reset();
  }

  private setVisibleRange(size: number): void {
    this.setVisibleColumnRange(size);
    this.frameState.visibleFirstColumn = this.columnRangeFirst;
    this.frameState.visibleLastColumn = this.columnRangeLast;
    this.frameState.visibleFirstRow = Math.max(
      0,
      Math.floor(this.frameState.visibleTop / size),
    );
    this.frameState.visibleLastRow = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentHeight / size) - 1),
      Math.floor(
        Math.max(
          this.frameState.visibleTop,
          exclusiveEnd(this.frameState.visibleBottom),
        ) / size,
      ),
    );
  }

  private buildRequests(size: number): void {
    this.drawSet.setCoverageKind(CONTENT_KIND);
    this.setCoverageWindow(
      this.frameState.visibleLeft,
      this.frameState.visibleTop,
      this.frameState.visibleRight,
      this.frameState.visibleBottom,
    );
    if (this.frameState.zoomGestureActive) {
      if (!this.minimapActive || this.textWanted)
        this.buildVisibleGestureRequests(size);
      if (!this.textWanted) this.buildPrefetchRequests();
      return;
    }
    if (this.minimapActive && !this.textWanted) {
      return;
    }
    const margin = MARGIN_RING_TILES;
    const firstColumn = Math.max(0, this.visibleFirstColumn - margin);
    const lastColumn = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentWidth / size) - 1),
      this.visibleLastColumn + margin,
    );
    const firstRow = Math.max(0, this.visibleFirstRow - margin);
    const lastRow = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentHeight / size) - 1),
      this.visibleLastRow + margin,
    );
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const covered = this.drawSet.isAreaCovered(
          column * size,
          row * size,
          size,
          size,
        );
        if (
          !covered ||
          this.drawSet.findCurrent(column, row, this.contentRequestScale) < 0
        )
          this.pushRequest(column, row);
      }
    }
  }

  private buildVisibleGestureRequests(size: number): void {
    for (let row = this.visibleFirstRow; row <= this.visibleLastRow; row += 1) {
      for (
        let column = this.visibleFirstColumn;
        column <= this.visibleLastColumn;
        column += 1
      ) {
        if (
          !this.drawSet.isGestureAreaCovered(
            column * size,
            row * size,
            size,
            size,
          )
        )
          this.pushRequest(column, row, this.contentRequestScale);
      }
    }
  }

  private buildPrefetchRequests(): void {
    if (!this.prefetchActive) return;
    const rasterScale = revealPrefetchScale(this.frameState, this.prefetchZoom);
    const size = TILE_DEVICE_SIZE / rasterScale;
    this.setCoverageWindow(
      this.prefetchLeft,
      this.prefetchTop,
      this.prefetchRight,
      this.prefetchBottom,
    );
    const firstColumn = Math.max(0, Math.floor(this.prefetchLeft / size));
    const lastColumn = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentWidth / size) - 1),
      Math.floor(exclusiveEnd(this.prefetchRight) / size),
    );
    const firstRow = Math.max(0, Math.floor(this.prefetchTop / size));
    const lastRow = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentHeight / size) - 1),
      Math.floor(exclusiveEnd(this.prefetchBottom) / size),
    );
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        if (!this.drawSet.isAreaCovered(column * size, row * size, size, size))
          this.pushRequest(column, row, rasterScale);
      }
    }
    this.setCoverageWindow(
      this.frameState.visibleLeft,
      this.frameState.visibleTop,
      this.frameState.visibleRight,
      this.frameState.visibleBottom,
    );
  }

  private buildHeaderRequests(): void {
    const size = TILE_DEVICE_SIZE / this.requestScale(HEADER_KIND);
    this.setVisibleColumnRange(size);
    for (
      let column = this.columnRangeFirst;
      column <= this.columnRangeLast;
      column += 1
    ) {
      this.requestHeaderColumns[this.requestHeaderCount] = column;
      this.requestHeaderCount += 1;
    }
  }

  private pushRequest(
    column: number,
    row: number,
    rasterScale = this.contentRequestScale,
  ): void {
    if (this.requestCount >= this.requestColumns.length) return;
    for (let index = 0; index < this.requestCount; index += 1) {
      if (
        this.requestScales[index] === rasterScale &&
        this.requestColumns[index] === column &&
        this.requestRows[index] === row
      )
        return;
    }
    this.requestColumns[this.requestCount] = column;
    this.requestRows[this.requestCount] = row;
    this.requestScales[this.requestCount] = rasterScale;
    this.requestCount += 1;
  }

  private setCoverageWindow(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    this.drawSet.setCoverageWindow(left, top, right, bottom);
  }

  private setVisibleColumnRange(size: number): void {
    this.columnRangeFirst = Math.max(
      0,
      Math.floor(this.frameState.visibleLeft / size),
    );
    this.columnRangeLast = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentWidth / size) - 1),
      Math.floor(
        Math.max(
          this.frameState.visibleLeft,
          exclusiveEnd(this.frameState.visibleRight),
        ) / size,
      ),
    );
  }
}

function exclusiveEnd(value: number): number {
  return value - Math.max(1e-9, Math.abs(value) * Number.EPSILON);
}
