import type { Rect } from "../../shared/geometry/geometry";

export class WidgetTable {
  readonly values = new Float32Array(6);

  setWidget(frame: Rect, scroll = 0): void {
    this.values[0] = frame.x;
    this.values[1] = frame.y;
    this.values[2] = frame.width;
    this.values[3] = frame.height;
    this.values[4] = scroll;
    this.values[5] = 0;
  }

  get frame(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.values[0] ?? 0,
      y: this.values[1] ?? 0,
      width: this.values[2] ?? 0,
      height: this.values[3] ?? 0,
    };
  }
}
