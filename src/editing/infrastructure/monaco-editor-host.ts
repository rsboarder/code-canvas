import {
  editor as monacoEditor,
  KeyCode,
} from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

import type {
  EditorCursor,
  EditorHost,
  EditorOpenOptions,
} from "../application/editor-host";
import type { FontDefinition } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { ModelBookkeeping } from "./model-bookkeeping";

interface EditorTheme {
  readonly background: string;
}

export async function createMonacoEditorHost(
  container: HTMLElement,
  font: FontDefinition,
  configureTokens: () => Promise<readonly { dispose(): void }[]>,
  theme: EditorTheme,
): Promise<MonacoEditorHost> {
  const host = new MonacoEditorHost(container, font, configureTokens, theme);
  await host.initialize();
  return host;
}

class MonacoEditorHost implements EditorHost {
  private readonly listeners = new Set<() => void>();
  private readonly escapeListeners = new Set<() => void>();
  private readonly editor: monacoEditor.IStandaloneCodeEditor;
  private readonly models: ModelBookkeeping<monacoEditor.ITextModel>;
  private readonly disposables: { dispose(): void }[] = [];
  private modelDisposable: { dispose(): void } | undefined;
  private openedAlternativeVersionId: number | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly font: FontDefinition,
    private readonly configureTokens: () => Promise<
      readonly { dispose(): void }[]
    >,
    theme: EditorTheme,
  ) {
    this.container.style.position = "fixed";
    this.container.style.zIndex = "1";
    this.container.style.overflow = "hidden";
    this.container.style.background = theme.background;
    this.container.style.fontFeatureSettings = font.fontFeatureSettings;
    this.container.style.letterSpacing = `${String(font.letterSpacing)}px`;
    this.container.style.visibility = "hidden";
    this.container.style.pointerEvents = "none";
    this.container.style.left = "0px";
    this.container.style.top = "0px";
    this.container.style.width = "800px";
    this.container.style.height = "600px";
    this.container.style.transformOrigin = "0 0";
    const globalWindow = window as unknown as {
      MonacoEnvironment?: {
        getWorker(workerId: string, label: string): Worker;
      };
    };
    globalWindow.MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
    this.editor = monacoEditor.create(this.container, {
      automaticLayout: false,
      model: null,
      fontFamily: font.family,
      fontSize: font.size,
      lineHeight: font.lineHeight,
      fontLigatures: false,
      letterSpacing: font.letterSpacing,
      disableMonospaceOptimizations: true,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      wordWrap: "off",
      codeLens: false,
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      guides: {
        indentation: false,
        bracketPairs: false,
        highlightActiveIndentation: false,
      },
      renderLineHighlight: "none",
      padding: { top: 0, bottom: 0 },
      renderValidationDecorations: "off",
      contextmenu: true,
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
    });
    this.models = new ModelBookkeeping(this.editor);
    this.editor.addCommand(
      KeyCode.Escape,
      () => {
        this.escapeListeners.forEach((listener) => {
          listener();
        });
      },
      "!suggestWidgetVisible && !findWidgetVisible",
    );
  }

  async initialize(): Promise<void> {
    this.disposables.push(...(await this.configureTokens()));
  }

  open(options: EditorOpenOptions): void {
    this.modelDisposable?.dispose();
    this.modelDisposable = undefined;
    const model = monacoEditor.createModel(options.text, options.language);
    this.models.replace(model);
    this.openedAlternativeVersionId = model.getAlternativeVersionId();
    this.editor.updateOptions({
      fontSize: this.font.size,
      lineHeight: this.font.lineHeight,
      fontLigatures: false,
      letterSpacing: 0,
      readOnly: false,
    });
    this.editor.layout();
    this.editor.setPosition(options.cursor);
    this.modelDisposable = model.onDidChangeContent(() => {
      this.listeners.forEach((listener) => {
        listener();
      });
    });
  }

  close(): void {
    this.modelDisposable?.dispose();
    this.modelDisposable = undefined;
    this.openedAlternativeVersionId = undefined;
    this.models.close();
  }

  setVisible(visible: boolean): void {
    this.container.style.visibility = visible ? "visible" : "hidden";
    this.container.style.pointerEvents = visible ? "auto" : "none";
    if (visible) this.editor.focus();
  }

  setReadOnly(readOnly: boolean): void {
    this.editor.updateOptions({ readOnly });
  }

  setBounds(bounds: Rect, zoom: number): void {
    this.container.style.left = `${String(bounds.x)}px`;
    this.container.style.top = `${String(bounds.y)}px`;
    this.container.style.width = `${String(Math.max(1, bounds.width))}px`;
    this.container.style.height = `${String(Math.max(1, bounds.height))}px`;
    this.container.style.transform = `scale(${String(zoom)})`;
    this.editor.layout({
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    });
  }

  setPosition(cursor: EditorCursor): void {
    this.editor.setPosition(cursor);
  }

  getPosition(): EditorCursor | undefined {
    const position = this.editor.getPosition();
    if (!position) return undefined;
    return { lineNumber: position.lineNumber, column: position.column };
  }

  getValue(): string {
    return this.models.activeModel?.getValue() ?? "";
  }

  hasContentChanged(): boolean {
    const model = this.models.activeModel;
    return (
      model !== undefined &&
      this.openedAlternativeVersionId !== undefined &&
      model.getAlternativeVersionId() !== this.openedAlternativeVersionId
    );
  }

  getLineCount(): number {
    return this.models.activeModel?.getLineCount() ?? 0;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEscape(listener: () => void): () => void {
    this.escapeListeners.add(listener);
    return () => this.escapeListeners.delete(listener);
  }

  focus(): void {
    this.editor.focus();
  }
}
