import type { Rect } from "../../shared/geometry/geometry";
import { splitSourceLines } from "../../shared/domain/line-splitting";
import type {
  EditorCursor,
  EditorHost,
  EditorOpenOptions,
} from "../application/editor-host";

export class FakeEditorHost implements EditorHost {
  private currentValue = "";
  private openedValue = "";
  private changedSinceOpen = false;
  visible = false;
  openCount = 0;
  closeCount = 0;
  isOpen = false;
  readOnly = false;
  lastOptions: EditorOpenOptions | undefined;
  lastBounds: Rect | undefined;
  lastZoom = 1;
  lastCursor: EditorCursor | undefined;
  suggestWidgetOpen = false;
  findWidgetOpen = false;
  private readonly listeners = new Set<() => void>();
  private readonly escapeListeners = new Set<() => void>();

  get value(): string {
    return this.currentValue;
  }

  set value(value: string) {
    this.currentValue = value;
    this.changedSinceOpen = value !== this.openedValue;
  }

  open(options: EditorOpenOptions): void {
    this.currentValue = options.text;
    this.openedValue = options.text;
    this.changedSinceOpen = false;
    this.lastOptions = options;
    this.lastCursor = options.cursor;
    this.openCount += 1;
    this.isOpen = true;
    this.readOnly = false;
  }

  close(): void {
    this.closeCount += 1;
    this.isOpen = false;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  setBounds(bounds: Rect, zoom: number): void {
    this.lastBounds = bounds;
    this.lastZoom = zoom;
  }

  setPosition(cursor: EditorCursor): void {
    this.lastCursor = cursor;
  }

  getPosition(): EditorCursor | undefined {
    return this.lastCursor;
  }

  getValue(): string {
    return this.currentValue;
  }

  hasContentChanged(): boolean {
    return this.changedSinceOpen;
  }

  getLineCount(): number {
    return splitSourceLines(this.value).length;
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
    return undefined;
  }

  setValue(value: string): void {
    this.value = value;
    this.listeners.forEach((listener) => {
      listener();
    });
  }

  triggerEscape(): void {
    if (this.suggestWidgetOpen || this.findWidgetOpen) return;
    this.escapeListeners.forEach((listener) => {
      listener();
    });
  }
}
