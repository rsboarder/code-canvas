import type { Brand } from "./brand";

export type SourceFileId = Brand<string, "SourceFileId">;
export type WorkspaceFolderId = Brand<string, "WorkspaceFolderId">;

export function sourceFileId(value: string): SourceFileId {
  if (value === "") {
    throw new RangeError("SourceFileId cannot be empty.");
  }
  return value as SourceFileId;
}

export function workspaceFolderId(value: string): WorkspaceFolderId {
  if (value === "") {
    throw new RangeError("WorkspaceFolderId cannot be empty.");
  }
  return value as WorkspaceFolderId;
}
