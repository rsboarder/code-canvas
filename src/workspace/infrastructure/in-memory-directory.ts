import { fileRevisionOf } from "../domain/file-revision";
import { filePath, type FilePath } from "../domain/file-path";
import type { DiskRead } from "../domain/source-file";
import type {
  DirectoryReader,
  DiskEntry,
  FileWriter,
  PickedFolder,
} from "../application/ports";

export class InMemoryDirectory implements DirectoryReader, FileWriter {
  private readonly files: Map<string, Uint8Array>;
  private readonly modifiedAt = new Map<string, number>();
  private modifiedCounter = 0;
  private picked: PickedFolder | undefined;
  private remembered: PickedFolder | undefined;
  private permission = true;
  private supported = true;
  private readsToFail = 0;
  private writesToFail = 0;
  private writeGate: Promise<void> | undefined;
  private releaseWrites: (() => void) | undefined;

  public constructor(files: ReadonlyMap<string, Uint8Array>) {
    this.files = new Map(
      Array.from(files, ([path, bytes]) => [path, new Uint8Array(bytes)]),
    );
  }

  public pickCount = 0;
  public writeCount = 0;

  public setPickedFolder(folder: PickedFolder | undefined): void {
    this.picked = folder;
  }

  public setLastFolder(folder: PickedFolder | undefined): void {
    this.remembered = folder;
  }

  public setPermission(permission: boolean): void {
    this.permission = permission;
  }

  public setSupported(supported: boolean): void {
    this.supported = supported;
  }

  public failNextRead(): void {
    this.readsToFail += 1;
  }

  public failNextWrite(): void {
    this.writesToFail += 1;
  }

  public holdWrites(): () => void {
    this.writeGate = new Promise<void>((resolve) => {
      this.releaseWrites = resolve;
    });
    return () => {
      this.releaseWrites?.();
      this.writeGate = undefined;
      this.releaseWrites = undefined;
    };
  }

  public isSupported(): boolean {
    return this.supported;
  }

  public pickFolder(): Promise<PickedFolder | undefined> {
    this.pickCount += 1;
    if (this.picked !== undefined) this.remembered = this.picked;
    return Promise.resolve(this.picked);
  }

  public lastFolder(): Promise<PickedFolder | undefined> {
    return Promise.resolve(this.remembered);
  }

  public ensurePermission(folder: PickedFolder): Promise<boolean> {
    return Promise.resolve(this.permission && folder.id.length > 0);
  }

  public listSourceFiles(folder: PickedFolder): Promise<readonly DiskEntry[]> {
    return Promise.resolve().then(() => {
      if (folder.id.length === 0) return [];
      return Array.from(this.files, ([path, content]) => ({
        path: filePath(path),
        lastModified: this.modifiedAt.get(path) ?? 0,
        size: content.byteLength,
      }));
    });
  }

  public readFile(folder: PickedFolder, path: FilePath): Promise<DiskRead> {
    return Promise.resolve().then(() => {
      if (this.readsToFail > 0) {
        this.readsToFail -= 1;
        throw new Error("Read failed");
      }
      const content = this.files.get(path);
      if (content === undefined) {
        throw new Error(`Missing file in ${folder.name}: ${path}`);
      }
      return this.diskRead(path, content);
    });
  }

  public writeFile(
    folder: PickedFolder,
    path: FilePath,
    text: string,
  ): Promise<DiskRead> {
    if (folder.id.length === 0) {
      return Promise.reject(new RangeError("Cannot write without a folder."));
    }
    if (this.writesToFail > 0) {
      this.writesToFail -= 1;
      return Promise.reject(new Error("Write failed"));
    }
    const content = new TextEncoder().encode(text);
    this.writeCount += 1;
    return this.commitWrite(path, content);
  }

  public writeExternally(path: string, bytes: Uint8Array): void {
    this.writeBytes(filePath(path), bytes);
  }

  private writeBytes(path: FilePath, bytes: Uint8Array): void {
    this.modifiedCounter += 1;
    this.files.set(path, new Uint8Array(bytes));
    this.modifiedAt.set(path, this.modifiedCounter);
  }

  private async commitWrite(
    path: FilePath,
    content: Uint8Array,
  ): Promise<DiskRead> {
    if (this.writeGate !== undefined) await this.writeGate;
    this.writeBytes(path, content);
    return this.diskRead(path, content);
  }

  private diskRead(path: FilePath, content: Uint8Array): DiskRead {
    return {
      revision: fileRevisionOf(content),
      lastModified: this.modifiedAt.get(path) ?? 0,
      size: content.byteLength,
      text: this.decode(content),
    };
  }

  private decode(content: Uint8Array): string | undefined {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return undefined;
    }
  }
}
