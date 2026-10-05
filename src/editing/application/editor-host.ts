import {
  LINE_NUMBER_GAP_CSS,
  MIN_LINE_NUMBER_DIGITS,
} from "../../code-view/index";
import type { Rect } from "../../shared/geometry/geometry";

export const EDITOR_LINE_NUMBER_LAYOUT = {
  minChars: MIN_LINE_NUMBER_DIGITS,
  decorationsWidth: LINE_NUMBER_GAP_CSS,
} as const;

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
  setScrollTop(scrollTop: number): void;
  getScrollTop(): number;
  getPosition(): EditorCursor | undefined;
  getValue(): string;
  getLineCount(): number;
  onChange(listener: () => void): () => void;
  onEscape(listener: () => void): () => void;
  focus(): void;
}
