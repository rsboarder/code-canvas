import type { LineRange } from "../../code-view/index";
import type { ViewWindow } from "./tile-view-window";

export interface MutableLineRange extends LineRange {
  start: number;
  end: number;
}

export function visibleLineRange(
  view: Pick<ViewWindow, "top" | "bottom">,
  lineHeight: number,
  out: MutableLineRange,
): LineRange {
  out.start = Math.floor(view.top / lineHeight);
  out.end = Math.ceil(view.bottom / lineHeight);
  return out;
}
