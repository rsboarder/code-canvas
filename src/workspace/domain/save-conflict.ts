import type { SourceFileId } from "../../shared/domain";

import type { FileRevision } from "./file-revision";

export interface SaveConflict {
  readonly fileId: SourceFileId;
  readonly knownRevision: FileRevision;
  readonly diskRevision: FileRevision;
}
