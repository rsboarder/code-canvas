import type { SourceFileId } from "../../shared/domain";
import type { Rect } from "../../shared/geometry/geometry";
import type { BoardMetrics } from "./board-metrics";
import { ContentScroll } from "./content-scroll";
import { WidgetFrame } from "./widget-frame";

interface WidgetConfiguration {
  readonly frame: Rect;
  readonly metrics: BoardMetrics;
}

export class Widget {
  private readonly frame: WidgetFrame;
  private readonly scroll: ContentScroll;
  private _lineCount: number;

  constructor(
    readonly id: SourceFileId,
    readonly path: string,
    lineCount: number,
    configuration: WidgetConfiguration,
  ) {
    this._lineCount = Math.max(0, lineCount);
    this.frame = new WidgetFrame(configuration.frame, configuration.metrics);
    this.scroll = new ContentScroll(
      this._lineCount,
      this.frame.height,
      configuration.metrics,
    );
  }

  get x(): number {
    return this.frame.x;
  }

  get y(): number {
    return this.frame.y;
  }

  get width(): number {
    return this.frame.width;
  }

  get height(): number {
    return this.frame.height;
  }

  get contentScroll(): number {
    return this.scroll.value;
  }

  get maxContentScroll(): number {
    return this.scroll.max;
  }

  get lineCount(): number {
    return this._lineCount;
  }

  moveTo(x: number, y: number): void {
    this.frame.moveTo(x, y);
  }

  resizeTo(width: number, height: number): void {
    this.frame.resizeTo(width, height);
    this.scroll.resizeTo(this.frame.height);
  }

  scrollBy(deltaY: number): number {
    return this.scroll.scrollBy(deltaY);
  }

  scrollTo(value: number): number {
    return this.scroll.scrollTo(value);
  }

  setLineCount(lineCount: number): void {
    this._lineCount = Math.max(0, lineCount);
    this.scroll.setLineCount(this._lineCount);
  }
}
