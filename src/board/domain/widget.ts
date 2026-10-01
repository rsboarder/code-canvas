import type { Rect } from "../../shared/geometry/geometry";

export interface Widget {
  readonly id: string;
  readonly path: string;
  readonly frame: Rect;
  readonly lineCount: number;
}

export function createWidget(
  id: string,
  path: string,
  lineCount: number,
): Widget {
  return {
    id,
    path,
    lineCount,
    frame: {
      x: 0,
      y: 0,
      width: 760,
      height: Math.min(900, 52 + lineCount * 20),
    },
  };
}
