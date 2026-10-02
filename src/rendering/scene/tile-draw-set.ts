import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  type TileSetRecordArrays,
} from "./tile-records";

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

  private recordCount = 0;

  private contentWidth = 0;

  private contentHeight = 0;

  private headerHeight = 0;

  private visibleLeft = 0;

  private visibleTop = 0;

  private visibleRight = 0;

  private visibleBottom = 0;

  private visibleFirstColumn = 0;

  private visibleLastColumn = -1;

  private visibleFirstRow = 0;

  private visibleLastRow = -1;

  private requestedEpoch = 0;

  private atRestScale = 1;

  private requestedLabelIdentity: string | undefined;

  private coverageKind = CONTENT_KIND;

  private coverageWindowLeft = 0;

  private coverageWindowTop = 0;

  private coverageWindowRight = 0;

  private coverageWindowBottom = 0;

  private coverageWidth = 0;

  private coverageHeight = 0;

  constructor(records: TileSetRecordArrays, capacity: number) {
    this.records = records;
    this.drawFallback = new Int32Array(capacity);
    this.drawCurrent = new Int32Array(capacity);
    this.drawHeaderFallback = new Int32Array(capacity);
    this.drawHeaderCurrent = new Int32Array(capacity);
    this.drawLabelFallback = new Int32Array(capacity);
    this.drawLabelCurrent = new Int32Array(capacity);
  }

  setContentSize(width: number, height: number): void {
    this.contentWidth = width;
    this.contentHeight = height;
  }

  setHeaderHeight(height: number): void {
    this.headerHeight = height;
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
  }

  setVisibleRange(
    firstColumn: number,
    lastColumn: number,
    firstRow: number,
    lastRow: number,
  ): void {
    this.visibleFirstColumn = firstColumn;
    this.visibleLastColumn = lastColumn;
    this.visibleFirstRow = firstRow;
    this.visibleLastRow = lastRow;
  }

  setEpoch(epoch: number): void {
    this.requestedEpoch = epoch;
  }

  setAtRestScale(scale: number): void {
    this.atRestScale = scale;
  }

  setLabelIdentity(identity: string): void {
    this.requestedLabelIdentity = identity;
  }

  setCoverageKind(kind: number): void {
    this.coverageKind = kind;
  }

  setRecordCount(recordCount: number): void {
    this.recordCount = recordCount;
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

  build(
    kind: number,
    size: number,
    fallback: Int32Array,
    current: Int32Array,
  ): void {
    const extentHeight =
      kind === HEADER_KIND ? this.headerHeight : this.contentHeight;
    if (extentHeight <= 0) return;
    this.coverageKind = kind;
    this.setCoverageWindow(
      this.visibleLeft,
      kind === HEADER_KIND ? 0 : this.visibleTop,
      this.visibleRight,
      kind === HEADER_KIND ? extentHeight : this.visibleBottom,
    );
    const firstRow = kind === HEADER_KIND ? 0 : this.visibleFirstRow;
    const lastRow = kind === HEADER_KIND ? 0 : this.visibleLastRow;
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (
        let column = this.visibleFirstColumn;
        column <= this.visibleLastColumn;
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
    const left = Math.max(x, 0, this.coverageWindowLeft);
    const top = Math.max(y, 0, this.coverageWindowTop);
    const right = Math.min(
      x + width,
      this.contentWidth,
      this.coverageWindowRight,
    );
    const bottom = Math.min(
      y + height,
      this.coverageKind === HEADER_KIND
        ? this.headerHeight
        : this.contentHeight,
      this.coverageWindowBottom,
    );
    if (right <= left || bottom <= top) return false;
    this.coverageWidth = right - left;
    this.coverageHeight = bottom - top;
    return (
      this.sampleCovered(left, top) &&
      this.sampleCovered(right, top) &&
      this.sampleCovered(left, bottom) &&
      this.sampleCovered(right, bottom) &&
      this.sampleCovered(
        left + this.coverageWidth / 2,
        top + this.coverageHeight / 2,
      )
    );
  }

  findCurrent(column: number, row: number, rasterScale: number): number {
    for (let index = 0; index < this.recordCount; index += 1) {
      if (
        this.records.active[index] &&
        this.records.ready[index] &&
        this.records.kind[index] === CONTENT_KIND &&
        this.records.epoch[index] === this.requestedEpoch &&
        this.records.rasterScale[index] === rasterScale &&
        this.records.column[index] === column &&
        this.records.row[index] === row
      )
        return index;
    }
    return -1;
  }

  exactVisibleReady(rasterScale: number): boolean {
    if (this.visibleLastColumn < this.visibleFirstColumn) return true;
    if (this.visibleLastRow < this.visibleFirstRow) return true;
    for (let row = this.visibleFirstRow; row <= this.visibleLastRow; row += 1) {
      for (
        let column = this.visibleFirstColumn;
        column <= this.visibleLastColumn;
        column += 1
      ) {
        if (this.findCurrent(column, row, rasterScale) < 0) return false;
      }
    }
    return true;
  }

  textReady(): boolean {
    if (this.visibleLastColumn < this.visibleFirstColumn) return true;
    if (this.visibleLastRow < this.visibleFirstRow) return true;
    this.setCoverageWindow(
      this.visibleLeft,
      this.visibleTop,
      this.visibleRight,
      this.visibleBottom,
    );
    const left = Math.max(this.visibleLeft, 0);
    const top = Math.max(this.visibleTop, 0);
    const right = Math.min(this.visibleRight, this.contentWidth);
    const bottom = Math.min(this.visibleBottom, this.contentHeight);
    if (right <= left || bottom <= top) return true;
    return (
      this.sampleCurrentCovered(left, top) &&
      this.sampleCurrentCovered(right, top) &&
      this.sampleCurrentCovered(left, bottom) &&
      this.sampleCurrentCovered(right, bottom) &&
      this.sampleCurrentCovered(
        left + (right - left) / 2,
        top + (bottom - top) / 2,
      )
    );
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
    for (let index = 0; index < this.recordCount; index += 1) {
      if (
        !this.records.active[index] ||
        !this.records.ready[index] ||
        this.records.kind[index] !== kind ||
        (kind === LABEL_KIND && !this.isCurrentLabel(index)) ||
        (kind === CONTENT_KIND &&
          this.records.epoch[index] !== this.requestedEpoch) ||
        this.records.rasterScale[index] !== this.atRestScale ||
        !this.overlapsVisible(index)
      )
        continue;
      this.pushUnique(
        current,
        kind === HEADER_KIND
          ? "headerCurrent"
          : kind === LABEL_KIND
            ? "labelCurrent"
            : "current",
        index,
      );
    }
  }

  private addFallbackRecords(kind: number, fallback: Int32Array): void {
    for (let index = 0; index < this.recordCount; index += 1) {
      if (
        !this.records.active[index] ||
        !this.records.ready[index] ||
        this.records.kind[index] !== kind ||
        this.isTopRecord(index, kind) ||
        !this.overlapsVisible(index) ||
        !this.needsFallback(index, kind)
      )
        continue;
      this.pushSortedFallback(fallback, index);
    }
  }

  private overlapsVisible(index: number): boolean {
    return (
      (this.records.localX[index] ?? 0) < this.visibleRight &&
      (this.records.localX[index] ?? 0) + (this.records.width[index] ?? 0) >
        this.visibleLeft &&
      (this.records.localY[index] ?? 0) < this.visibleBottom &&
      (this.records.localY[index] ?? 0) + (this.records.height[index] ?? 0) >
        this.visibleTop
    );
  }

  private isTopRecord(index: number, kind: number): boolean {
    return (
      this.records.kind[index] === kind &&
      (kind !== LABEL_KIND || this.isCurrentLabel(index)) &&
      (kind === HEADER_KIND ||
        this.records.epoch[index] === this.requestedEpoch) &&
      this.records.rasterScale[index] === this.atRestScale
    );
  }

  private isCurrentLabel(index: number): boolean {
    return (
      this.requestedLabelIdentity === undefined ||
      this.records.labelIdentity === undefined ||
      this.records.labelIdentity[index] === this.requestedLabelIdentity
    );
  }

  private sampleCovered(x: number, y: number): boolean {
    for (let index = 0; index < this.recordCount; index += 1) {
      if (
        this.records.active[index] &&
        this.records.ready[index] &&
        this.records.kind[index] === this.coverageKind &&
        this.containsPoint(index, x, y)
      )
        return true;
    }
    return false;
  }

  private sampleCurrentCovered(x: number, y: number): boolean {
    for (let index = 0; index < this.recordCount; index += 1) {
      if (
        this.records.active[index] &&
        this.records.ready[index] &&
        this.records.kind[index] === CONTENT_KIND &&
        this.records.epoch[index] === this.requestedEpoch &&
        this.containsPoint(index, x, y)
      )
        return true;
    }
    return false;
  }

  private needsFallback(index: number, kind: number): boolean {
    const left = Math.max(
      this.records.localX[index] ?? 0,
      0,
      this.coverageWindowLeft,
    );
    const top = Math.max(
      this.records.localY[index] ?? 0,
      0,
      this.coverageWindowTop,
    );
    const right = Math.min(
      (this.records.localX[index] ?? 0) + (this.records.width[index] ?? 0),
      this.contentWidth,
      this.coverageWindowRight,
    );
    const bottom = Math.min(
      (this.records.localY[index] ?? 0) + (this.records.height[index] ?? 0),
      this.coverageWindowBottom,
    );
    if (right <= left || bottom <= top) return false;
    const width = right - left;
    const height = bottom - top;
    return (
      !this.sampleCoveredByBetter(kind, index, left, top) ||
      !this.sampleCoveredByBetter(kind, index, right, top) ||
      !this.sampleCoveredByBetter(kind, index, left, bottom) ||
      !this.sampleCoveredByBetter(kind, index, right, bottom) ||
      !this.sampleCoveredByBetter(
        kind,
        index,
        left + width / 2,
        top + height / 2,
      )
    );
  }

  private sampleCoveredByBetter(
    kind: number,
    candidate: number,
    x: number,
    y: number,
  ): boolean {
    for (let index = 0; index < this.recordCount; index += 1) {
      if (
        !this.records.active[index] ||
        !this.records.ready[index] ||
        this.records.kind[index] !== kind ||
        !this.isBetterRecord(index, candidate)
      )
        continue;
      if (this.containsPoint(index, x, y)) return true;
    }
    return false;
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
    const firstEpoch = this.records.epoch[first] ?? 0;
    const secondEpoch = this.records.epoch[second] ?? 0;
    if (this.records.kind[first] === CONTENT_KIND && firstEpoch !== secondEpoch)
      return firstEpoch > secondEpoch;
    const firstAtRest =
      (this.records.rasterScale[first] ?? 0) === this.atRestScale;
    const secondAtRest =
      (this.records.rasterScale[second] ?? 0) === this.atRestScale;
    if (firstAtRest !== secondAtRest) return firstAtRest;
    return (
      (this.records.rasterScale[first] ?? 0) >
      (this.records.rasterScale[second] ?? 0)
    );
  }

  private pushSortedFallback(target: Int32Array, recordIndex: number): void {
    const targetKind =
      target === this.drawHeaderFallback
        ? "header"
        : target === this.drawLabelFallback
          ? "label"
          : "content";
    const count =
      targetKind === "header"
        ? this.drawHeaderFallbackCount
        : targetKind === "label"
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
    if (targetKind === "header") this.drawHeaderFallbackCount += 1;
    else if (targetKind === "label") this.drawLabelFallbackCount += 1;
    else this.drawFallbackCount += 1;
  }

  private shouldDrawBefore(first: number, second: number): boolean {
    if (second < 0) return false;
    const firstEpoch = this.records.epoch[first] ?? 0;
    const secondEpoch = this.records.epoch[second] ?? 0;
    if (this.records.kind[first] === CONTENT_KIND && firstEpoch !== secondEpoch)
      return firstEpoch < secondEpoch;
    return (
      (this.records.rasterScale[first] ?? 0) <
      (this.records.rasterScale[second] ?? 0)
    );
  }

  private pushUnique(
    target: Int32Array,
    kind: "current" | "headerCurrent" | "labelCurrent",
    recordIndex: number,
  ): void {
    const count =
      kind === "headerCurrent"
        ? this.drawHeaderCurrentCount
        : kind === "labelCurrent"
          ? this.drawLabelCurrentCount
          : this.drawCurrentCount;
    for (let index = 0; index < count; index += 1) {
      if (target[index] === recordIndex) return;
    }
    if (count >= target.length) return;
    target[count] = recordIndex;
    if (kind === "headerCurrent") this.drawHeaderCurrentCount += 1;
    else if (kind === "labelCurrent") this.drawLabelCurrentCount += 1;
    else this.drawCurrentCount += 1;
  }
}
