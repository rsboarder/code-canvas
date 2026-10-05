import { describe, expect, it, vi } from "vitest";

import {
  BoardService,
  createWidgetRow,
  type BoardMetrics,
} from "../board/index";
import {
  DocumentResidency,
  LineNumberGutter,
  type Tokenizer,
} from "../code-view/index";
import {
  EditingTransition,
  type EditingEndReason,
  type PendingGesture,
} from "../editing/index";
import { FakeEditorHost } from "../editing/infrastructure/fake-editor-host";
import { sourceFileId, workspaceFolderId } from "../shared/domain";
import { createEventBus } from "../shared/events";
import {
  WorkspaceService,
  type DiscoveredFile,
  type WorkspaceEvent,
} from "../workspace/index";
import { InMemoryDirectory } from "../workspace/infrastructure/in-memory-directory";

const folder = { id: workspaceFolderId("editing-tests"), name: "editing" };
const fileId = sourceFileId("file.ts");
const gutter = new LineNumberGutter(8.4);
const metrics: BoardMetrics = {
  baseLineHeight: 20,
  headerHeight: 24,
  minimumWidth: 240,
  minimumBodyLines: 3,
  columnWidth: 760,
  gridGap: 40,
  maximumHeight: 900,
  edgeGrabScreenPx: 8,
};

interface TestEnvironment {
  readonly board: BoardService;
  readonly changed: { version: number; text: string }[];
  readonly directory: InMemoryDirectory;
  readonly editor: FakeEditorHost;
  readonly residency: DocumentResidency;
  readonly transition: EditingTransition;
  readonly workspace: WorkspaceService;
  setTilesCurrent(current: boolean): void;
  reportRasterError(): void;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function directoryFiles(
  text: string,
  extraFiles: ReadonlyMap<string, string>,
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([["file.ts", bytes(text)]]);
  for (const [path, content] of extraFiles) files.set(path, bytes(content));
  return files;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function longSource(lineCount = 100): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `const line${String(index + 1)} = ${String(index + 1)};`,
  ).join("\n");
}

async function setup(
  text = "const answer = 42;\n",
  extraFiles: ReadonlyMap<string, string> = new Map(),
): Promise<TestEnvironment> {
  const events = createEventBus<WorkspaceEvent>();
  const board = new BoardService(metrics, events);
  const directory = new InMemoryDirectory(directoryFiles(text, extraFiles));
  directory.setPickedFolder(folder);
  const workspace = new WorkspaceService(directory, directory, events);
  const changed: { version: number; text: string }[] = [];
  const tokenizer: Tokenizer = {
    contentChanged: (_id, version, content) => {
      changed.push({ version, text: content });
    },
    wanted: () => undefined,
    subscribe: () => () => undefined,
  };
  const residency = new DocumentResidency({
    tokenizer,
    lineMetrics: {
      narrowAdvance: 8.4,
      tabSize: 4,
      baseline: 16,
      lineHeight: 20,
      advanceFor: () => 8.4,
    },
  });
  events.subscribe("FileContentChanged", (event) => {
    residency.contentChanged(event.fileId, event.contentVersion, event.text);
  });
  let discovered: readonly DiscoveredFile[] = [];
  let folderId = folder.id;
  events.subscribe("FilesDiscovered", (event) => {
    discovered = event.files;
    folderId = event.folderId;
  });
  await workspace.openFolder();
  board.restoreBoard(folderId, discovered, undefined, {
    width: 1200,
    height: 800,
  });

  const editor = new FakeEditorHost();
  let tilesCurrent = true;
  let rasterError = false;
  const transition = new EditingTransition({
    board,
    workspace,
    editor,
    residency,
    lineMetrics: {
      narrowAdvance: 8.4,
      tabSize: 4,
      baseline: 16,
      lineHeight: 20,
      advanceFor: () => 8.4,
    },
    gutter,
    tilesCurrent: () => tilesCurrent || rasterError,
    onOpened: () => undefined,
  });
  editor.onEscape(() => {
    transition.end("escape");
  });
  return {
    board,
    changed,
    directory,
    editor,
    residency,
    transition,
    workspace,
    setTilesCurrent: (current) => {
      tilesCurrent = current;
    },
    reportRasterError: () => {
      rasterError = true;
    },
  };
}

async function openEditor(environment: TestEnvironment): Promise<void> {
  expect(environment.transition.begin(fileId, { x: 200, y: 20 })).toBe(true);
  await flush();
}

async function assertExit(
  reason: EditingEndReason,
  pendingGesture?: PendingGesture,
): Promise<void> {
  const environment = await setup();
  await openEditor(environment);
  environment.transition.takeFrameSwap();
  expect(environment.transition.end(reason, pendingGesture)).toBe(true);
  expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
}

describe("EditingTransition", () => {
  it("enters and applies one frame swap", async () => {
    const environment = await setup();
    await openEditor(environment);
    expect(environment.editor.visible).toBe(false);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("enter");
    expect(environment.editor.visible).toBe(true);
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
  });
  it("saves edits and exits with the pending pan", async () => {
    const environment = await setup();
    environment.residency.visibleRangesChanged(
      new Map([[fileId, [{ start: 0, end: 1 }]]]),
    );
    const initialChangeCount = environment.changed.length;
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    expect(environment.transition.end("pan", { kind: "pan", x: 8, y: 2 })).toBe(
      true,
    );
    expect(environment.transition.takeFrameSwap()).toMatchObject({
      direction: "exit",
      pendingGesture: { kind: "pan" },
    });
    expect(environment.editor.visible).toBe(false);
    expect(environment.changed.slice(initialChangeCount)).toEqual([
      { version: 2, text: "const answer = 43;\n" },
    ]);
  });

  it("keeps the Content Version when Escape exits an unchanged draft", async () => {
    const environment = await setup();
    environment.changed.length = 0;
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.setTilesCurrent(false);
    expect(environment.transition.end("escape")).toBe(true);
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
    expect(environment.editor.closeCount).toBe(1);
    expect(environment.changed).toEqual([]);
    expect(environment.transition.activeWidgetId).toBeUndefined();
  });

  it("keeps the camera scale when entering editing", async () => {
    const environment = await setup();
    environment.board.setCamera(0, 0, 1.37);
    await openEditor(environment);
    expect(environment.board.camera.scale).toBe(1.37);
  });

  it("hands the widget scroll to Monaco on enter and back on exit", async () => {
    const text = longSource();
    const environment = await setup(text);
    expect(environment.board.scrollWidget(fileId, 300)).toBe(300);

    await openEditor(environment);
    expect(environment.editor.getScrollTop()).toBe(300);
    environment.transition.takeFrameSwap();

    environment.editor.setScrollTop(99999);
    environment.editor.setValue(text.replace("line1", "changed"));
    environment.setTilesCurrent(false);
    expect(environment.transition.end("escape")).toBe(true);

    const row = environment.board.readWidget(fileId, createWidgetRow());
    expect(row.contentScroll).toBe(row.maxContentScroll);
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
  });
});

describe("EditingTransition exits", () => {
  it("exits for escape", () => assertExit("escape"));

  it("exits for outside", () => assertExit("outside"));

  it("exits for pan", () => assertExit("pan", { kind: "pan", x: 8, y: 2 }));

  it("exits for zoom", () =>
    assertExit("zoom", { kind: "zoom", x: 20, y: 12 }));

  it("exits for another-widget", () => assertExit("another-widget"));

  it("holds an edited exit until the current tiles are ready", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    environment.transition.end("escape");
    expect(environment.transition.isExitHeld).toBe(true);
    expect(environment.editor.visible).toBe(true);
    expect(environment.editor.readOnly).toBe(true);
    expect(environment.editor.isOpen).toBe(true);
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
    expect(environment.editor.visible).toBe(false);
    expect(environment.editor.isOpen).toBe(false);
    expect(environment.editor.closeCount).toBe(1);
  });

  it("discards edits and exits once the current tiles are ready", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.changed.length = 0;
    environment.editor.setValue("const answer = 43;\n");

    expect(environment.transition.discard()).toBe(true);
    expect(environment.changed).toEqual([]);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
  });

  it("returns false when discarding without an active session", async () => {
    const environment = await setup();

    expect(environment.transition.discard()).toBe(false);
  });

  it("refuses to begin while an edited exit is held", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    environment.transition.end("escape");
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(false);
  });

  it("releases an edited exit when rendering reports a raster error", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    environment.transition.end("escape");
    environment.reportRasterError();
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
    expect(environment.editor.visible).toBe(false);
    expect(environment.editor.isOpen).toBe(false);
  });
});

describe("EditingTransition editor port", () => {
  it("does not enter twice while a session is active", async () => {
    const environment = await setup();
    await openEditor(environment);
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(false);
  });

  it("routes Escape only after Monaco closes suggestions and search", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.suggestWidgetOpen = true;
    environment.editor.triggerEscape();
    expect(environment.transition.isEditing).toBe(true);
    environment.editor.suggestWidgetOpen = false;
    environment.editor.findWidgetOpen = true;
    environment.editor.triggerEscape();
    expect(environment.transition.isEditing).toBe(true);
    environment.editor.findWidgetOpen = false;
    environment.editor.triggerEscape();
    expect(environment.transition.isEditing).toBe(false);
  });

  it("reports the active model line count through the editor host", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.editor.setValue("one\ntwo\nthree\n");
    expect(environment.editor.getLineCount()).toBe(4);
  });

  it("reports content changes since opening through the editor host", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.editor.setValue("changed");
    expect(environment.transition.end("escape")).toBe(true);
    expect(environment.changed[environment.changed.length - 1]).toEqual({
      version: 2,
      text: "changed",
    });
  });
});

describe("EditingTransition workspace reads", () => {
  it("re-reads a changed file on begin", async () => {
    const environment = await setup();
    environment.directory.writeExternally("file.ts", bytes("from disk"));
    await openEditor(environment);
    expect(environment.editor.value).toBe("from disk");
  });

  it("opens nothing for a conflict or unavailable file", async () => {
    const environment = await setup();
    const applied = environment.workspace.applyDraft(fileId, "in app");
    environment.directory.writeExternally("file.ts", bytes("external"));
    await applied.written;
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(true);
    await flush();
    expect(environment.editor.openCount).toBe(0);
    expect(
      environment.transition.begin(sourceFileId("missing.ts"), {
        x: 0,
        y: 0,
      }),
    ).toBe(true);
    await flush();
    expect(environment.editor.openCount).toBe(0);
  });

  it("cancels a pending read before it opens", async () => {
    const environment = await setup();
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(true);
    expect(environment.transition.end("outside")).toBe(false);
    await flush();
    expect(environment.editor.preparedCount).toBe(0);
    expect(environment.editor.openCount).toBe(0);
    expect(environment.transition.isEditing).toBe(false);
  });

  it("uses the content point for the cursor", async () => {
    const environment = await setup("abcdef\ntwo\nthree\n");
    expect(
      environment.transition.begin(fileId, {
        x: gutter.codeLeft(4) + 35.6,
        y: 0,
      }),
    ).toBe(true);
    await flush();
    expect(environment.editor.lastCursor).toEqual({ lineNumber: 1, column: 5 });
  });

  it("does not open after detail level changes from Text", async () => {
    const environment = await setup();
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(true);
    environment.board.setCamera(0, 0, 0.1);
    expect(environment.board.updateDetailLevel(1, true)).toBe("minimap");
    await flush();
    expect(environment.editor.openCount).toBe(0);
  });

  it("exits without publishing when opened without a change", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.changed.length = 0;
    expect(environment.transition.end("outside")).toBe(true);
    expect(environment.changed).toEqual([]);
  });

  it("publishes one change and holds the edited exit until tiles are current", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.changed.length = 0;
    environment.editor.setValue("changed");
    environment.setTilesCurrent(false);
    expect(environment.transition.end("another-widget")).toBe(true);
    expect(environment.changed).toEqual([{ version: 2, text: "changed" }]);
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
  });
});

describe("EditingTransition model preparation", () => {
  it("prepares the model before opening the editor", async () => {
    const environment = await setup();
    await openEditor(environment);
    expect(environment.editor.preparedCount).toBe(1);
    expect(environment.editor.lastPrepared).toEqual({
      text: "const answer = 42;\n",
      language: "typescript",
    });
    expect(environment.editor.openCount).toBe(1);
    expect(environment.editor.lastOptions?.text).toBe(
      environment.editor.lastPrepared?.text,
    );
  });
});

describe("EditingTransition autosave", () => {
  it("publishes when due and then has no autosave pending", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.changed.length = 0;
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    environment.editor.setValue("const answer = 43;\n");
    const dueAt = environment.transition.autosaveDueAt();

    try {
      expect(environment.transition.autosave(dueAt - 1)).toBe(false);
      expect(environment.changed).toEqual([]);
      expect(environment.transition.autosave(dueAt)).toBe(true);
      expect(environment.changed).toEqual([
        { version: 2, text: "const answer = 43;\n" },
      ]);
      expect(environment.transition.autosaveDueAt()).toBe(Infinity);
    } finally {
      clock.mockRestore();
    }
  });

  it("holds an exit after an autosave until its tiles are current", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.transition.autosave(environment.transition.autosaveDueAt() + 1);
    environment.changed.length = 0;
    environment.setTilesCurrent(false);

    expect(environment.transition.end("escape")).toBe(true);
    expect(environment.changed).toEqual([]);
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.takeFrameSwap()?.direction).toBe("exit");
  });

  it("publishes edits made after an autosave at the exit", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.changed.length = 0;
    environment.editor.setValue("const answer = 43;\n");
    environment.transition.autosave(environment.transition.autosaveDueAt() + 1);
    environment.editor.setValue("const answer = 44;\n");

    expect(environment.transition.end("escape")).toBe(true);
    expect(environment.changed).toEqual([
      { version: 2, text: "const answer = 43;\n" },
      { version: 3, text: "const answer = 44;\n" },
    ]);
  });

  it("does not autosave without a session or while a read is pending", async () => {
    const environment = await setup();

    expect(environment.transition.autosave(Number.MAX_SAFE_INTEGER)).toBe(
      false,
    );
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(true);
    expect(environment.transition.autosave(Number.MAX_SAFE_INTEGER)).toBe(
      false,
    );
  });
});

describe("EditingTransition switches widgets", () => {
  it("starts a remembered widget after a held exit", async () => {
    const environment = await setup(
      "const answer = 42;\n",
      new Map([["other.ts", "const other = 2;\n"]]),
    );
    const otherFileId = sourceFileId("other.ts");
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    expect(environment.transition.end("outside")).toBe(true);

    expect(environment.transition.begin(otherFileId, { x: 12, y: 20 })).toBe(
      true,
    );
    expect(environment.transition.takeFrameSwap()).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.takeFrameSwap()).toMatchObject({
      direction: "exit",
      widgetId: fileId,
    });
    await flush();
    expect(environment.transition.takeFrameSwap()).toMatchObject({
      direction: "enter",
      widgetId: otherFileId,
    });
    expect(environment.transition.activeWidgetId).toBe(otherFileId);
    expect(environment.editor.value).toBe("const other = 2;\n");
  });

  it("publishes edits before switching to another widget", async () => {
    const environment = await setup(
      "const answer = 42;\n",
      new Map([["other.ts", "const other = 2;\n"]]),
    );
    const otherFileId = sourceFileId("other.ts");
    await openEditor(environment);
    environment.transition.takeFrameSwap();
    environment.editor.setValue("const answer = 43;\n");

    expect(environment.transition.begin(otherFileId, { x: 12, y: 20 })).toBe(
      true,
    );
    expect(environment.changed).toContainEqual({
      version: 2,
      text: "const answer = 43;\n",
    });
    expect(environment.transition.takeFrameSwap()).toMatchObject({
      direction: "exit",
      widgetId: fileId,
    });
    await flush();
    expect(environment.transition.takeFrameSwap()).toMatchObject({
      direction: "enter",
      widgetId: otherFileId,
    });
    expect(environment.transition.activeWidgetId).toBe(otherFileId);
    expect(environment.editor.value).toBe("const other = 2;\n");
  });
});
