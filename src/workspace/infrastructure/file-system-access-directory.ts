import { workspaceFolderId } from "../../shared/domain";
import { isSourceFileName, shouldEnterDirectory } from "../domain/file-filter";
import { filePath, type FilePath } from "../domain/file-path";
import { fileRevisionOf } from "../domain/file-revision";
import type { DiskRead } from "../domain/source-file";
import type {
  DirectoryReader,
  DiskEntry,
  FileWriter,
  PickedFolder,
} from "../application/ports";
import { FolderHandleStore, type SavedFolder } from "./folder-handle-store";

export interface DirectoryPickerHost {
  readonly showDirectoryPicker?: (options: {
    readonly mode: "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

interface FileLike {
  readonly lastModified: number;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface WritableLike {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface FileHandleLike {
  readonly kind: "file";
  getFile(): Promise<FileLike>;
  createWritable(): Promise<WritableLike>;
}

type HandleLike = DirectoryHandleLike | FileHandleLike;

interface DirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  entries(): AsyncIterableIterator<[string, HandleLike]>;
  getDirectoryHandle(name: string): Promise<DirectoryHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  isSameEntry(other: FileSystemDirectoryHandle): Promise<boolean>;
  queryPermission?: (options: {
    readonly mode: "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    readonly mode: "readwrite";
  }) => Promise<PermissionState>;
}

function asDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): DirectoryHandleLike {
  return handle as unknown as DirectoryHandleLike;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function pathWithPrefix(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

export class FileSystemAccessDirectory implements DirectoryReader, FileWriter {
  private readonly handles = new Map<PickedFolder["id"], DirectoryHandleLike>();

  public constructor(
    private readonly host: DirectoryPickerHost,
    private readonly store: FolderHandleStore,
  ) {}

  public isSupported(): boolean {
    return typeof this.host.showDirectoryPicker === "function";
  }

  public async pickFolder(): Promise<PickedFolder | undefined> {
    const picker = this.host.showDirectoryPicker;
    if (typeof picker !== "function") return undefined;
    let picked: FileSystemDirectoryHandle;
    try {
      picked = await picker.call(this.host, { mode: "readwrite" });
    } catch (error) {
      if (isAbortError(error)) return undefined;
      throw error;
    }

    const pickedHandle = asDirectoryHandle(picked);
    const savedFolders = await this.store.all();
    const existing = await this.matchSavedFolder(pickedHandle, savedFolders);
    const id = existing?.id ?? workspaceFolderId(crypto.randomUUID());
    const folder = { id, name: picked.name };
    await this.store.save({ ...folder, handle: picked });
    await this.store.markLast(id);
    this.handles.set(id, pickedHandle);
    return folder;
  }

  public async lastFolder(): Promise<PickedFolder | undefined> {
    const saved = await this.store.last();
    if (saved === undefined) return undefined;
    this.handles.set(saved.id, asDirectoryHandle(saved.handle));
    return { id: saved.id, name: saved.name };
  }

  public async ensurePermission(folder: PickedFolder): Promise<boolean> {
    const handle = await this.handleFor(folder);
    if (handle?.queryPermission === undefined) return false;
    try {
      const permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission === "granted") return true;
      if (handle.requestPermission === undefined) return false;
      return (
        (await handle.requestPermission({ mode: "readwrite" })) === "granted"
      );
    } catch {
      return false;
    }
  }

  public async listSourceFiles(
    folder: PickedFolder,
  ): Promise<readonly DiskEntry[]> {
    const handle = await this.requireHandle(folder);
    const entries: DiskEntry[] = [];
    await this.collectSourceFiles(handle, "", entries);
    entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
    return entries;
  }

  public async readFile(
    folder: PickedFolder,
    path: FilePath,
  ): Promise<DiskRead> {
    const file = await this.fileFor(folder, path);
    const diskFile = await file.getFile();
    const bytes = new Uint8Array(await diskFile.arrayBuffer());
    return {
      revision: fileRevisionOf(bytes),
      lastModified: diskFile.lastModified,
      size: diskFile.size,
      text: this.decode(bytes),
    };
  }

  public async writeFile(
    folder: PickedFolder,
    path: FilePath,
    text: string,
  ): Promise<DiskRead> {
    const file = await this.fileFor(folder, path);
    const bytes = new TextEncoder().encode(text);
    const writable = await file.createWritable();
    try {
      await writable.write(bytes);
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // Preserve the failed write as the operation's error.
      }
      throw error;
    }
    await writable.close();
    const diskFile = await file.getFile();
    return {
      revision: fileRevisionOf(bytes),
      lastModified: diskFile.lastModified,
      size: bytes.byteLength,
      text,
    };
  }

  private async matchSavedFolder(
    picked: DirectoryHandleLike,
    savedFolders: readonly SavedFolder[],
  ): Promise<SavedFolder | undefined> {
    for (const saved of savedFolders) {
      if (await picked.isSameEntry(saved.handle)) return saved;
    }
    return undefined;
  }

  private async handleFor(
    folder: PickedFolder,
  ): Promise<DirectoryHandleLike | undefined> {
    const remembered = this.handles.get(folder.id);
    if (remembered !== undefined) return remembered;
    const saved = (await this.store.all()).find(
      (item) => item.id === folder.id,
    );
    if (saved === undefined) return undefined;
    const handle = asDirectoryHandle(saved.handle);
    this.handles.set(folder.id, handle);
    return handle;
  }

  private async requireHandle(
    folder: PickedFolder,
  ): Promise<DirectoryHandleLike> {
    const handle = await this.handleFor(folder);
    if (handle === undefined) {
      throw new Error(`Unknown workspace folder: ${folder.id}`);
    }
    return handle;
  }

  private async collectSourceFiles(
    directory: DirectoryHandleLike,
    prefix: string,
    entries: DiskEntry[],
  ): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      const path = pathWithPrefix(prefix, name);
      if (handle.kind === "file" && isSourceFileName(name)) {
        const file = await handle.getFile();
        entries.push({
          path: filePath(path),
          lastModified: file.lastModified,
          size: file.size,
        });
        continue;
      }
      if (handle.kind === "directory" && shouldEnterDirectory(name)) {
        await this.collectSourceFiles(handle, path, entries);
      }
    }
  }

  private async fileFor(
    folder: PickedFolder,
    path: FilePath,
  ): Promise<FileHandleLike> {
    let directory = await this.requireHandle(folder);
    const segments = path.split("/");
    const fileName = segments.pop();
    if (fileName === undefined)
      throw new RangeError("FilePath cannot be empty.");
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment);
    }
    return directory.getFileHandle(fileName);
  }

  private decode(bytes: Uint8Array): string | undefined {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
}
