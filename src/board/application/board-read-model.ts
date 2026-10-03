import type { SourceFileId } from "../../shared/domain";

import type { CameraView } from "../domain/camera";
import type { DetailLevelName } from "../domain/detail-level";
import type { HitTestResult } from "../domain/hit-test";

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface WidgetRow {
  x: number;
  y: number;
  width: number;
  height: number;
  contentScroll: number;
  maxContentScroll: number;
  lineCount: number;
  stackIndex: number;
}

export function createWidgetRow(): WidgetRow {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    contentScroll: 0,
    maxContentScroll: 0,
    lineCount: 0,
    stackIndex: 0,
  };
}

export interface BoardReadModel {
  readonly camera: CameraView;
  readonly detailLevel: DetailLevelName;
  readonly layoutVersion: number;
  readonly widgetCount: number;
  widgetIdAtFromTop(index: number): SourceFileId | undefined;
  readWidget(id: SourceFileId, out: WidgetRow): WidgetRow;
  hitTest(screenX: number, screenY: number, out: HitTestResult): HitTestResult;
  textWanted(devicePixelRatio: number): boolean;
  textThresholdZoom(devicePixelRatio: number): number;
  drainDirtyWidgets(out: SourceFileId[]): number;
}
