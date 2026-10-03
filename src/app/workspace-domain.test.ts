import { describe, expect, it } from "vitest";

import {
  WorkspaceFolder,
  SourceFile,
  filePath,
  fileRevisionOf,
  isSourceFileName,
  isSourceFilePath,
  shouldEnterDirectory,
  type DiskRead,
  type FileRevision,
  type SaveConflict,
} from "../workspace/domain";
import { sourceFileId, workspaceFolderId } from "../shared/domain";

describe("file filter", () => {
  it.each(["a.ts", "b.tsx", "c.d.ts"])(
    "accepts source file name %j",
    (name) => {
      expect(isSourceFileName(name)).toBe(true);
    },
  );

  it.each(["a.js", "a.ts.map", ".hidden.ts"])(
    "rejects source file name %j",
    (name) => {
      expect(isSourceFileName(name)).toBe(false);
    },
  );

  it.each(["node_modules", ".git", "dist", "build", ".cache"])(
    "rejects directory %j",
    (name) => {
      expect(shouldEnterDirectory(name)).toBe(false);
    },
  );

  it.each(["node_modules/x.ts", "src/dist/x.ts", ".github/x.ts"])(
    "rejects filtered path %j",
    (path) => {
      expect(isSourceFilePath(filePath(path))).toBe(false);
    },
  );

  it.each(["src/a.ts", "src/c.d.ts"])("accepts source path %j", (path) => {
    expect(isSourceFilePath(filePath(path))).toBe(true);
  });
});

describe("file revisions", () => {
  it("hashes bytes deterministically and distinguishes byte changes", () => {
    const bytes = new Uint8Array([97, 98, 99]);

    expect(fileRevisionOf(bytes)).toBe(fileRevisionOf(new Uint8Array(bytes)));
    expect(fileRevisionOf(bytes)).toBe("3:11f9f91ac18c8d");
    expect(fileRevisionOf(new Uint8Array([97, 98, 100]))).not.toBe(
      fileRevisionOf(bytes),
    );
    expect(fileRevisionOf(new Uint8Array([0xef, 0xbb, 0xbf]))).not.toBe(
      fileRevisionOf(new Uint8Array()),
    );
  });
});

function diskRead(
  revision: FileRevision,
  text: string | undefined,
  lastModified = 10,
  size = text === undefined ? 0 : text.length,
): DiskRead {
  return { revision, lastModified, size, text };
}

describe("SourceFile text", () => {
  it("starts at version 1 with the disk text and line count", () => {
    const revision = fileRevisionOf(new Uint8Array([1, 2, 3]));
    const file = SourceFile.fromDisk(
      filePath("src/a.ts"),
      diskRead(revision, "one\ntwo"),
    );

    expect(file.contentVersion).toBe(1);
    expect(file.text).toBe("one\ntwo");
    expect(file.lineCount).toBe(2);
    expect(file.decodable).toBe(true);
    expect(file.revision).toBe(revision);
  });

  it("bumps Content Version for a draft without changing File Revision", () => {
    const revision = fileRevisionOf(new Uint8Array([1]));
    const file = SourceFile.fromDisk(
      filePath("a.ts"),
      diskRead(revision, "old"),
    );

    expect(file.applyText("new\ntext")).toBe(2);
    expect(file.contentVersion).toBe(2);
    expect(file.text).toBe("new\ntext");
    expect(file.lineCount).toBe(2);
    expect(file.revision).toBe(revision);
  });

  it("takes a same-text disk reread without bumping Content Version", () => {
    const revision = fileRevisionOf(new Uint8Array([1]));
    const nextRevision = fileRevisionOf(new Uint8Array([2]));
    const file = SourceFile.fromDisk(
      filePath("a.ts"),
      diskRead(revision, "same"),
    );

    expect(file.rereadFromDisk(diskRead(nextRevision, "same", 20, 4))).toBe(
      false,
    );
    expect(file.contentVersion).toBe(1);
    expect(file.revision).toBe(nextRevision);
    expect(file.mayHaveChanged(20, 4)).toBe(false);
  });

  it("bumps Content Version when a disk reread changes the text", () => {
    const revision = fileRevisionOf(new Uint8Array([1]));
    const nextRevision = fileRevisionOf(new Uint8Array([2]));
    const file = SourceFile.fromDisk(
      filePath("a.ts"),
      diskRead(revision, "old"),
    );

    expect(file.rereadFromDisk(diskRead(nextRevision, "new"))).toBe(true);
    expect(file.contentVersion).toBe(2);
    expect(file.text).toBe("new");
  });

  it("represents an undecodable disk read as empty, one-line text", () => {
    const revision = fileRevisionOf(new Uint8Array([0xff]));
    const file = SourceFile.fromDisk(
      filePath("a.ts"),
      diskRead(revision, undefined),
    );

    expect(file.decodable).toBe(false);
    expect(file.text).toBe("");
    expect(file.lineCount).toBe(1);
  });
});

describe("SourceFile writes", () => {
  it("checks writes against the known revision and reports both revisions", () => {
    const revision = fileRevisionOf(new Uint8Array([1]));
    const otherRevision = fileRevisionOf(new Uint8Array([2]));
    const file = SourceFile.fromDisk(
      filePath("a.ts"),
      diskRead(revision, "text"),
    );

    const conflict: SaveConflict = {
      fileId: file.id,
      knownRevision: revision,
      diskRevision: otherRevision,
    };
    expect(file.checkWrite(revision)).toEqual({ ok: true, value: undefined });
    expect(file.checkWrite(otherRevision)).toEqual({
      ok: false,
      error: conflict,
    });
  });

  it("accepts the written revision after markWritten", () => {
    const revision = fileRevisionOf(new Uint8Array([1]));
    const writtenRevision = fileRevisionOf(new Uint8Array([2]));
    const file = SourceFile.fromDisk(
      filePath("a.ts"),
      diskRead(revision, "text"),
    );

    file.markWritten(writtenRevision, 20, 7);

    expect(file.checkWrite(writtenRevision)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(file.checkWrite(revision)).toEqual({
      ok: false,
      error: {
        fileId: file.id,
        knownRevision: writtenRevision,
        diskRevision: revision,
      },
    });
    expect(file.mayHaveChanged(20, 7)).toBe(false);
    expect(file.mayHaveChanged(19, 7)).toBe(true);
    expect(file.mayHaveChanged(20, 6)).toBe(true);
  });
});

describe("WorkspaceFolder", () => {
  it("rejects filtered paths and duplicate Source File ids", () => {
    const folder = new WorkspaceFolder(workspaceFolderId("folder"));
    const revision = fileRevisionOf(new Uint8Array([1]));
    const filtered = SourceFile.fromDisk(
      filePath("node_modules/x.ts"),
      diskRead(revision, "text"),
    );
    const first = SourceFile.fromDisk(
      filePath("src/a.ts"),
      diskRead(revision, "text"),
    );

    expect(() => {
      folder.add(filtered);
    }).toThrow(RangeError);
    folder.add(first);
    expect(() => {
      folder.add(first);
    }).toThrow(RangeError);
  });

  it("returns discovered files in insertion order", () => {
    const folder = new WorkspaceFolder(workspaceFolderId("folder"));
    const revision = fileRevisionOf(new Uint8Array([1]));
    const first = SourceFile.fromDisk(
      filePath("src/z.ts"),
      diskRead(revision, "one\ntwo"),
    );
    const second = SourceFile.fromDisk(
      filePath("a.tsx"),
      diskRead(revision, "only"),
    );
    folder.add(first);
    folder.add(second);

    expect(folder.fileCount).toBe(2);
    expect(folder.file(first.id)).toBe(first);
    expect(folder.discoveredFiles()).toEqual([
      { fileId: first.id, path: first.path, lineCount: 2 },
      { fileId: second.id, path: second.path, lineCount: 1 },
    ]);
    expect(folder.file(sourceFileId("missing.ts"))).toBeUndefined();
  });
});
