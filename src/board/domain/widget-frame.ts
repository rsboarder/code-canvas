import type { Rect } from "../../shared/geometry/geometry";
import { minimumHeight, type BoardMetrics } from "./board-metrics";

export class WidgetFrame {
  private _height: number;
  private _width: number;
  private _x: number;
  private _y: number;

  constructor(
    frame: Rect,
    private readonly metrics: BoardMetrics,
  ) {
    this._x = frame.x;
    this._y = frame.y;
    this._width = Math.max(metrics.minimumWidth, frame.width);
    this._height = Math.max(minimumHeight(metrics), frame.height);
  }

  get x(): number {
    return this._x;
  }

  get y(): number {
    return this._y;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  moveTo(x: number, y: number): void {
    this._x = x;
    this._y = y;
  }

  resizeTo(width: number, height: number): void {
    this._width = Math.max(this.metrics.minimumWidth, width);
    this._height = Math.max(minimumHeight(this.metrics), height);
  }
}
