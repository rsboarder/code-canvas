import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { sourceFileId, workspaceFolderId } from "../../shared/domain";
import type { SavedLayout } from "../domain/saved-layout";
import { LayoutStore } from "./layout-store";

function layout(x: number): SavedLayout {
  return {
    camera: { x, y: 20, scale: 0.5 },
    widgets: [
      {
        fileId: sourceFileId("file-" + String(x) + ".ts"),
        x,
        y: 300,
        width: 400,
        height: 300,
        contentScroll: 10,
      },
    ],
  };
}

describe("LayoutStore", () => {
  it("saves and loads a layout", async () => {
    const store = await LayoutStore.open(new IDBFactory());
    const folderId = workspaceFolderId("folder");
    const saved = layout(10);

    await store.save(folderId, saved);

    await expect(store.load(folderId)).resolves.toEqual(saved);
    store.close();
  });

  it("returns undefined for an unknown folder", async () => {
    const store = await LayoutStore.open(new IDBFactory());

    await expect(
      store.load(workspaceFolderId("missing")),
    ).resolves.toBeUndefined();
    store.close();
  });

  it("keeps layouts for two folders separate", async () => {
    const store = await LayoutStore.open(new IDBFactory());
    const first = workspaceFolderId("first");
    const second = workspaceFolderId("second");
    const firstLayout = layout(10);
    const secondLayout = layout(20);

    await store.save(first, firstLayout);
    await store.save(second, secondLayout);

    await expect(store.load(first)).resolves.toEqual(firstLayout);
    await expect(store.load(second)).resolves.toEqual(secondLayout);
    store.close();
  });

  it("loads a layout through a second store on the same factory", async () => {
    const factory = new IDBFactory();
    const firstStore = await LayoutStore.open(factory);
    const folderId = workspaceFolderId("folder");
    const saved = layout(10);
    await firstStore.save(folderId, saved);
    firstStore.close();

    const secondStore = await LayoutStore.open(factory);

    await expect(secondStore.load(folderId)).resolves.toEqual(saved);
    secondStore.close();
  });
});
