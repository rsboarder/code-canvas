import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  type TileSetRecordArrays,
} from "./tile-records";
import type { WidgetTileFrameState } from "./frame-state";

const ANY_READY = 0;
const GESTURE_CLOSE = 1;
const CURRENT_EPOCH = 2;
const BETTER_THAN = 3;

export class TileDrawSet {
  readonly drawFallback: Int32Array;

  readonly drawCurrent: Int32Array;

  readonly drawHeaderFallback: Int32Array;

  readonly drawHeaderCurrent: Int32Array;

  readonly drawLabelFallback: Int32Array;

  readonly drawLabelCurrent: Int32Array;

  drawFallbackCount = 0;

  drawCurrentCount = 0;

  drawHeaderFallbackCount = 0;

  drawHeaderCurrentCount = 0;

  drawLabelFallbackCount = 0;

  drawLabelCurrentCount = 0;

  missingTile = false;

  private readonly records: TileSetRecordArrays;

  private readonly frameState: WidgetTileFrameState;

  private coverageKind = CONTENT_KIND;

  private coverageWindowLeft = 0;

  private coverageWindowTop = 0;

  private coverageWindowRight = 0;

  private coverageWindowBottom = 0;

  private coverageLeft = 0;

  private coverageTop = 0;

  private coverageRight = 0;

  private coverageBottom = 0;

  constructor(
    records: TileSetRecordArrays,
    capacity: number,
    frameState: WidgetTileFrameState,
  ) {
    this.records = records;
    this.frameState = frameState;
    this.drawFallback = new Int32Array(capacity);
    this.drawCurrent = new Int32Array(capacity);
    this.drawHeaderFallback = new Int32Array(capacity);
    this.drawHeaderCurrent = new Int32Array(capacity);
    this.drawLabelFallback = new Int32Array(capacity);
    this.drawLabelCurrent = new Int32Array(capacity);
  }

  private currentTarget(kind: number): Int32Array {
    if (kind === HEADER_KIND) return this.drawHeaderCurrent;
    if (kind === LABEL_KIND) return this.drawLabelCurrent;
    return this.drawCurrent;
  }

  private fallbackTarget(kind: number): Int32Array {
    if (kind === HEADER_KIND) return this.drawHeaderFallback;
    if (kind === LABEL_KIND) return this.drawLabelFallback;
    return this.drawFallback;
  }

  reset(): void {
    this.drawFallbackCount = 0;
    this.drawCurrentCount = 0;
    this.drawHeaderFallbackCount = 0;
    this.drawHeaderCurrentCount = 0;
    this.drawLabelFallbackCount = 0;
    this.drawLabelCurrentCount = 0;
    this.missingTile = false;
  }

  build(kind: number, size: number): void {
    const current = this.currentTarget(kind);
    const fallback = this.fallbackTarget(kind);
    const extentHeight =
      kind === HEADER_KIND
        ? this.frameState.headerHeight
        : this.frameState.contentHeight;
    if (kind !== LABEL_KIND && extentHeight <= 0) return;
    this.coverageKind = kind;
    this.setCoverageWindow(
      this.frameState.visibleLeft,
      kind === HEADER_KIND ? 0 : this.frameState.visibleTop,
      this.frameState.visibleRight,
      kind === HEADER_KIND ? extentHeight : this.frameState.visibleBottom,
    );
    const firstRow = kind === HEADER_KIND ? 0 : this.frameState.visibleFirstRow;
    const lastRow = kind === HEADER_KIND ? 0 : this.frameState.visibleLastRow;
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (
        let column = this.frameState.visibleFirstColumn;
        column <= this.frameState.visibleLastColumn;
        column += 1
      ) {
        if (
          kind === CONTENT_KIND &&
          !this.isAreaCovered(column * size, row * size, size, size)
        )
          this.missingTile = true;
      }
    }
    this.addAtRestRecords(kind, current);
    this.addFallbackRecords(kind, fallback);
  }

  isAreaCovered(x: number, y: number, width: number, height: number): boolean {
    if (!this.clipArea(x, y, width, height)) return false;
    return this.sampleCoverage(ANY_READY);
  }

  isGestureAreaCovered(
    x: number,
    y: number,
    width: number,
    height: number,
  ): boolean {
    if (!this.clipArea(x, y, width, height)) return false;
    return this.sampleCoverage(GESTURE_CLOSE);
  }

  findCurrent(column: number, row: number, rasterScale: number): number {
    for (let index = 0; index < this.frameState.recordCount; index += 1) {
      if (
        this.records.active[index] &&
        this.records.ready[index] &&
        this.records.kind[index] === CONTENT_KIND &&
        this.records.epoch[index] === this.frameState.epoch &&
        this.records.rasterScale[index] === rasterScale &&
        this.records.column[index] === column &&
        this.records.row[index] === row
      )
        return index;
    }
    return -1;
  }

  exactVisibleReady(rasterScale: number): boolean {
    if (this.frameState.visibleLastColumn < this.frameState.visibleFirstColumn)
      return true;
    if (this.frameState.visibleLastRow < this.frameState.visibleFirstRow)
      return true;
    for (
      let row = this.frameState.visibleFirstRow;
      row <= this.frameState.visibleLastRow;
      row += 1
    ) {
      for (
        let column = this.frameState.visibleFirstColumn;
        column <= this.frameState.visibleLastColumn;
        column += 1
      ) {
        if (this.findCurrent(column, row, rasterScale) < 0) return false;
      }
    }
    return true;
  }

  textReady(): boolean {
    if (this.frameState.visibleLastColumn < this.frameState.visibleFirstColumn)
      return true;
    if (this.frameState.visibleLastRow < this.frameState.visibleFirstRow)
      return true;
    this.coverageKind = CONTENT_KIND;
    this.setCoverageWindow(
      this.frameState.visibleLeft,
      this.frameState.visibleTop,
      this.frameState.visibleRight,
      this.frameState.visibleBottom,
    );
    if (
      !this.clipArea(
        this.frameState.visibleLeft,
        this.frameState.visibleTop,
        this.frameState.visibleRight - this.frameState.visibleLeft,
        this.frameState.visibleBottom - this.frameState.visibleTop,
      )
    )
      return true;
    return this.sampleCoverage(CURRENT_EPOCH);
  }

  setCoverageKind(kind: number): void {
    this.coverageKind = kind;
  }

  setCoverageWindow(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    this.coverageWindowLeft = left;
    this.coverageWindowTop = top;
    this.coverageWindowRight = right;
    this.coverageWindowBottom = bottom;
  }

  private addAtRestRecords(kind: number, current: Int32Array): void {
    for (let index = 0; index < this.frameState.recordCount; index += 1) {
      if (
        !this.shouldAddCurrentRecord(index, kind) ||
        !this.overlapsVisible(index)
      )
        continue;
      this.pushUnique(current, kind, index);
    }
    if (kind !== CONTENT_KIND || !this.frameState.zoomGestureActive) return;
    for (let index = 0; index < this.frameState.recordCount; index += 1) {
      if (!this.shouldAddGestureCurrent(index)) continue;
      this.pushSortedGestureCurrent(current, index);
    }
  }

  private shouldAddCurrentRecord(index: number, kind: number): boolean {
    if (!this.records.active[index] || !this.records.ready[index]) return false;
    if (this.records.kind[index] !== kind) return false;
    if (kind === LABEL_KIND && !this.isCurrentLabel(index)) return false;
    if (
      kind === CONTENT_KIND &&
      this.records.epoch[index] !== this.frameState.epoch
    )
      return false;
    return this.records.rasterScale[index] === this.frameState.atRestScale;
  }

  private shouldAddGestureCurrent(index: number): boolean {
    return (
      this.records.rasterScale[index] !== this.frameState.atRestScale &&
      this.records.epoch[index] === this.frameState.epoch &&
      this.records.active[index] === 1 &&
      this.records.ready[index] === 1 &&
      this.records.kind[index] === CONTENT_KIND &&
      this.overlapsVisible(index) &&
      this.hasBetterCurrentOverlap(index)
    );
  }

  private addFallbackRecords(kind: number, fallback: Int32Array): void {
    for (let index = 0; index < this.frameState.recordCount; index += 1) {
      if (
        !this.records.active[index] ||
        !this.records.ready[index] ||
        this.records.kind[index] !== kind ||
        this.isTopRecord(index, kind) ||
        !this.overlapsVisible(index) ||
        !this.needsFallback(index)
      )
        continue;
      this.pushSortedFallback(fallback, kind, index);
    }
  }

  private overlapsVisible(index: number): boolean {
    return (
      (this.records.localX[index] ?? 0) < this.frameState.visibleRight &&
      (this.records.localX[index] ?? 0) + (this.records.width[index] ?? 0) >
        this.frameState.visibleLeft &&
      (this.records.localY[index] ?? 0) < this.frameState.visibleBottom &&
      (this.records.localY[index] ?? 0) + (this.records.height[index] ?? 0) >
        this.frameState.visibleTop
    );
  }

  private isTopRecord(index: number, kind: number): boolean {
    if (!this.isCurrentDrawRecord(index, kind)) return false;
    for (
      let candidate = 0;
      candidate < this.frameState.recordCount;
      candidate += 1
    ) {
      if (
        candidate !== index &&
        this.records.active[candidate] &&
        this.records.ready[candidate] &&
        this.records.kind[candidate] === kind &&
        this.overlapsRecords(index, candidate) &&
        this.isBetterRecord(candidate, index)
      )
        return false;
    }
    return true;
  }

  private isCurrentDrawRecord(index: number, kind: number): boolean {
    if (this.records.kind[index] !== kind) return false;
    if (kind === LABEL_KIND && !this.isCurrentLabel(index)) return false;
    if (
      kind === CONTENT_KIND &&
      this.records.epoch[index] !== this.frameState.epoch
    )
      return false;
    if (this.records.rasterScale[index] === this.frameState.atRestScale)
      return true;
    return kind === CONTENT_KIND && this.frameState.zoomGestureActive
      ? this.shouldDrawCurrentGesture(index)
      : false;
  }

  private isCurrentLabel(index: number): boolean {
    return (
      this.frameState.labelIdentity === undefined ||
      this.records.labelIdentity === undefined ||
      this.records.labelIdentity[index] === this.frameState.labelIdentity
    );
  }

  private shouldDrawCurrentGesture(index: number): boolean {
    for (let current = 0; current < this.drawCurrentCount; current += 1) {
      if (this.drawCurrent[current] === index) return true;
    }
    return false;
  }

  private hasBetterCurrentOverlap(index: number): boolean {
    for (let current = 0; current < this.drawCurrentCount; current += 1) {
      const candidate = this.drawCurrent[current] ?? -1;
      if (
        candidate >= 0 &&
        this.overlapsRecords(index, candidate) &&
        this.isBetterRecord(index, candidate)
      )
        return true;
    }
    return false;
  }

  private overlapsRecords(first: number, second: number): boolean {
    return (
      this.overlapsAxis(first, second, true) &&
      this.overlapsAxis(first, second, false)
    );
  }

  private overlapsAxis(
    first: number,
    second: number,
    horizontal: boolean,
  ): boolean {
    const firstPosition = horizontal
      ? (this.records.localX[first] ?? 0)
      : (this.records.localY[first] ?? 0);
    const secondPosition = horizontal
      ? (this.records.localX[second] ?? 0)
      : (this.records.localY[second] ?? 0);
    const firstSize = horizontal
      ? (this.records.width[first] ?? 0)
      : (this.records.height[first] ?? 0);
    const secondSize = horizontal
      ? (this.records.width[second] ?? 0)
      : (this.records.height[second] ?? 0);
    return (
      firstPosition < secondPosition + secondSize &&
      firstPosition + firstSize > secondPosition
    );
  }

  private sampleCoverage(mode: number, candidate = -1): boolean {
    const left = this.coverageLeft;
    const top = this.coverageTop;
    const right = this.coverageRight;
    const bottom = this.coverageBottom;
    return (
      this.sampleCoveragePoint(mode, candidate, left, top) &&
      this.sampleCoveragePoint(mode, candidate, right, top) &&
      this.sampleCoveragePoint(mode, candidate, left, bottom) &&
      this.sampleCoveragePoint(mode, candidate, right, bottom) &&
      this.sampleCoveragePoint(
        mode,
        candidate,
        left + (right - left) / 2,
        top + (bottom - top) / 2,
      )
    );
  }

  private sampleCoveragePoint(
    mode: number,
    candidate: number,
    x: number,
    y: number,
  ): boolean {
    for (let index = 0; index < this.frameState.recordCount; index += 1) {
      if (
        !this.records.active[index] ||
        !this.records.ready[index] ||
        this.records.kind[index] !== this.coverageKind ||
        !this.matchesSampleMode(index, mode, candidate)
      )
        continue;
      if (this.containsPoint(index, x, y)) return true;
    }
    return false;
  }

  private matchesSampleMode(
    index: number,
    mode: number,
    candidate: number,
  ): boolean {
    if (mode === GESTURE_CLOSE)
      return (
        this.coverageKind === CONTENT_KIND &&
        this.records.epoch[index] === this.frameState.epoch &&
        rasterScaleMismatch(
          this.records.rasterScale[index] ?? 0,
          this.frameState.gestureTargetScale,
        ) <= Math.SQRT2
      );
    if (mode === CURRENT_EPOCH)
      return (
        this.coverageKind === CONTENT_KIND &&
        this.records.epoch[index] === this.frameState.epoch
      );
    return mode !== BETTER_THAN || this.isBetterRecord(index, candidate);
  }

  private needsFallback(index: number): boolean {
    if (
      !this.clipArea(
        this.records.localX[index] ?? 0,
        this.records.localY[index] ?? 0,
        this.records.width[index] ?? 0,
        this.records.height[index] ?? 0,
      )
    )
      return false;
    return !this.sampleCoverage(BETTER_THAN, index);
  }

  private containsPoint(index: number, x: number, y: number): boolean {
    return (
      (this.records.localX[index] ?? 0) <= x &&
      (this.records.localY[index] ?? 0) <= y &&
      (this.records.localX[index] ?? 0) + (this.records.width[index] ?? 0) >=
        x &&
      (this.records.localY[index] ?? 0) + (this.records.height[index] ?? 0) >= y
    );
  }

  private isBetterRecord(first: number, second: number): boolean {
    if (this.records.kind[first] === LABEL_KIND) {
      const firstCurrent = this.isCurrentLabel(first);
      const secondCurrent = this.isCurrentLabel(second);
      if (firstCurrent !== secondCurrent) return firstCurrent;
    }
    if (this.records.kind[first] === CONTENT_KIND)
      return this.isBetterContentRecord(first, second);
    return this.isBetterScaleRecord(first, second);
  }

  private isBetterContentRecord(first: number, second: number): boolean {
    const firstEpoch = this.records.epoch[first] ?? 0;
    const secondEpoch = this.records.epoch[second] ?? 0;
    if (firstEpoch !== secondEpoch) return firstEpoch > secondEpoch;
    if (this.frameState.zoomGestureActive) {
      const firstMismatch = rasterScaleMismatch(
        this.records.rasterScale[first] ?? 0,
        this.frameState.gestureTargetScale,
      );
      const secondMismatch = rasterScaleMismatch(
        this.records.rasterScale[second] ?? 0,
        this.frameState.gestureTargetScale,
      );
      if (firstMismatch !== secondMismatch)
        return firstMismatch < secondMismatch;
      return (
        (this.records.rasterScale[first] ?? 0) >
        (this.records.rasterScale[second] ?? 0)
      );
    }
    return this.isBetterScaleRecord(first, second);
  }

  private isBetterScaleRecord(first: number, second: number): boolean {
    const firstAtRest =
      (this.records.rasterScale[first] ?? 0) === this.frameState.atRestScale;
    const secondAtRest =
      (this.records.rasterScale[second] ?? 0) === this.frameState.atRestScale;
    if (firstAtRest !== secondAtRest) return firstAtRest;
    return (
      (this.records.rasterScale[first] ?? 0) >
      (this.records.rasterScale[second] ?? 0)
    );
  }

  private pushSortedFallback(
    target: Int32Array,
    kind: number,
    recordIndex: number,
  ): void {
    const count =
      kind === HEADER_KIND
        ? this.drawHeaderFallbackCount
        : kind === LABEL_KIND
          ? this.drawLabelFallbackCount
          : this.drawFallbackCount;
    if (count >= target.length) return;
    let position = count;
    while (
      position > 0 &&
      this.shouldDrawBefore(recordIndex, target[position - 1] ?? -1)
    ) {
      target[position] = target[position - 1] ?? -1;
      position -= 1;
    }
    target[position] = recordIndex;
    if (kind === HEADER_KIND) this.drawHeaderFallbackCount += 1;
    else if (kind === LABEL_KIND) this.drawLabelFallbackCount += 1;
    else this.drawFallbackCount += 1;
  }

  private shouldDrawBefore(first: number, second: number): boolean {
    if (second < 0) return false;
    return this.isBetterRecord(second, first);
  }

  private pushUnique(
    target: Int32Array,
    kind: number,
    recordIndex: number,
  ): void {
    const count =
      kind === HEADER_KIND
        ? this.drawHeaderCurrentCount
        : kind === LABEL_KIND
          ? this.drawLabelCurrentCount
          : this.drawCurrentCount;
    for (let index = 0; index < count; index += 1) {
      if (target[index] === recordIndex) return;
    }
    if (count >= target.length) return;
    target[count] = recordIndex;
    if (kind === HEADER_KIND) this.drawHeaderCurrentCount += 1;
    else if (kind === LABEL_KIND) this.drawLabelCurrentCount += 1;
    else this.drawCurrentCount += 1;
  }

  private clipArea(
    x: number,
    y: number,
    width: number,
    height: number,
  ): boolean {
    const extentHeight =
      this.coverageKind === HEADER_KIND
        ? this.frameState.headerHeight
        : this.frameState.contentHeight;
    this.coverageLeft = Math.max(x, 0, this.coverageWindowLeft);
    this.coverageTop = Math.max(y, 0, this.coverageWindowTop);
    this.coverageRight = Math.min(
      x + width,
      this.frameState.contentWidth,
      this.coverageWindowRight,
    );
    this.coverageBottom = Math.min(
      y + height,
      extentHeight,
      this.coverageWindowBottom,
    );
    return (
      this.coverageRight > this.coverageLeft &&
      this.coverageBottom > this.coverageTop
    );
  }

  private pushSortedGestureCurrent(
    target: Int32Array,
    recordIndex: number,
  ): void {
    if (this.drawCurrentCount >= target.length) return;
    let position = this.drawCurrentCount;
    while (
      position > 0 &&
      this.isBetterRecord(target[position - 1] ?? -1, recordIndex)
    ) {
      target[position] = target[position - 1] ?? -1;
      position -= 1;
    }
    target[position] = recordIndex;
    this.drawCurrentCount += 1;
  }
}

function rasterScaleMismatch(scale: number, target: number): number {
  return Math.max(scale / target, target / scale);
}
