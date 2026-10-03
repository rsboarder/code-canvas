import type { SourceFileId, WorkspaceFolderId } from "../../shared/domain";

import type { DiscoveredFile } from "./discovered-file";
import { isSourceFilePath } from "./file-filter";
import type { SourceFile } from "./source-file";

export class WorkspaceFolder {
  private readonly files = new Map<SourceFileId, SourceFile>();

  public constructor(public readonly id: WorkspaceFolderId) {}

  public add(file: SourceFile): void {
    if (!isSourceFilePath(file.path) || this.files.has(file.id)) {
      throw new RangeError(`Cannot add Source File: ${file.path}`);
    }
    this.files.set(file.id, file);
  }

  public file(id: SourceFileId): SourceFile | undefined {
    return this.files.get(id);
  }

  public get fileCount(): number {
    return this.files.size;
  }

  public discoveredFiles(): readonly DiscoveredFile[] {
    return Array.from(this.files.values(), (file) => ({
      fileId: file.id,
      path: file.path,
      lineCount: file.lineCount,
    }));
  }
}
