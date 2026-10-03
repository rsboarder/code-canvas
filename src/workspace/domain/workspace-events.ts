import type {
  DomainEvent,
  SourceFileId,
  WorkspaceFolderId,
} from "../../shared/domain";

import type { ContentVersion } from "./content-version";
import type { DiscoveredFile } from "./discovered-file";

export interface FilesDiscovered extends DomainEvent<"FilesDiscovered"> {
  readonly folderId: WorkspaceFolderId;
  readonly files: readonly DiscoveredFile[];
}

export interface FileContentChanged extends DomainEvent<"FileContentChanged"> {
  readonly fileId: SourceFileId;
  readonly contentVersion: ContentVersion;
  readonly text: string;
  readonly lineCount: number;
}

export interface DraftWritten extends DomainEvent<"DraftWritten"> {
  readonly fileId: SourceFileId;
  readonly contentVersion: ContentVersion;
}

export interface DraftWriteFailed extends DomainEvent<"DraftWriteFailed"> {
  readonly fileId: SourceFileId;
}

export interface SaveConflictDetected extends DomainEvent<"SaveConflictDetected"> {
  readonly fileId: SourceFileId;
}

export type WorkspaceEvent =
  | FilesDiscovered
  | FileContentChanged
  | DraftWritten
  | DraftWriteFailed
  | SaveConflictDetected;
