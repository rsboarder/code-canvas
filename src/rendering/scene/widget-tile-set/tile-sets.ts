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
export function coarseRasterScale(
  zoom: number,
  devicePixelRatio: number,
): number {
  return 2 ** Math.floor(Math.log2(zoom)) * devicePixelRatio;
}

export function gestureStepRasterScale(
  zoom: number,
  devicePixelRatio: number,
): number {
  const step = Math.floor(2 * Math.log2(zoom) + 0.5 + Number.EPSILON);
  return 2 ** (step / 2) * devicePixelRatio;
}

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

  requestedScale = 1;

  requestedHeaderScale = 1;

  requestedLabelScale = 1;

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

  private readonly drawSet: TileDrawSet;
  private readonly frameState: WidgetTileFrameState;

  private zoom = 1;

  private devicePixelRatio = 1;

  private contentRequestedScale = 1;

  private prefetchActive = false;

  private prefetchRasterScale = 0;

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
    this.zoom = zoom;
    this.devicePixelRatio = devicePixelRatio;
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

  setPrefetchRasterScale(scale: number): void {
    this.prefetchRasterScale = scale;
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
    return this.prefetchRasterScale;
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
    this.requestedScale = this.frameState.zoomGestureActive
      ? coarseRasterScale(this.zoom, this.devicePixelRatio)
      : this.zoom * this.devicePixelRatio;
    this.contentRequestedScale = this.frameState.zoomGestureActive
      ? gestureStepRasterScale(this.zoom, this.devicePixelRatio)
      : this.requestedScale;
    this.requestedHeaderScale = this.frameState.zoomGestureActive
      ? coarseRasterScale(this.zoom, this.devicePixelRatio)
      : this.zoom * this.devicePixelRatio;
    this.requestedLabelScale = this.frameState.zoomGestureActive
      ? coarseRasterScale(this.zoom, this.devicePixelRatio)
      : this.zoom * this.devicePixelRatio;
    const size = TILE_DEVICE_SIZE / this.contentRequestedScale;
    this.setVisibleRange(size);
    this.frameState.recordCount = recordCount;
    this.frameState.gestureTargetScale = this.zoom * this.devicePixelRatio;
    const contentRangeEmpty =
      this.frameState.contentWidth <= 0 ||
      this.frameState.contentHeight <= 0 ||
      this.visibleLastColumn < this.visibleFirstColumn ||
      this.visibleLastRow < this.visibleFirstRow;
    if (!contentRangeEmpty) {
      this.buildRequests(size);
      this.drawSet.build(CONTENT_KIND, size);
    }
    this.buildHeaderRequests();
    this.requestLabel = this.minimapActive && this.labelActive;
    this.drawSet.build(
      HEADER_KIND,
      TILE_DEVICE_SIZE / this.requestedHeaderScale,
    );
    this.drawSet.build(LABEL_KIND, TILE_DEVICE_SIZE / this.requestedLabelScale);
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
    return this.drawSet.exactVisibleReady(this.contentRequestedScale);
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
    this.frameState.visibleFirstColumn = Math.max(
      0,
      Math.floor(this.frameState.visibleLeft / size),
    );
    this.frameState.visibleLastColumn = Math.min(
      Math.max(0, Math.ceil(this.frameState.contentWidth / size) - 1),
      Math.floor(
        Math.max(
          this.frameState.visibleLeft,
          exclusiveEnd(this.frameState.visibleRight),
        ) / size,
      ),
    );
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
          this.drawSet.findCurrent(column, row, this.requestedScale) < 0
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
          this.pushRequest(column, row, this.contentRequestedScale);
      }
    }
  }

  private buildPrefetchRequests(): void {
    if (!this.prefetchActive) return;
    const requestScale =
      this.prefetchRasterScale > 0
        ? this.prefetchRasterScale
        : this.requestedScale;
    const size = TILE_DEVICE_SIZE / requestScale;
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
          this.pushRequest(column, row, requestScale);
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
    for (
      let column = this.visibleFirstColumn;
      column <= this.visibleLastColumn;
      column += 1
    ) {
      this.requestHeaderColumns[this.requestHeaderCount] = column;
      this.requestHeaderCount += 1;
    }
  }

  private pushRequest(
    column: number,
    row: number,
    rasterScale = this.requestedScale,
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
}

function exclusiveEnd(value: number): number {
  return value - Math.max(1e-9, Math.abs(value) * Number.EPSILON);
}
