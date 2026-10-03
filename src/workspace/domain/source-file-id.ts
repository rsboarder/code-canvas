import { sourceFileId, type SourceFileId } from "../../shared/domain";

import type { FilePath } from "./file-path";

export function sourceFileIdFor(path: FilePath): SourceFileId {
  return sourceFileId(path);
}
