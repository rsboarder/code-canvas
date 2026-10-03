import type { EventBus } from "../../shared/events";
import type { SourceFileId, WorkspaceFolderId } from "../../shared/domain";
import {
  isSourceFilePath,
  SourceFile,
  type ContentVersion,
  type FilePath,
  type SaveConflict,
  type WorkspaceEvent,
  WorkspaceFolder,
} from "../domain";
import type { DirectoryReader, FileWriter, PickedFolder } from "./ports";

const MAX_GUARANTEED_FILES = 200;

export type OpenFolderOutcome =
  | {
      readonly kind: "opened";
      readonly folderId: WorkspaceFolderId;
      readonly fileCount: number;
      readonly overLimit: boolean;
    }
  | { readonly kind: "empty"; readonly folderId: WorkspaceFolderId }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "no-last-folder" }
  | { readonly kind: "permission-denied" };

export type ReadForEditing =
  | {
      readonly kind: "ready";
      readonly path: FilePath;
      readonly text: string;
      readonly contentVersion: ContentVersion;
    }
  | {
      readonly kind: "conflict";
      readonly conflict: SaveConflict;
      readonly text: string;
      readonly contentVersion: ContentVersion;
    }
  | { readonly kind: "unavailable" };

export interface DraftApplied {
  readonly contentVersion: ContentVersion;
  readonly written: Promise<WriteOutcome>;
}

export type WriteOutcome =
  | { readonly kind: "written"; readonly contentVersion: ContentVersion }
  | { readonly kind: "conflict"; readonly conflict: SaveConflict }
  | { readonly kind: "failed" };

interface OpenedFolder {
  readonly folder: WorkspaceFolder;
  readonly picked: PickedFolder;
}

type QueuedWriteOutcome = WriteOutcome | undefined;

export class WorkspaceService {
  private readonly ports: {
    readonly reader: DirectoryReader;
    readonly writer: FileWriter;
  };
  private opened: OpenedFolder | undefined;
  private readonly unsaved = new Set<SourceFileId>();
  private readonly failedWrites = new Set<SourceFileId>();
  private readonly writeQueues = new Map<
    SourceFileId,
    Promise<QueuedWriteOutcome>
  >();

  public constructor(
    reader: DirectoryReader,
    writer: FileWriter,
    private readonly bus: EventBus<WorkspaceEvent>,
  ) {
    this.ports = { reader, writer };
  }

  public async openFolder(): Promise<OpenFolderOutcome> {
    if (!this.ports.reader.isSupported()) return { kind: "unsupported" };

    const picked = await this.ports.reader.pickFolder();
    if (picked === undefined) return { kind: "cancelled" };

    return this.loadFolder(picked);
  }

  public async reopenLastFolder(): Promise<OpenFolderOutcome> {
    if (!this.ports.reader.isSupported()) return { kind: "unsupported" };

    const folder = await this.ports.reader.lastFolder();
    if (folder === undefined) return { kind: "no-last-folder" };
    if (!(await this.ports.reader.ensurePermission(folder))) {
      return { kind: "permission-denied" };
    }

    return this.loadFolder(folder);
  }

  public async lastFolderName(): Promise<string | undefined> {
    return (await this.ports.reader.lastFolder())?.name;
  }

  public async readForEditing(fileId: SourceFileId): Promise<ReadForEditing> {
    const opened = this.opened;
    const file = opened?.folder.file(fileId);
    if (opened === undefined || file === undefined) {
      return { kind: "unavailable" };
    }

    let read;
    try {
      read = await this.ports.reader.readFile(opened.picked, file.path);
    } catch {
      return { kind: "unavailable" };
    }

    if (read.revision === file.revision) {
      return file.decodable ? this.readyResult(file) : { kind: "unavailable" };
    }
    if (this.unsaved.has(fileId)) {
      const conflict = {
        fileId,
        knownRevision: file.revision,
        diskRevision: read.revision,
      } satisfies SaveConflict;
      this.publishConflict(conflict);
      return {
        kind: "conflict",
        conflict,
        text: file.text,
        contentVersion: file.contentVersion,
      };
    }

    const changed = file.rereadFromDisk(read);
    if (!file.decodable) return { kind: "unavailable" };
    if (changed) this.publishContentChanged(file);
    return this.readyResult(file);
  }

  public async resolveConflict(
    fileId: SourceFileId,
    choice: "disk" | "mine",
  ): Promise<boolean> {
    const opened = this.opened;
    const file = opened?.folder.file(fileId);
    if (opened === undefined || file === undefined) return false;

    let resolvedFromDisk = false;
    const operation =
      choice === "disk"
        ? () =>
            this.resolveFromDisk(opened.picked, file, () => {
              resolvedFromDisk = true;
            })
        : () => this.resolveWithDraft(opened.picked, file);
    const outcome = await this.queueWrite(fileId, operation);
    if (choice === "disk") return resolvedFromDisk;
    return outcome?.kind === "written";
  }

  public applyDraft(fileId: SourceFileId, text: string): DraftApplied {
    const opened = this.opened;
    const file = opened?.folder.file(fileId);
    if (opened === undefined || file === undefined) {
      throw new RangeError(`Unknown Source File: ${fileId}`);
    }

    const contentVersion = file.applyText(text);
    this.unsaved.add(fileId);
    this.publishContentChanged(file);

    const written = this.queueWrite(fileId, () =>
      this.writeDraft(opened.picked, file, contentVersion),
    );
    return {
      contentVersion,
      written: written.then((outcome) => {
        if (outcome === undefined) {
          throw new Error("Draft write was skipped.");
        }
        return outcome;
      }),
    };
  }

  public retryFailedWrites(): void {
    const opened = this.opened;
    if (opened === undefined) return;
    for (const fileId of this.failedWrites) {
      const file = opened.folder.file(fileId);
      if (file === undefined) continue;
      void this.queueWrite(fileId, () => {
        if (!this.unsaved.has(fileId)) return Promise.resolve(undefined);
        return this.writeDraft(opened.picked, file, file.contentVersion);
      });
    }
  }

  private async loadFolder(picked: PickedFolder): Promise<OpenFolderOutcome> {
    this.opened = undefined;
    this.failedWrites.clear();
    const entries = await this.ports.reader.listSourceFiles(picked);
    const sourceFiles = [] as SourceFile[];
    for (const entry of entries) {
      if (!isSourceFilePath(entry.path)) continue;
      const read = await this.ports.reader.readFile(picked, entry.path);
      sourceFiles.push(SourceFile.fromDisk(entry.path, read));
    }

    if (sourceFiles.length === 0) {
      return { kind: "empty", folderId: picked.id };
    }

    const workspaceFolder = new WorkspaceFolder(picked.id);
    for (const sourceFile of sourceFiles) workspaceFolder.add(sourceFile);
    this.opened = { folder: workspaceFolder, picked };
    this.publishLoadedFiles(workspaceFolder, sourceFiles);

    return {
      kind: "opened",
      folderId: this.opened.folder.id,
      fileCount: this.opened.folder.fileCount,
      overLimit: this.opened.folder.fileCount > MAX_GUARANTEED_FILES,
    };
  }

  private publishLoadedFiles(
    folder: WorkspaceFolder,
    sourceFiles: readonly SourceFile[],
  ): void {
    this.bus.publish({
      type: "FilesDiscovered",
      folderId: folder.id,
      files: folder.discoveredFiles(),
    });
    for (const file of sourceFiles) {
      if (!file.decodable) continue;
      this.publishContentChanged(file);
    }
  }

  private readyResult(file: SourceFile): ReadForEditing {
    return {
      kind: "ready",
      path: file.path,
      text: file.text,
      contentVersion: file.contentVersion,
    };
  }

  private publishContentChanged(file: SourceFile): void {
    this.bus.publish({
      type: "FileContentChanged",
      fileId: file.id,
      contentVersion: file.contentVersion,
      text: file.text,
      lineCount: file.lineCount,
    });
  }

  private async writeDraft(
    folder: PickedFolder,
    file: SourceFile,
    draftVersion: ContentVersion,
  ): Promise<WriteOutcome> {
    let diskRead;
    try {
      diskRead = await this.ports.reader.readFile(folder, file.path);
    } catch {
      return { kind: "failed" };
    }

    const check = file.checkWrite(diskRead.revision);
    if (!check.ok) return { kind: "conflict", conflict: check.error };

    const text = file.text;
    const versionWritten = file.contentVersion;
    let written;
    try {
      written = await this.ports.writer.writeFile(folder, file.path, text);
    } catch {
      return { kind: "failed" };
    }

    file.markWritten(written.revision, written.lastModified, written.size);
    if (file.contentVersion === draftVersion) this.unsaved.delete(file.id);
    return { kind: "written", contentVersion: versionWritten };
  }

  private async resolveFromDisk(
    folder: PickedFolder,
    file: SourceFile,
    onResolved: () => void,
  ): Promise<undefined> {
    let read;
    try {
      read = await this.ports.reader.readFile(folder, file.path);
    } catch {
      return undefined;
    }

    const changed = file.rereadFromDisk(read);
    this.unsaved.delete(file.id);
    this.failedWrites.delete(file.id);
    if (changed) this.publishContentChanged(file);
    onResolved();
    return undefined;
  }

  private async resolveWithDraft(
    folder: PickedFolder,
    file: SourceFile,
  ): Promise<WriteOutcome> {
    const draftVersion = file.contentVersion;
    const text = file.text;
    let written;
    try {
      written = await this.ports.writer.writeFile(folder, file.path, text);
    } catch {
      return { kind: "failed" };
    }

    file.markWritten(written.revision, written.lastModified, written.size);
    if (file.contentVersion === draftVersion) this.unsaved.delete(file.id);
    return { kind: "written", contentVersion: draftVersion };
  }

  private queueWrite(
    fileId: SourceFileId,
    operation: () => Promise<QueuedWriteOutcome>,
  ): Promise<QueuedWriteOutcome> {
    const previous = this.writeQueues.get(fileId);
    const write =
      previous === undefined ? operation() : previous.then(operation);
    const queued = write
      .catch(() => ({ kind: "failed" as const }))
      .then((outcome) => {
        if (outcome !== undefined) this.publishWriteOutcome(fileId, outcome);
        return outcome;
      });
    this.writeQueues.set(fileId, queued);
    return queued;
  }

  private publishWriteOutcome(
    fileId: SourceFileId,
    outcome: WriteOutcome,
  ): void {
    if (outcome.kind === "written") {
      this.failedWrites.delete(fileId);
      this.bus.publish({
        type: "DraftWritten",
        fileId,
        contentVersion: outcome.contentVersion,
      });
      return;
    }
    if (outcome.kind === "conflict") {
      this.failedWrites.delete(fileId);
      this.publishConflict(outcome.conflict);
      return;
    }
    this.failedWrites.add(fileId);
    this.bus.publish({ type: "DraftWriteFailed", fileId });
  }

  private publishConflict(conflict: SaveConflict): void {
    this.bus.publish({ type: "SaveConflictDetected", fileId: conflict.fileId });
  }
}
