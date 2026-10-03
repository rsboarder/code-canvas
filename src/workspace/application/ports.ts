import type { WorkspaceFolderId } from "../../shared/domain";

import type { FilePath } from "../domain/file-path";
import type { DiskRead } from "../domain/source-file";

export interface PickedFolder {
  readonly id: WorkspaceFolderId;
  readonly name: string;
}

export interface DiskEntry {
  readonly path: FilePath;
  readonly lastModified: number;
  readonly size: number;
}

export interface DirectoryReader {
  isSupported(): boolean;
  pickFolder(): Promise<PickedFolder | undefined>;
  lastFolder(): Promise<PickedFolder | undefined>;
  ensurePermission(folder: PickedFolder): Promise<boolean>;
  listSourceFiles(folder: PickedFolder): Promise<readonly DiskEntry[]>;
  readFile(folder: PickedFolder, path: FilePath): Promise<DiskRead>;
}

export interface FileWriter {
  writeFile(
    folder: PickedFolder,
    path: FilePath,
    text: string,
  ): Promise<DiskRead>;
}
