import type { Rect } from "../../shared/geometry/geometry";

export interface EditorCursor {
  readonly lineNumber: number;
  readonly column: number;
}

export interface EditorOpenOptions {
  readonly text: string;
  readonly language: "typescript" | "typescriptreact";
  readonly cursor: EditorCursor;
}

export interface EditorPrepareOptions {
  readonly text: string;
  readonly language: EditorOpenOptions["language"];
}

export interface EditorHost {
  prepare(options: EditorPrepareOptions): Promise<void>;
  open(options: EditorOpenOptions): void;
  close(): void;
  setVisible(visible: boolean): void;
  setReadOnly(readOnly: boolean): void;
  setBounds(bounds: Rect, zoom: number): void;
  setPosition(cursor: EditorCursor): void;
  getPosition(): EditorCursor | undefined;
  getValue(): string;
  getLineCount(): number;
  onChange(listener: () => void): () => void;
  onEscape(listener: () => void): () => void;
  focus(): void;
}
