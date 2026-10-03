import type { SourceFileId } from "../../shared/domain";

export type HitZone =
  "empty" | "header" | "body" | "right-edge" | "bottom-edge" | "corner";

export interface HitTestResult {
  zone: HitZone;
  widgetId: SourceFileId | undefined;
  contentX: number;
  contentY: number;
}

export function createHitTestResult(): HitTestResult {
  return { zone: "empty", widgetId: undefined, contentX: 0, contentY: 0 };
}
