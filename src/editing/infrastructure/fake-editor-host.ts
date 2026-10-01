import type { Rect } from "../../shared/geometry/geometry";
import { splitSourceLines } from "../../shared/domain/line-splitting";
import type {
  EditorCursor,
  EditorHost,
  EditorOpenOptions,
} from "../application/editor-host";

export class FakeEditorHost implements EditorHost {
  value = "";
  visible = false;
  openCount = 0;
  closeCount = 0;
  lastOptions: EditorOpenOptions | undefined;
  lastBounds: Rect | undefined;
  lastZoom = 1;
  lastCursor: EditorCursor | undefined;
  suggestWidgetOpen = false;
  findWidgetOpen = false;
  private readonly listeners = new Set<() => void>();
  private readonly escapeListeners = new Set<() => void>();

  open(options: EditorOpenOptions): void {
    this.value = options.text;
    this.lastOptions = options;
    this.lastCursor = options.cursor;
    this.openCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
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
    return this.value;
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
