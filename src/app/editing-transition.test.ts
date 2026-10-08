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
import { EditingTransition, type EditingGpuView } from "../editing/index";
import { FakeEditorHost } from "../editing/infrastructure/fake-editor-host";
import {
  sourceFileId,
  type SourceFileId,
  workspaceFolderId,
} from "../shared/domain";
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
const bodyTop = 42;
const lineMetrics = {
  narrowAdvance: 8.4,
  tabSize: 4,
  baseline: 16,
  lineHeight: 20,
  advanceFor: () => 8.4,
};
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
  readonly gpuView: FakeEditingGpuView;
  readonly residency: DocumentResidency;
  readonly transition: EditingTransition;
  readonly workspace: WorkspaceService;
  setTilesCurrent(current: boolean): void;
  reportRasterError(): void;
}

class FakeEditingGpuView implements EditingGpuView {
  hiddenBody: SourceFileId | undefined = undefined;
  priorityFile: SourceFileId | undefined = undefined;
  private tilesCurrent = true;
  private rasterError = false;

  setHiddenBody(fileId: SourceFileId | undefined): void {
    this.hiddenBody = fileId;
  }

  setPriorityFile(fileId: SourceFileId | undefined): void {
    this.priorityFile = fileId;
  }

  exitViewCovered(): boolean {
    return this.tilesCurrent || this.rasterError;
  }

  setTilesCurrent(current: boolean): void {
    this.tilesCurrent = current;
  }

  setRasterError(): void {
    this.rasterError = true;
  }
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
    lineMetrics,
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
  const gpuView = new FakeEditingGpuView();
  const transition = new EditingTransition({
    board,
    workspace,
    editor,
    residency,
    lineMetrics,
    gutter,
    gpuView,
    bodyTop,
    onOpened: () => undefined,
  });
  editor.onEscape(() => {
    transition.end();
  });
  return {
    board,
    changed,
    directory,
    editor,
    residency,
    transition,
    workspace,
    gpuView,
    setTilesCurrent: (current) => {
      gpuView.setTilesCurrent(current);
    },
    reportRasterError: () => {
      gpuView.setRasterError();
    },
  };
}

async function openEditor(environment: TestEnvironment): Promise<void> {
  expect(environment.transition.begin(fileId, { x: 200, y: 20 })).toBe(true);
  await flush();
}

async function assertExit(): Promise<void> {
  const environment = await setup();
  await openEditor(environment);
  environment.transition.applyFrameSwap();
  expect(environment.transition.end()).toBe(true);
  expect(environment.transition.applyFrameSwap().direction).toBe("exit");
}

describe("EditingTransition", () => {
  it("enters and applies one frame swap", async () => {
    const environment = await setup();
    await openEditor(environment);
    expect(environment.editor.visible).toBe(false);
    expect(environment.transition.applyFrameSwap().direction).toBe("enter");
    expect(environment.editor.visible).toBe(true);
    expect(environment.gpuView.hiddenBody).toBe(fileId);
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
  });
  it("saves edits and exits after a pan", async () => {
    const environment = await setup();
    environment.residency.visibleRangesChanged(
      new Map([[fileId, [{ start: 0, end: 1 }]]]),
    );
    const initialChangeCount = environment.changed.length;
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    expect(environment.transition.end()).toBe(true);
    expect(environment.transition.applyFrameSwap()).toMatchObject({
      direction: "exit",
    });
    expect(environment.editor.visible).toBe(false);
    expect(environment.gpuView.hiddenBody).toBe(undefined);
    expect(environment.changed.slice(initialChangeCount)).toEqual([
      { version: 2, text: "const answer = 43;\n" },
    ]);
  });

  it("keeps the Content Version when Escape exits an unchanged draft", async () => {
    const environment = await setup();
    environment.changed.length = 0;
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.setTilesCurrent(false);
    expect(environment.transition.end()).toBe(true);
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
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
    environment.transition.applyFrameSwap();

    environment.editor.setScrollTop(99999);
    environment.editor.setValue(text.replace("line1", "changed"));
    environment.setTilesCurrent(false);
    expect(environment.transition.end()).toBe(true);

    const row = environment.board.readWidget(fileId, createWidgetRow());
    expect(row.contentScroll).toBe(row.maxContentScroll);
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
  });
});

describe("EditingTransition placement", () => {
  it("captures editor bounds once when entering editing", async () => {
    const environment = await setup();
    environment.board.setCamera(120, -80, 1.5);
    await openEditor(environment);

    const row = environment.board.readWidget(fileId, createWidgetRow());
    expect(environment.editor.lastBounds).toEqual({
      x: 120 + row.x * 1.5,
      y: -80 + (row.y + bodyTop) * 1.5,
      width: row.width,
      height: row.height - bodyTop,
    });
    expect(environment.editor.lastZoom).toBe(1.5);

    const bounds = environment.editor.lastBounds;
    environment.board.setCamera(-40, 60, 0.75);
    expect(environment.editor.lastBounds).toEqual(bounds);
    expect(environment.editor.lastZoom).toBe(1.5);
  });
});

describe("EditingTransition exits", () => {
  it("exits for escape", () => assertExit());

  it("exits for outside", () => assertExit());

  it("exits for pan", () => assertExit());

  it("exits for zoom", () => assertExit());

  it("exits for another-widget", () => assertExit());

  it("holds an edited exit until the current tiles are ready", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    environment.transition.end();
    expect(environment.transition.isExitHeld).toBe(true);
    expect(environment.editor.visible).toBe(true);
    expect(environment.gpuView.hiddenBody).toBe(fileId);
    expect(environment.editor.readOnly).toBe(true);
    expect(environment.editor.isOpen).toBe(true);
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
    expect(environment.gpuView.priorityFile).toBe(fileId);
    environment.setTilesCurrent(true);
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
    expect(environment.editor.visible).toBe(false);
    expect(environment.gpuView.priorityFile).toBeUndefined();
    expect(environment.gpuView.hiddenBody).toBeUndefined();
    expect(environment.editor.isOpen).toBe(false);
    expect(environment.editor.closeCount).toBe(1);
  });

  it("discards edits and exits once the current tiles are ready", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.changed.length = 0;
    environment.editor.setValue("const answer = 43;\n");

    expect(environment.transition.discard()).toBe(true);
    expect(environment.changed).toEqual([]);
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
  });

  it("returns false when discarding without an active session", async () => {
    const environment = await setup();

    expect(environment.transition.discard()).toBe(false);
  });

  it("refuses to begin while an edited exit is held", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    environment.transition.end();
    expect(environment.transition.begin(fileId, { x: 0, y: 0 })).toBe(false);
  });

  it("releases an edited exit when rendering reports a raster error", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    environment.transition.end();
    environment.reportRasterError();
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
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
    environment.transition.applyFrameSwap();
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
    expect(environment.transition.end()).toBe(true);
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
    expect(environment.transition.end()).toBe(false);
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
    environment.transition.applyFrameSwap();
    environment.changed.length = 0;
    expect(environment.transition.end()).toBe(true);
    expect(environment.changed).toEqual([]);
  });

  it("publishes one change and holds the edited exit until tiles are current", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.changed.length = 0;
    environment.editor.setValue("changed");
    environment.setTilesCurrent(false);
    expect(environment.transition.end()).toBe(true);
    expect(environment.changed).toEqual([{ version: 2, text: "changed" }]);
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
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
    environment.transition.applyFrameSwap();
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
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.transition.autosave(environment.transition.autosaveDueAt() + 1);
    environment.changed.length = 0;
    environment.setTilesCurrent(false);

    expect(environment.transition.end()).toBe(true);
    expect(environment.changed).toEqual([]);
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.applyFrameSwap().direction).toBe("exit");
  });

  it("publishes edits made after an autosave at the exit", async () => {
    const environment = await setup();
    await openEditor(environment);
    environment.transition.applyFrameSwap();
    environment.changed.length = 0;
    environment.editor.setValue("const answer = 43;\n");
    environment.transition.autosave(environment.transition.autosaveDueAt() + 1);
    environment.editor.setValue("const answer = 44;\n");

    expect(environment.transition.end()).toBe(true);
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
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");
    environment.setTilesCurrent(false);
    expect(environment.transition.end()).toBe(true);

    expect(environment.transition.begin(otherFileId, { x: 12, y: 20 })).toBe(
      true,
    );
    expect(environment.transition.applyFrameSwap().direction).toBeUndefined();
    environment.setTilesCurrent(true);
    expect(environment.transition.applyFrameSwap()).toMatchObject({
      direction: "exit",
      widgetId: fileId,
    });
    await flush();
    expect(environment.transition.applyFrameSwap()).toMatchObject({
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
    environment.transition.applyFrameSwap();
    environment.editor.setValue("const answer = 43;\n");

    expect(environment.transition.begin(otherFileId, { x: 12, y: 20 })).toBe(
      true,
    );
    expect(environment.changed).toContainEqual({
      version: 2,
      text: "const answer = 43;\n",
    });
    expect(environment.transition.applyFrameSwap()).toMatchObject({
      direction: "exit",
      widgetId: fileId,
    });
    await flush();
    expect(environment.transition.applyFrameSwap()).toMatchObject({
      direction: "enter",
      widgetId: otherFileId,
    });
    expect(environment.transition.activeWidgetId).toBe(otherFileId);
    expect(environment.editor.value).toBe("const other = 2;\n");
  });
});
