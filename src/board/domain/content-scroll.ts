import type { BoardMetrics } from "./board-metrics";

export class ContentScroll {
  private _lineCount: number;
  private _value = 0;

  constructor(
    lineCount: number,
    frameHeight: number,
    private readonly metrics: BoardMetrics,
  ) {
    this._lineCount = Math.max(0, lineCount);
    this.viewportHeight = frameHeight - metrics.headerHeight;
  }

  private viewportHeight: number;

  get value(): number {
    return this._value;
  }

  get max(): number {
    return Math.max(
      0,
      this._lineCount * this.metrics.baseLineHeight - this.viewportHeight,
    );
  }

  resizeTo(frameHeight: number): void {
    this.viewportHeight = frameHeight - this.metrics.headerHeight;
    this.clampValue();
  }

  setLineCount(lineCount: number): void {
    this._lineCount = Math.max(0, lineCount);
    this.clampValue();
  }

  scrollBy(deltaY: number): number {
    const previous = this._value;
    this._value = Math.min(this.max, Math.max(0, previous + deltaY));
    return this._value - previous;
  }

  scrollTo(value: number): number {
    this._value = Math.min(this.max, Math.max(0, value));
    return this._value;
  }

  private clampValue(): void {
    this._value = Math.min(this.max, Math.max(0, this._value));
  }
}
