import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { workspaceFolderId } from "../../shared/domain";
import type { SavedFolder } from "./folder-handle-store";
import { FolderHandleStore } from "./folder-handle-store";

function handle(name: string): FileSystemDirectoryHandle {
  return { name } as unknown as FileSystemDirectoryHandle;
}

function saved(id: string, name = id): SavedFolder {
  return { id: workspaceFolderId(id), name, handle: handle(name) };
}

describe("FolderHandleStore", () => {
  it("saves folders and lists them", async () => {
    const store = await FolderHandleStore.open(new IDBFactory());
    const folder = saved("project", "Project folder");

    await store.save(folder);

    await expect(store.all()).resolves.toEqual([folder]);
    store.close();
  });

  it("replaces a folder saved under the same id", async () => {
    const store = await FolderHandleStore.open(new IDBFactory());
    const first = saved("project", "First");
    const replacement = saved("project", "Replacement");

    await store.save(first);
    await store.save(replacement);

    await expect(store.all()).resolves.toEqual([replacement]);
    store.close();
  });

  it("returns the folder marked last", async () => {
    const store = await FolderHandleStore.open(new IDBFactory());
    const folder = saved("project");
    await store.save(folder);

    await store.markLast(folder.id);

    await expect(store.last()).resolves.toEqual(folder);
    store.close();
  });

  it("returns undefined before a folder is marked last", async () => {
    const store = await FolderHandleStore.open(new IDBFactory());

    await expect(store.last()).resolves.toBeUndefined();
    store.close();
  });

  it("returns undefined when the marked folder is gone", async () => {
    const store = await FolderHandleStore.open(new IDBFactory());

    await store.markLast(workspaceFolderId("missing"));

    await expect(store.last()).resolves.toBeUndefined();
    store.close();
  });

  it("persists records and last-folder state across a reload", async () => {
    const factory = new IDBFactory();
    const firstStore = await FolderHandleStore.open(factory);
    const folder = saved("project", "Project folder");
    await firstStore.save(folder);
    await firstStore.markLast(folder.id);
    firstStore.close();

    const reloadedStore = await FolderHandleStore.open(factory);

    await expect(reloadedStore.all()).resolves.toEqual([folder]);
    await expect(reloadedStore.last()).resolves.toEqual(folder);
    reloadedStore.close();
  });
});
