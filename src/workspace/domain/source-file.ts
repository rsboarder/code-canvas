import {
  err,
  ok,
  splitSourceLines,
  type Result,
  type SourceFileId,
} from "../../shared/domain";

import type { ContentVersion } from "./content-version";
import type { FilePath } from "./file-path";
import type { FileRevision } from "./file-revision";
import type { SaveConflict } from "./save-conflict";
import { sourceFileIdFor } from "./source-file-id";

export interface DiskRead {
  readonly revision: FileRevision;
  readonly lastModified: number;
  readonly size: number;
  readonly text: string | undefined;
}

export class SourceFile {
  private _contentVersion: ContentVersion;
  private _text: string;
  private _lineCount: number;
  private _decodable: boolean;
  private _revision: FileRevision;
  private _lastModified: number;
  private _size: number;

  private constructor(
    public readonly path: FilePath,
    read: DiskRead,
  ) {
    this.id = sourceFileIdFor(path);
    this._contentVersion = 1;
    this._text = read.text ?? "";
    this._lineCount = splitSourceLines(this._text).length;
    this._decodable = read.text !== undefined;
    this._revision = read.revision;
    this._lastModified = read.lastModified;
    this._size = read.size;
  }

  public readonly id: SourceFileId;

  public static fromDisk(path: FilePath, read: DiskRead): SourceFile {
    return new SourceFile(path, read);
  }

  public get contentVersion(): ContentVersion {
    return this._contentVersion;
  }

  public get text(): string {
    return this._text;
  }

  public get lineCount(): number {
    return this._lineCount;
  }

  public get decodable(): boolean {
    return this._decodable;
  }

  public get revision(): FileRevision {
    return this._revision;
  }

  public applyText(text: string): ContentVersion {
    this.setText(text);
    this._contentVersion += 1;
    return this._contentVersion;
  }

  public rereadFromDisk(read: DiskRead): boolean {
    const changed = this.hasTextChanged(read.text);
    this._revision = read.revision;
    this._lastModified = read.lastModified;
    this._size = read.size;
    if (!changed) return false;

    this.setText(read.text);
    this._contentVersion += 1;
    return true;
  }

  public checkWrite(diskRevision: FileRevision): Result<void, SaveConflict> {
    if (diskRevision === this._revision) return ok(undefined);

    return err({
      fileId: this.id,
      knownRevision: this._revision,
      diskRevision,
    });
  }

  public markWritten(
    revision: FileRevision,
    lastModified: number,
    size: number,
  ): void {
    this._revision = revision;
    this._lastModified = lastModified;
    this._size = size;
  }

  public mayHaveChanged(lastModified: number, size: number): boolean {
    return lastModified !== this._lastModified || size !== this._size;
  }

  private setText(text: string | undefined): void {
    this._text = text ?? "";
    this._lineCount = splitSourceLines(this._text).length;
    this._decodable = text !== undefined;
  }

  private hasTextChanged(text: string | undefined): boolean {
    const decodable = text !== undefined;
    return decodable !== this._decodable || (decodable && text !== this._text);
  }
}
