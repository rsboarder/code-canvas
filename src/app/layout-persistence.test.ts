import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";

import { BoardService } from "../board/application/board-service";
import { createWidgetRow } from "../board/application/board-read-model";
import type { BoardFile } from "../board/domain/board-file";
import type { BoardMetrics } from "../board/domain/board-metrics";
import { createEventBus } from "../shared/events";
import { sourceFileId, workspaceFolderId } from "../shared/domain";
import type { WorkspaceEvent } from "../workspace";
import { LayoutPersistence } from "../board/infrastructure/layout-persistence";
import { LayoutStore } from "../board/infrastructure/layout-store";

const metrics: BoardMetrics = {
  baseLineHeight: 20,
  headerHeight: 42,
  minimumWidth: 240,
  minimumBodyLines: 3,
  columnWidth: 760,
  gridGap: 40,
  maximumHeight: 900,
  edgeGrabScreenPx: 8,
};
const viewport = { width: 1600, height: 1000 };

function file(path: string, lineCount = 20): BoardFile {
  return {
    fileId: sourceFileId(path),
    path,
    lineCount,
  };
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (condition()) return;
  throw new Error(`Timed out waiting for ${description} after 200 turns.`);
}

function fixture() {
  const events = createEventBus<WorkspaceEvent>();
  const board = new BoardService(metrics, events);
  const storePromise = LayoutStore.open(new IDBFactory());
  return { board, storePromise };
}

afterEach(() => {
  vi.useRealTimers();
});

it("places no widget before the saved layout is loaded", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { board, storePromise } = fixture();
  const store = await storePromise;
  const folderId = workspaceFolderId("folder");
  await store.save(folderId, {
    camera: { x: 10, y: 20, scale: 0.5 },
    widgets: [
      {
        fileId: sourceFileId("a.ts"),
        x: 500,
        y: 300,
        width: 400,
        height: 300,
        contentScroll: 0,
      },
    ],
  });
  const persistence = new LayoutPersistence({
    board,
    store,
    viewport: () => viewport,
  });

  persistence.folderDiscovered(folderId, [file("a.ts"), file("b.ts")]);
  expect(board.widgetCount).toBe(0);
  await waitFor(() => board.widgetCount === 2, "the saved layout to load");

  const row = createWidgetRow();
  board.readWidget(sourceFileId("a.ts"), row);
  expect(row.x).toBe(500);
  expect(row.y).toBe(300);
  expect(board.camera.offsetX).toBe(10);
  expect(board.camera.offsetY).toBe(20);
  expect(board.camera.scale).toBe(0.5);
  expect(board.widgetCount).toBe(2);
  board.readWidget(sourceFileId("b.ts"), row);
  expect(row.x).toBeGreaterThan(500 + 400);
  persistence.dispose();
  store.close();
});

it("autosaves a change within one second, once", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { board, storePromise } = fixture();
  const store = await storePromise;
  const folderId = workspaceFolderId("folder");
  await store.save(folderId, {
    camera: { x: 0, y: 0, scale: 1 },
    widgets: [
      {
        fileId: sourceFileId("a.ts"),
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        contentScroll: 0,
      },
    ],
  });
  const save = vi.spyOn(store, "save");
  const persistence = new LayoutPersistence({
    board,
    store,
    viewport: () => viewport,
  });
  persistence.folderDiscovered(folderId, [file("a.ts")]);
  await waitFor(() => board.widgetCount === 1, "the widget to be restored");
  save.mockClear();

  board.moveWidget(sourceFileId("a.ts"), 700, 0);
  await vi.advanceTimersByTimeAsync(1000);
  const firstSaved = await store.load(folderId);
  expect(firstSaved?.widgets[0]?.x).toBe(700);
  expect(save).toHaveBeenCalledTimes(1);

  board.moveWidget(sourceFileId("a.ts"), 710, 0);
  board.moveWidget(sourceFileId("a.ts"), 720, 0);
  board.moveWidget(sourceFileId("a.ts"), 730, 0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(save).toHaveBeenCalledTimes(2);
  persistence.dispose();
  store.close();
});

it("ignores a load that resolves after a newer folder was discovered", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { board, storePromise } = fixture();
  const store = await storePromise;
  const first = workspaceFolderId("first");
  const second = workspaceFolderId("second");
  let releaseFirst: (() => void) | undefined;
  const firstLoad = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondLoadResolved = false;
  let firstLoadReturned = false;
  const load = vi.spyOn(store, "load").mockImplementation(async (folderId) => {
    if (folderId === first) {
      await firstLoad;
      firstLoadReturned = true;
      return undefined;
    }
    await Promise.resolve();
    secondLoadResolved = true;
    return undefined;
  });
  const persistence = new LayoutPersistence({
    board,
    store,
    viewport: () => viewport,
  });

  persistence.folderDiscovered(first, [file("first.ts")]);
  persistence.folderDiscovered(second, [file("second.ts")]);
  await waitFor(
    () => load.mock.calls.length === 2 && secondLoadResolved,
    "the second folder load",
  );
  expect(releaseFirst).toBeDefined();
  releaseFirst?.();
  await waitFor(() => firstLoadReturned, "the first folder load to return");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(board.folderId).toBe(second);
  expect(board.widgetIdAtFromTop(0)).toBe(sourceFileId("second.ts"));
  persistence.dispose();
  store.close();
});

it("saves the open folder before switching", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { board, storePromise } = fixture();
  const store = await storePromise;
  const first = workspaceFolderId("first");
  const second = workspaceFolderId("second");
  const persistence = new LayoutPersistence({
    board,
    store,
    viewport: () => viewport,
  });
  persistence.folderDiscovered(first, [file("first.ts")]);
  await waitFor(() => board.widgetCount === 1, "the first folder to restore");
  board.moveWidget(sourceFileId("first.ts"), 700, 0);

  persistence.folderDiscovered(second, [file("second.ts")]);
  await waitFor(
    () => board.folderId === second,
    "the second folder to restore",
  );
  const savedFirst = await store.load(first);
  expect(savedFirst?.widgets[0]?.x).toBe(700);
  expect(board.folderId).toBe(second);
  persistence.dispose();
  store.close();
});

it("saves a change made while the switch save is in flight", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { board, storePromise } = fixture();
  const store = await storePromise;
  const first = workspaceFolderId("first");
  const second = workspaceFolderId("second");
  const actualSave = store.save.bind(store);
  let releaseFirstSave: () => void = () => undefined;
  const firstSaveHeld = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  let holdNextSave = true;
  let saveCallCount = 0;
  let resolveFirstSaveStarted: () => void = () => undefined;
  const firstSaveStarted = new Promise<void>((resolve) => {
    resolveFirstSaveStarted = resolve;
  });
  let resolveFirstSaveFinished: () => void = () => undefined;
  const firstSaveFinished = new Promise<void>((resolve) => {
    resolveFirstSaveFinished = resolve;
  });
  let resolveSecondSaveStarted: () => void = () => undefined;
  const secondSaveStarted = new Promise<void>((resolve) => {
    resolveSecondSaveStarted = resolve;
  });
  let secondSaveComplete: Promise<void> | undefined;
  const save = vi
    .spyOn(store, "save")
    .mockImplementation(async (folderId, layout) => {
      saveCallCount += 1;
      if (saveCallCount === 1) resolveFirstSaveStarted();
      if (holdNextSave) {
        holdNextSave = false;
        await firstSaveHeld;
      }
      const completion = actualSave(folderId, layout);
      if (saveCallCount === 1) {
        void completion.then(
          () => {
            resolveFirstSaveFinished();
          },
          () => {
            resolveFirstSaveFinished();
          },
        );
      }
      if (saveCallCount === 2) {
        secondSaveComplete = completion;
        resolveSecondSaveStarted();
      }
      return completion;
    });
  const persistence = new LayoutPersistence({
    board,
    store,
    viewport: () => viewport,
  });
  persistence.folderDiscovered(first, [file("first.ts")]);
  await waitFor(() => board.widgetCount === 1, "the first folder to restore");
  board.moveWidget(sourceFileId("first.ts"), 700, 0);

  vi.advanceTimersByTime(1000);
  await firstSaveStarted;
  expect(save).toHaveBeenCalledTimes(1);
  board.moveWidget(sourceFileId("first.ts"), 710, 0);
  persistence.folderDiscovered(second, [file("second.ts")]);
  releaseFirstSave();
  await firstSaveFinished;
  await secondSaveStarted;
  if (secondSaveComplete === undefined) throw new Error("Missing save.");
  await secondSaveComplete;
  const savedFirst = await store.load(first);
  expect(savedFirst?.widgets[0]?.x).toBe(710);
  persistence.dispose();
  store.close();
});

it("restores the camera when the same folder is reopened", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const factory = new IDBFactory();
  const folderId = workspaceFolderId("folder");
  const firstEvents = createEventBus<WorkspaceEvent>();
  const firstBoard = new BoardService(metrics, firstEvents);
  const firstStore = await LayoutStore.open(factory);
  const firstPersistence = new LayoutPersistence({
    board: firstBoard,
    store: firstStore,
    viewport: () => viewport,
  });
  firstPersistence.folderDiscovered(folderId, [file("a.ts")]);
  await waitFor(
    () => firstBoard.widgetCount === 1,
    "the first folder to restore",
  );
  firstBoard.setCamera(10, 20, 0.5);
  await vi.advanceTimersByTimeAsync(1000);
  firstPersistence.dispose();
  firstStore.close();

  const secondEvents = createEventBus<WorkspaceEvent>();
  const secondBoard = new BoardService(metrics, secondEvents);
  const secondStore = await LayoutStore.open(factory);
  const secondPersistence = new LayoutPersistence({
    board: secondBoard,
    store: secondStore,
    viewport: () => viewport,
  });
  secondPersistence.folderDiscovered(folderId, [file("a.ts")]);
  expect(secondBoard.widgetCount).toBe(0);
  await waitFor(
    () => secondBoard.folderId === folderId,
    "the reopened folder to restore",
  );

  expect(secondBoard.camera.offsetX).toBe(10);
  expect(secondBoard.camera.offsetY).toBe(20);
  expect(secondBoard.camera.scale).toBe(0.5);
  secondPersistence.dispose();
  secondStore.close();
});

it("saves a folder with no saved layout on the next check", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { board, storePromise } = fixture();
  const store = await storePromise;
  const folderId = workspaceFolderId("folder");
  const persistence = new LayoutPersistence({
    board,
    store,
    viewport: () => viewport,
  });
  persistence.folderDiscovered(folderId, [file("a.ts")]);
  await waitFor(() => board.widgetCount === 1, "the folder to restore");

  const row = createWidgetRow();
  board.readWidget(sourceFileId("a.ts"), row);
  expect(row.x).toBe(0);
  expect(row.y).toBe(0);
  expect(await store.load(folderId)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await store.load(folderId)).toEqual(board.savedLayout());
  persistence.dispose();
  store.close();
});
