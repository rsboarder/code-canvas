import type { SourceFileId } from "../../shared/domain";

export interface BoardFile {
  readonly fileId: SourceFileId;
  readonly path: string;
  readonly lineCount: number;
}
