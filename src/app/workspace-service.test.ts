import { describe, expect, it } from "vitest";

import {
  WorkspaceService,
  filePath,
  type PickedFolder,
  type ReadForEditing,
  type WorkspaceEvent,
} from "../workspace";
import { InMemoryDirectory } from "../workspace/infrastructure/in-memory-directory";
import { createEventBus } from "../shared/events";
import { sourceFileId, workspaceFolderId } from "../shared/domain";

const folder: PickedFolder = {
  id: workspaceFolderId("project-folder"),
  name: "project",
};

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sourceFiles(count: number, prefix = "file"): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index);
    files.set(`${prefix}-${suffix}.ts`, bytes(`const file = ${suffix};`));
  }
  return files;
}

function serviceFor(
  files: ReadonlyMap<string, Uint8Array>,
  bus = createEventBus<WorkspaceEvent>(),
): {
  readonly directory: InMemoryDirectory;
  readonly service: WorkspaceService;
  readonly events: WorkspaceEvent[];
} {
  const directory = new InMemoryDirectory(files);
  directory.setPickedFolder(folder);
  const events: WorkspaceEvent[] = [];
  bus.subscribe("FilesDiscovered", (event) => events.push(event));
  bus.subscribe("FileContentChanged", (event) => events.push(event));
  bus.subscribe("DraftWritten", (event) => events.push(event));
  bus.subscribe("DraftWriteFailed", (event) => events.push(event));
  return {
    directory,
    service: new WorkspaceService(directory, directory, bus),
    events,
  };
}

async function openedService(): Promise<ReturnType<typeof serviceFor>> {
  const context = serviceFor(new Map([["a.ts", bytes("original")]]));
  await context.service.openFolder();
  context.events.length = 0;
  return context;
}

const fileId = sourceFileId("a.ts");

it("Project folder", async () => {
  const files = sourceFiles(200, "src/file");
  files.set("node_modules/ignored.ts", bytes("ignored"));
  files.set(".git/ignored.ts", bytes("ignored"));
  const { service, events } = serviceFor(files);

  const outcome = await service.openFolder();

  expect(outcome).toEqual({
    kind: "opened",
    folderId: folder.id,
    fileCount: 200,
    overLimit: false,
  });
  expect(events[0]).toMatchObject({
    type: "FilesDiscovered",
    folderId: folder.id,
  });
  const discovered = events[0];
  expect(discovered?.type).toBe("FilesDiscovered");
  if (discovered?.type === "FilesDiscovered") {
    expect(discovered.files).toHaveLength(200);
    expect(discovered.files.every((file) => file.path.startsWith("src/"))).toBe(
      true,
    );
  }
});

it("Empty folder", async () => {
  const { service, events } = serviceFor(
    new Map([
      ["README.md", bytes("read me")],
      ["a.js", bytes("ignored")],
    ]),
  );

  await expect(service.openFolder()).resolves.toEqual({
    kind: "empty",
    folderId: folder.id,
  });
  expect(events).toEqual([]);
});

it("Unsupported browser", async () => {
  const { service, directory, events } = serviceFor(
    new Map([["a.ts", bytes("const a = 1;")]]),
  );
  directory.setSupported(false);

  await expect(service.openFolder()).resolves.toEqual({
    kind: "unsupported",
  });
  expect(directory.pickCount).toBe(0);
  expect(events).toEqual([]);
});

it("Folder larger than 200 files", async () => {
  const largeFiles = sourceFiles(350);
  const large = serviceFor(largeFiles);

  await expect(large.service.openFolder()).resolves.toMatchObject({
    kind: "opened",
    fileCount: 350,
    overLimit: true,
  });
  expect(large.events[0]?.type).toBe("FilesDiscovered");
  if (large.events[0]?.type === "FilesDiscovered") {
    expect(large.events[0].files).toHaveLength(350);
  }

  const guaranteed = serviceFor(sourceFiles(200));
  await expect(guaranteed.service.openFolder()).resolves.toMatchObject({
    kind: "opened",
    fileCount: 200,
    overLimit: false,
  });
});

it("returns cancelled when the folder picker is cancelled", async () => {
  const { service, directory, events } = serviceFor(
    new Map([["a.ts", bytes("const a = 1;")]]),
  );
  directory.setPickedFolder(undefined);

  await expect(service.openFolder()).resolves.toEqual({ kind: "cancelled" });
  expect(events).toEqual([]);
});

describe("WorkspaceService events", () => {
  it("publishes discovery before decodable content and omits invalid UTF-8 content", async () => {
    const files = new Map([
      ["first.ts", bytes("one\ntwo")],
      ["invalid.ts", new Uint8Array([0xc3, 0x28])],
      ["last.tsx", bytes("last")],
    ]);
    const { service, events } = serviceFor(files);

    await service.openFolder();

    expect(events.map((event) => event.type)).toEqual([
      "FilesDiscovered",
      "FileContentChanged",
      "FileContentChanged",
    ]);
    expect(events[1]).toMatchObject({
      type: "FileContentChanged",
      fileId: "first.ts",
      contentVersion: 1,
      text: "one\ntwo",
      lineCount: 2,
    });
    expect(events[2]).toMatchObject({
      type: "FileContentChanged",
      fileId: "last.tsx",
      contentVersion: 1,
      text: "last",
      lineCount: 1,
    });
    expect(events[0]?.type).toBe("FilesDiscovered");
    if (events[0]?.type === "FilesDiscovered") {
      expect(events[0].files.map((file) => file.path)).toEqual([
        filePath("first.ts"),
        filePath("invalid.ts"),
        filePath("last.tsx"),
      ]);
    }
  });
});

describe("WorkspaceService restart", () => {
  it("Restart", async () => {
    const { service, directory, events } = serviceFor(
      new Map([["a.ts", bytes("const a = 1;")]]),
    );
    await service.openFolder();
    events.length = 0;

    const reopened = await service.reopenLastFolder();

    expect(reopened).toMatchObject({ kind: "opened", folderId: folder.id });
    expect(events[0]?.type).toBe("FilesDiscovered");
    directory.setPermission(false);
    events.length = 0;
    await expect(service.reopenLastFolder()).resolves.toEqual({
      kind: "permission-denied",
    });
    expect(events).toEqual([]);

    directory.setLastFolder(undefined);
    await expect(service.reopenLastFolder()).resolves.toEqual({
      kind: "no-last-folder",
    });
  });

  it("returns the remembered folder name for the reopen offer", async () => {
    const { service, directory } = serviceFor(new Map());
    directory.setLastFolder(folder);

    await expect(service.lastFolderName()).resolves.toBe("project");
  });
});

it("Conflict with an external change (compare-and-swap detects writes before the pre-write reread only)", async () => {
  const { service, directory } = await openedService();
  const initial = await directory.readFile(folder, filePath("a.ts"));
  await expect(service.readForEditing(fileId)).resolves.toMatchObject({
    kind: "ready",
    path: filePath("a.ts"),
    text: "original",
    contentVersion: 1,
  });

  const draft = service.applyDraft(fileId, "draft");
  directory.writeExternally("a.ts", bytes("external"));

  await expect(draft.written).resolves.toMatchObject({
    kind: "conflict",
    conflict: {
      fileId,
      knownRevision: initial.revision,
    },
  });
  await expect(
    directory.readFile(folder, filePath("a.ts")),
  ).resolves.toMatchObject({
    text: "external",
  });
});

it("publishes a save conflict when a write meets a changed disk revision", async () => {
  const bus = createEventBus<WorkspaceEvent>();
  const conflicts: WorkspaceEvent[] = [];
  bus.subscribe("SaveConflictDetected", (event) => conflicts.push(event));
  const directory = new InMemoryDirectory(
    new Map([["a.ts", bytes("original")]]),
  );
  directory.setPickedFolder(folder);
  const service = new WorkspaceService(directory, directory, bus);
  await service.openFolder();

  const draft = service.applyDraft(fileId, "draft");
  directory.writeExternally("a.ts", bytes("external"));
  await draft.written;

  expect(conflicts).toEqual([{ type: "SaveConflictDetected", fileId }]);
});

it("rereads an external change without unsaved edits and publishes the new version", async () => {
  const { service, directory, events } = await openedService();
  directory.writeExternally("a.ts", bytes("from disk\nnow"));

  const result = await service.readForEditing(fileId);

  expect(result).toEqual({
    kind: "ready",
    path: filePath("a.ts"),
    text: "from disk\nnow",
    contentVersion: 2,
  });
  expect(events).toEqual([
    expect.objectContaining({
      type: "FileContentChanged",
      fileId,
      contentVersion: 2,
      text: "from disk\nnow",
      lineCount: 2,
    }),
  ]);
});

it("reports a reread conflict with unsaved edits without publishing or overwriting text", async () => {
  const { service, directory, events } = await openedService();
  const draft = service.applyDraft(fileId, "in app");
  events.length = 0;
  directory.writeExternally("a.ts", bytes("external"));

  await expect(service.readForEditing(fileId)).resolves.toMatchObject({
    kind: "conflict",
    text: "in app",
    contentVersion: 2,
    conflict: { fileId },
  });
  expect(events).toEqual([]);
  await draft.written;
});

it("publishes a save conflict when rereading for editing", async () => {
  const bus = createEventBus<WorkspaceEvent>();
  const conflicts: WorkspaceEvent[] = [];
  bus.subscribe("SaveConflictDetected", (event) => conflicts.push(event));
  const directory = new InMemoryDirectory(
    new Map([["a.ts", bytes("original")]]),
  );
  directory.setPickedFolder(folder);
  const service = new WorkspaceService(directory, directory, bus);
  await service.openFolder();

  const draft = service.applyDraft(fileId, "in app");
  directory.writeExternally("a.ts", bytes("external"));
  await service.readForEditing(fileId);
  await draft.written;

  expect(conflicts).toHaveLength(2);
});

it("resolves a save conflict with the disk version and clears the draft", async () => {
  const { service, directory, events } = await openedService();
  const draft = service.applyDraft(fileId, "in app");
  directory.writeExternally("a.ts", bytes("external"));
  await draft.written;
  events.length = 0;

  await expect(service.resolveConflict(fileId, "disk")).resolves.toBe(true);

  expect(events).toEqual([
    expect.objectContaining({
      type: "FileContentChanged",
      fileId,
      text: "external",
    }),
  ]);
  const writeCount = directory.writeCount;
  service.retryFailedWrites();
  await flush();
  expect(directory.writeCount).toBe(writeCount);
});

it("resolves a save conflict with the in-memory version", async () => {
  const { service, directory, events } = await openedService();
  const draft = service.applyDraft(fileId, "in app");
  directory.writeExternally("a.ts", bytes("external"));
  await draft.written;
  events.length = 0;

  await expect(service.resolveConflict(fileId, "mine")).resolves.toBe(true);

  await expect(
    directory.readFile(folder, filePath("a.ts")),
  ).resolves.toMatchObject({ text: "in app" });
  expect(events).toEqual([
    { type: "DraftWritten", fileId, contentVersion: draft.contentVersion },
  ]);
});

it("publishes a draft synchronously and writes its version", async () => {
  const { service, events } = await openedService();

  const applied = service.applyDraft(fileId, "one\ntwo");

  expect(applied.contentVersion).toBe(2);
  expect(events).toEqual([
    expect.objectContaining({
      type: "FileContentChanged",
      fileId,
      contentVersion: 2,
      text: "one\ntwo",
      lineCount: 2,
    }),
  ]);
  await expect(applied.written).resolves.toEqual({
    kind: "written",
    contentVersion: 2,
  });
  await expect(service.readForEditing(fileId)).resolves.toEqual({
    kind: "ready",
    path: filePath("a.ts"),
    text: "one\ntwo",
    contentVersion: 2,
  });
});

it("serializes two quick drafts and leaves the second draft on disk", async () => {
  const { service, directory } = await openedService();
  const release = directory.holdWrites();
  const first = service.applyDraft(fileId, "first");
  await Promise.resolve();
  const second = service.applyDraft(fileId, "second");
  await Promise.resolve();

  expect(directory.writeCount).toBe(1);
  release();
  await expect(first.written).resolves.toMatchObject({ kind: "written" });
  await expect(second.written).resolves.toEqual({
    kind: "written",
    contentVersion: 3,
  });
  await expect(
    directory.readFile(folder, filePath("a.ts")),
  ).resolves.toMatchObject({
    text: "second",
  });
});

it("keeps unsaved edits after a failed write", async () => {
  const { service, directory } = await openedService();
  directory.failNextWrite();

  const applied = service.applyDraft(fileId, "still in app");

  await expect(applied.written).resolves.toEqual({ kind: "failed" });
  directory.writeExternally("a.ts", bytes("changed outside"));
  await expect(service.readForEditing(fileId)).resolves.toMatchObject({
    kind: "conflict",
    text: "still in app",
  });
});

it("returns unavailable for an unknown id and throws when applying its draft", async () => {
  const { service } = await openedService();
  const unknownId = sourceFileId("missing.ts");

  await expect(service.readForEditing(unknownId)).resolves.toEqual({
    kind: "unavailable",
  });
  expect(() => service.applyDraft(unknownId, "text")).toThrow(RangeError);
});

it("returns unavailable when rereading the open file fails", async () => {
  const { service, directory } = await openedService();
  directory.failNextRead();

  await expect(service.readForEditing(fileId)).resolves.toEqual({
    kind: "unavailable",
  } satisfies ReadForEditing);
});

it("publishes write failure and retries the current draft", async () => {
  const { service, directory, events } = await openedService();
  directory.failNextWrite();

  const applied = service.applyDraft(fileId, "still in app");
  events.length = 0;
  await expect(applied.written).resolves.toEqual({ kind: "failed" });
  expect(events).toEqual([{ type: "DraftWriteFailed", fileId }]);

  events.length = 0;
  service.retryFailedWrites();
  await flush();
  await expect(
    directory.readFile(folder, filePath("a.ts")),
  ).resolves.toMatchObject({ text: "still in app" });
  expect(events).toEqual([
    { type: "DraftWritten", fileId, contentVersion: applied.contentVersion },
  ]);
});

it("publishes a successful draft write", async () => {
  const { service, events } = await openedService();

  const applied = service.applyDraft(fileId, "written");
  await applied.written;

  expect(events).toEqual([
    {
      type: "FileContentChanged",
      fileId,
      contentVersion: 2,
      text: "written",
      lineCount: 1,
    },
    { type: "DraftWritten", fileId, contentVersion: applied.contentVersion },
  ]);
});

it("does not retry after a newer draft writes successfully", async () => {
  const { service, directory, events } = await openedService();
  directory.failNextWrite();
  await expect(service.applyDraft(fileId, "first").written).resolves.toEqual({
    kind: "failed",
  });
  events.length = 0;

  await service.applyDraft(fileId, "second").written;
  const writeCount = directory.writeCount;
  events.length = 0;
  service.retryFailedWrites();
  await flush();

  expect(directory.writeCount).toBe(writeCount);
  expect(events).toEqual([]);
});

it("forgets failed writes when opening the folder again", async () => {
  const { service, directory, events } = await openedService();
  directory.failNextWrite();
  await expect(service.applyDraft(fileId, "failed").written).resolves.toEqual({
    kind: "failed",
  });
  events.length = 0;

  await service.openFolder();
  events.length = 0;
  service.retryFailedWrites();
  await flush();

  expect(directory.writeCount).toBe(0);
  expect(events).toEqual([]);
});
