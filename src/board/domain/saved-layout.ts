import type { SourceFileId } from "../../shared/domain";

export interface SavedCamera {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface SavedWidget {
  readonly fileId: SourceFileId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly contentScroll: number;
}

export interface SavedLayout {
  readonly camera: SavedCamera;
  readonly widgets: readonly SavedWidget[];
}
