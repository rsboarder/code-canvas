import { Camera } from "../../board/index";
import { DocumentResidency, type Tokenizer } from "../../code-view/index";
import type { EditorHost } from "./editor-host";
import { EditingTransition, type EditingSource } from "./editing-transition";

interface TestAssertions {
  readonly equal: (actual: unknown, expected: unknown) => void;
  readonly match: (actual: unknown, expected: unknown) => void;
  readonly true: (actual: boolean) => void;
}

type TestRunner = (name: string, callback: () => void) => void;

interface TestEditorHost extends EditorHost {
  value: string;
  visible: boolean;
  closeCount: number;
  isOpen: boolean;
  readOnly: boolean;
  suggestWidgetOpen: boolean;
  findWidgetOpen: boolean;
  triggerEscape(): void;
}

function setup(createEditor: () => TestEditorHost) {
  const source: EditingSource = {
    widgetId: "file.ts",
    path: "file.ts",
    text: "const answer = 42;\n",
    contentVersion: 1,
    frame: { x: 0, y: 0, width: 600, height: 120 },
  };
  const editor = createEditor();
  let tilesCurrent = true;
  let rasterError = false;
  const changed: { version: number; text: string }[] = [];
  const uploaded: string[] = [];
  const residency = new DocumentResidency({
    contentChanged: (_fileId, version, text) => {
      changed.push({ version, text });
    },
    wanted: () => undefined,
  } satisfies Tokenizer);
  const camera = new Camera({ x: 0, y: 0 }, 1.37);
  const transition = new EditingTransition({
    camera,
    editor,
    residency,
    readSource: () => source,
    tilesCurrent: () => tilesCurrent || rasterError,
  });
  editor.onEscape(() => {
    transition.end("escape");
  });
  return {
    camera,
    changed,
    editor,
    residency,
    setTilesCurrent: (current: boolean) => {
      tilesCurrent = current;
    },
    reportRasterError: () => {
      rasterError = true;
    },
    uploaded,
    transition,
  };
}

export function registerEditingTransitionTests(
  run: TestRunner,
  assertions: TestAssertions,
  createEditor: () => TestEditorHost,
): void {
  run("enters and applies one frame swap", () => {
    const { editor, transition } = setup(createEditor);
    assertions.true(
      transition.begin(
        "file.ts",
        { x: 200, y: 120 },
        { lineNumber: 1, column: 1 },
      ),
    );
    assertions.true(!editor.visible);
    assertions.equal(transition.takeFrameSwap()?.direction, "enter");
    assertions.true(editor.visible);
    assertions.equal(transition.takeFrameSwap(), undefined);
  });

  run("saves edits and exits with the pending pan", () => {
    const { changed, editor, residency, transition, uploaded } =
      setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    transition.takeFrameSwap();
    editor.value = "const answer = 43;\n";
    assertions.true(transition.end("pan", { kind: "pan", x: 8, y: 2 }));
    const swap = transition.takeFrameSwap();
    assertions.match(swap, {
      direction: "exit",
      pendingGesture: { kind: "pan" },
      source: { text: "const answer = 43;\n", contentVersion: 2 },
    });
    assertions.equal(uploaded, []);
    residency.drain(20, {
      uploadFallback: (document) => uploaded.push(document.text),
      uploadTokens: () => undefined,
    });
    assertions.equal(uploaded, ["const answer = 43;\n"]);
    assertions.true(!editor.visible);
    assertions.equal(changed, [{ version: 2, text: "const answer = 43;\n" }]);
  });

  run("keeps the Content Version when Escape exits an unchanged draft", () => {
    const { changed, editor, transition } = setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    transition.takeFrameSwap();
    assertions.true(transition.end("escape"));
    assertions.equal(transition.takeFrameSwap()?.direction, "exit");
    assertions.equal(editor.closeCount, 1);
    assertions.equal(changed, []);
    assertions.equal(transition.sourceForActiveWidget()?.contentVersion, 1);
  });

  run("keeps the camera scale when entering editing", () => {
    const { camera, transition } = setup(createEditor);
    transition.begin(
      "file.ts",
      { x: 200, y: 120 },
      { lineNumber: 1, column: 1 },
    );
    assertions.equal(camera.scale, 1.37);
  });

  registerEditorPortTests(run, assertions, createEditor);
  registerHeldExitTests(run, assertions, createEditor);
}

function registerHeldExitTests(
  run: TestRunner,
  assertions: TestAssertions,
  createEditor: () => TestEditorHost,
): void {
  run("holds an edited exit until the current tiles are ready", () => {
    const { editor, setTilesCurrent, transition } = setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    transition.takeFrameSwap();
    editor.value = "const answer = 43;\n";
    setTilesCurrent(false);
    transition.end("escape");
    assertions.true(transition.isExitHeld);
    assertions.true(editor.visible);
    assertions.true(editor.readOnly);
    assertions.true(editor.isOpen);
    assertions.equal(transition.takeFrameSwap(), undefined);
    setTilesCurrent(true);
    assertions.equal(transition.takeFrameSwap()?.direction, "exit");
    assertions.true(!editor.visible);
    assertions.true(!editor.isOpen);
    assertions.equal(editor.closeCount, 1);
  });

  run("refuses to begin while an edited exit is held", () => {
    const { editor, setTilesCurrent, transition } = setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    transition.takeFrameSwap();
    editor.value = "const answer = 43;\n";
    setTilesCurrent(false);
    transition.end("escape");
    assertions.true(
      !transition.begin(
        "file.ts",
        { x: 0, y: 0 },
        { lineNumber: 1, column: 1 },
      ),
    );
  });

  run("releases an edited exit when rendering reports a raster error", () => {
    const { editor, reportRasterError, setTilesCurrent, transition } =
      setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    transition.takeFrameSwap();
    editor.value = "const answer = 43;\n";
    setTilesCurrent(false);
    transition.end("escape");

    reportRasterError();

    assertions.equal(transition.takeFrameSwap()?.direction, "exit");
    assertions.true(!editor.visible);
    assertions.true(!editor.isOpen);
  });
}

function registerEditorPortTests(
  run: TestRunner,
  assertions: TestAssertions,
  createEditor: () => TestEditorHost,
): void {
  run("does not enter twice while a session is active", () => {
    const { transition } = setup(createEditor);
    assertions.true(
      transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 }),
    );
    assertions.true(
      !transition.begin(
        "file.ts",
        { x: 0, y: 0 },
        { lineNumber: 1, column: 1 },
      ),
    );
  });

  run("routes Escape only after Monaco closes suggestions and search", () => {
    const { editor, transition } = setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    transition.takeFrameSwap();
    editor.suggestWidgetOpen = true;
    editor.triggerEscape();
    assertions.true(transition.isEditing);
    editor.suggestWidgetOpen = false;
    editor.findWidgetOpen = true;
    editor.triggerEscape();
    assertions.true(transition.isEditing);
    editor.findWidgetOpen = false;
    editor.triggerEscape();
    assertions.true(!transition.isEditing);
  });

  run("reports the active model line count through the editor host", () => {
    const { editor, transition } = setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    editor.value = "one\ntwo\nthree\n";
    assertions.equal(editor.getLineCount(), 4);
  });

  run("reports content changes since opening through the editor host", () => {
    const { editor, transition } = setup(createEditor);
    transition.begin("file.ts", { x: 0, y: 0 }, { lineNumber: 1, column: 1 });
    assertions.true(!editor.hasContentChanged());
    editor.value = "changed";
    assertions.true(editor.hasContentChanged());
  });
}
