import type { SourceFileId } from "../../shared/domain";

import type { FilePath } from "./file-path";

export interface DiscoveredFile {
  readonly fileId: SourceFileId;
  readonly path: FilePath;
  readonly lineCount: number;
}
