import type { SourceFileId } from "../../shared/domain";

export interface Draft {
  readonly fileId: SourceFileId;
  readonly text: string;
  readonly contentVersion: number;
}
