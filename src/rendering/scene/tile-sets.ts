import { TILE_DEVICE_SIZE } from "./tile-plan";
import { TileDrawSet } from "./tile-draw-set";
import { LABEL_KIND, type TileSetRecordArrays } from "./tile-records";

export type { TileSetRecordArrays } from "./tile-records";

const CONTENT_KIND = 0;
const HEADER_KIND = 1;
const MARGIN_RING_TILES = 1;

export function coarseRasterScale(
  zoom: number,
  devicePixelRatio: number,
): number {
  return 2 ** Math.floor(Math.log2(zoom)) * devicePixelRatio;
}

interface ZoomViewBoundsInput {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly currentZoom: number;
  readonly targetZoom: number;
  readonly focusX: number;
  readonly focusY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

interface ZoomViewBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function viewBoundsAtZoom(input: ZoomViewBoundsInput): ZoomViewBounds {
  const focusWorldX = (input.focusX - input.cameraOffsetX) / input.currentZoom;
  const focusWorldY = (input.focusY - input.cameraOffsetY) / input.currentZoom;
  return {
    left: focusWorldX - input.focusX / input.targetZoom,
    top: focusWorldY - input.focusY / input.targetZoom,
    right:
      focusWorldX + (input.viewportWidth - input.focusX) / input.targetZoom,
    bottom:
      focusWorldY + (input.viewportHeight - input.focusY) / input.targetZoom,
  };
}

export function previousPowerOfTwo(value: number): number {
  const lower = 2 ** Math.floor(Math.log2(value));
  return Math.abs(value - lower) < Number.EPSILON * Math.max(1, value)
    ? lower / 2
    : lower;
}

export class TileSetPlanner {
  readonly requestColumns: Int32Array;

  readonly requestRows: Int32Array;

  readonly requestScales: Float64Array;

  readonly requestHeaderColumns: Int32Array;

  requestLabel = false;

  readonly drawFallback: Int32Array;

  readonly drawCurrent: Int32Array;

  readonly drawHeaderFallback: Int32Array;

  readonly drawHeaderCurrent: Int32Array;

  readonly drawLabelFallback: Int32Array;

  readonly drawLabelCurrent: Int32Array;

  requestCount = 0;

  requestHeaderCount = 0;

  drawFallbackCount = 0;

  drawCurrentCount = 0;

  drawHeaderFallbackCount = 0;

  drawHeaderCurrentCount = 0;

  drawLabelFallbackCount = 0;

  drawLabelCurrentCount = 0;

  missingTile = false;

  requestedScale = 1;

  requestedHeaderScale = 1;

  requestedLabelScale = 1;

  atRestScale = 1;

  requestedEpoch = 0;

  visibleFirstColumn = 0;

  visibleLastColumn = -1;

  visibleFirstRow = 0;

  visibleLastRow = -1;

  private readonly drawSet: TileDrawSet;

  private contentWidth = 0;

  private contentHeight = 0;

  private visibleLeft = 0;

  private visibleTop = 0;

  private visibleRight = 0;

  private visibleBottom = 0;

  private zoom = 1;

  private devicePixelRatio = 1;

  private zoomGestureActive = false;

  private epoch = 0;

  private prefetchActive = false;

  private prefetchRasterScale = 0;

  private minimapActive = false;

  private textWanted = false;

  private prefetchLeft = 0;

  private prefetchTop = 0;

  private prefetchRight = 0;

  private prefetchBottom = 0;

  constructor(records: TileSetRecordArrays, capacity: number) {
    this.drawSet = new TileDrawSet(records, capacity);
    this.drawFallback = this.drawSet.drawFallback;
    this.drawCurrent = this.drawSet.drawCurrent;
    this.drawHeaderFallback = this.drawSet.drawHeaderFallback;
    this.drawHeaderCurrent = this.drawSet.drawHeaderCurrent;
    this.drawLabelFallback = this.drawSet.drawLabelFallback;
    this.drawLabelCurrent = this.drawSet.drawLabelCurrent;
    this.requestColumns = new Int32Array(capacity);
    this.requestRows = new Int32Array(capacity);
    this.requestScales = new Float64Array(capacity);
    this.requestHeaderColumns = new Int32Array(capacity);
  }

  setContentSize(width: number, height: number): void {
    this.contentWidth = width;
    this.contentHeight = height;
    this.drawSet.setContentSize(width, height);
  }

  setHeaderHeight(height: number): void {
    this.drawSet.setHeaderHeight(height);
  }

  setVisibleBounds(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    this.visibleLeft = left;
    this.visibleTop = top;
    this.visibleRight = right;
    this.visibleBottom = bottom;
    this.drawSet.setVisibleBounds(left, top, right, bottom);
  }

  setZoom(
    zoom: number,
    devicePixelRatio: number,
    gestureActive: boolean,
  ): void {
    this.zoom = zoom;
    this.devicePixelRatio = devicePixelRatio;
    this.zoomGestureActive = gestureActive;
  }

  setEpoch(epoch: number): void {
    this.epoch = epoch;
    this.drawSet.setEpoch(epoch);
  }

  setAtRestScale(scale: number): void {
    this.atRestScale = scale;
    this.drawSet.setAtRestScale(scale);
  }

  setLabelIdentity(identity: string): void {
    this.drawSet.setLabelIdentity(identity);
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
    this.requestedScale = this.zoomGestureActive
      ? coarseRasterScale(this.zoom, this.devicePixelRatio)
      : this.zoom * this.devicePixelRatio;
    this.requestedHeaderScale = this.zoomGestureActive
      ? coarseRasterScale(this.zoom, this.devicePixelRatio)
      : this.zoom * this.devicePixelRatio;
    this.requestedLabelScale = this.zoomGestureActive
      ? coarseRasterScale(this.zoom, this.devicePixelRatio)
      : this.zoom * this.devicePixelRatio;
    this.requestedEpoch = this.epoch;
    const size = TILE_DEVICE_SIZE / this.requestedScale;
    this.setVisibleRange(size);
    this.drawSet.setRecordCount(recordCount);
    this.drawSet.setEpoch(this.requestedEpoch);
    this.drawSet.setAtRestScale(this.atRestScale);
    if (this.visibleLastColumn < this.visibleFirstColumn) return;
    if (this.visibleLastRow < this.visibleFirstRow) return;
    this.buildRequests(size);
    this.drawSet.build(CONTENT_KIND, size, this.drawFallback, this.drawCurrent);
    this.drawSet.build(
      HEADER_KIND,
      TILE_DEVICE_SIZE / this.requestedHeaderScale,
      this.drawHeaderFallback,
      this.drawHeaderCurrent,
    );
    this.drawSet.build(
      LABEL_KIND,
      TILE_DEVICE_SIZE / this.requestedLabelScale,
      this.drawLabelFallback,
      this.drawLabelCurrent,
    );
    this.drawFallbackCount = this.drawSet.drawFallbackCount;
    this.drawCurrentCount = this.drawSet.drawCurrentCount;
    this.drawHeaderFallbackCount = this.drawSet.drawHeaderFallbackCount;
    this.drawHeaderCurrentCount = this.drawSet.drawHeaderCurrentCount;
    this.drawLabelFallbackCount = this.drawSet.drawLabelFallbackCount;
    this.drawLabelCurrentCount = this.drawSet.drawLabelCurrentCount;
    this.missingTile = this.drawSet.missingTile;
  }

  isRequested(
    rasterScale: number,
    column: number,
    row: number,
    epoch: number,
  ): boolean {
    if (epoch !== this.requestedEpoch) return false;
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
    return this.drawSet.exactVisibleReady(this.requestedScale);
  }

  textReady(): boolean {
    return this.drawSet.textReady();
  }

  private reset(): void {
    this.requestCount = 0;
    this.requestHeaderCount = 0;
    this.requestLabel = false;
    this.drawFallbackCount = 0;
    this.drawCurrentCount = 0;
    this.drawHeaderFallbackCount = 0;
    this.drawHeaderCurrentCount = 0;
    this.drawLabelFallbackCount = 0;
    this.drawLabelCurrentCount = 0;
    this.missingTile = false;
    this.drawSet.reset();
  }

  private setVisibleRange(size: number): void {
    this.visibleFirstColumn = Math.max(0, Math.floor(this.visibleLeft / size));
    this.visibleLastColumn = Math.min(
      Math.max(0, Math.ceil(this.contentWidth / size) - 1),
      Math.floor(
        Math.max(this.visibleLeft, exclusiveEnd(this.visibleRight)) / size,
      ),
    );
    this.visibleFirstRow = Math.max(0, Math.floor(this.visibleTop / size));
    this.visibleLastRow = Math.min(
      Math.max(0, Math.ceil(this.contentHeight / size) - 1),
      Math.floor(
        Math.max(this.visibleTop, exclusiveEnd(this.visibleBottom)) / size,
      ),
    );
    this.drawSet.setVisibleRange(
      this.visibleFirstColumn,
      this.visibleLastColumn,
      this.visibleFirstRow,
      this.visibleLastRow,
    );
  }

  private buildRequests(size: number): void {
    this.drawSet.setCoverageKind(CONTENT_KIND);
    this.setCoverageWindow(
      this.visibleLeft,
      this.visibleTop,
      this.visibleRight,
      this.visibleBottom,
    );
    if (this.zoomGestureActive) {
      if (!this.minimapActive || this.textWanted)
        this.buildVisibleGestureRequests(size);
      if (!this.textWanted) this.buildPrefetchRequests(size);
      this.buildHeaderRequests();
      this.requestLabel = this.minimapActive;
      return;
    }
    if (this.minimapActive && !this.textWanted) {
      this.buildHeaderRequests();
      this.requestLabel = true;
      return;
    }
    const margin = MARGIN_RING_TILES;
    const firstColumn = Math.max(0, this.visibleFirstColumn - margin);
    const lastColumn = Math.min(
      Math.max(0, Math.ceil(this.contentWidth / size) - 1),
      this.visibleLastColumn + margin,
    );
    const firstRow = Math.max(0, this.visibleFirstRow - margin);
    const lastRow = Math.min(
      Math.max(0, Math.ceil(this.contentHeight / size) - 1),
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
    this.buildHeaderRequests();
    this.requestLabel = this.minimapActive;
  }

  private buildVisibleGestureRequests(size: number): void {
    for (let row = this.visibleFirstRow; row <= this.visibleLastRow; row += 1) {
      for (
        let column = this.visibleFirstColumn;
        column <= this.visibleLastColumn;
        column += 1
      ) {
        if (!this.drawSet.isAreaCovered(column * size, row * size, size, size))
          this.pushRequest(column, row);
      }
    }
  }

  private buildPrefetchRequests(size: number): void {
    if (!this.prefetchActive) return;
    const requestScale =
      this.prefetchRasterScale > 0
        ? this.prefetchRasterScale
        : this.requestedScale;
    this.setCoverageWindow(
      this.prefetchLeft,
      this.prefetchTop,
      this.prefetchRight,
      this.prefetchBottom,
    );
    const firstColumn = Math.max(0, Math.floor(this.prefetchLeft / size));
    const lastColumn = Math.min(
      Math.max(0, Math.ceil(this.contentWidth / size) - 1),
      Math.floor(exclusiveEnd(this.prefetchRight) / size),
    );
    const firstRow = Math.max(0, Math.floor(this.prefetchTop / size));
    const lastRow = Math.min(
      Math.max(0, Math.ceil(this.contentHeight / size) - 1),
      Math.floor(exclusiveEnd(this.prefetchBottom) / size),
    );
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        if (!this.drawSet.isAreaCovered(column * size, row * size, size, size))
          this.pushRequest(column, row, requestScale);
      }
    }
    this.setCoverageWindow(
      this.visibleLeft,
      this.visibleTop,
      this.visibleRight,
      this.visibleBottom,
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
