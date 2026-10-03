import type { SourceFileId } from "../../shared/domain";

export interface WidgetPlacement {
  readonly fileId: SourceFileId;
  readonly path: string;
  readonly lineCount: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly contentScroll: number;
}
