import type { SourceFileId } from "../../shared/domain";

export interface EditingGpuView {
  setHiddenBody(fileId: SourceFileId | undefined): void;
  setPriorityFile(fileId: SourceFileId | undefined): void;
  exitViewCovered(widgetId: SourceFileId, contentVersion: number): boolean;
}
