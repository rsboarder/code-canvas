import { Camera } from "../../board/index";
import { DocumentResidency } from "../../code-view/index";
import type { Rect } from "../../shared/geometry/geometry";
import {
  createEditingSession,
  type EditingEndReason,
  type EditingSession,
} from "../domain/editing-session";
import type { EditorCursor, EditorHost } from "./editor-host";

export interface EditingSource {
  readonly widgetId: string;
  readonly path: string;
  readonly text: string;
  readonly contentVersion: number;
  readonly frame: Rect;
}

export interface PendingGesture {
  readonly kind: "pan" | "zoom";
  readonly x?: number;
  readonly y?: number;
}

export interface FrameSwap {
  readonly direction: "enter" | "exit";
  readonly widgetId: string;
  readonly source?: EditingSource;
  readonly pendingGesture?: PendingGesture;
}

interface EditingTransitionOptions {
  readonly camera: Camera;
  readonly editor: EditorHost;
  readonly residency: DocumentResidency;
  readonly readSource: (widgetId: string) => EditingSource | undefined;
  readonly tilesCurrent: (widgetId: string, contentVersion: number) => boolean;
  readonly onContentChanged?: (source: EditingSource) => void;
}

export class EditingTransition {
  private source: EditingSource | undefined;
  private session: EditingSession | undefined;
  private pendingSwap: FrameSwap | undefined;

  constructor(private readonly options: EditingTransitionOptions) {}

  get activeWidgetId(): string | undefined {
    return this.session?.widgetId;
  }

  get isEditing(): boolean {
    return this.session !== undefined;
  }

  get isExitHeld(): boolean {
    return this.pendingSwap?.direction === "exit";
  }

  begin(
    widgetId: string,
    _clickPoint: { x: number; y: number },
    cursor: EditorCursor,
  ): boolean {
    const source = this.options.readSource(widgetId);
    if (!source || this.session || this.pendingSwap) return false;
    this.source = source;
    this.session = createEditingSession(
      source.widgetId,
      source.text,
      source.contentVersion,
    );
    this.options.editor.open({
      text: source.text,
      language: source.path.endsWith(".tsx") ? "typescriptreact" : "typescript",
      cursor,
    });
    this.options.editor.setReadOnly(false);
    this.options.editor.setVisible(false);
    this.pendingSwap = { direction: "enter", widgetId };
    return true;
  }

  end(_reason: EditingEndReason, pendingGesture?: PendingGesture): boolean {
    if (!this.session || !this.source) return false;
    const source = this.source;
    this.options.editor.setReadOnly(true);
    this.options.residency.prioritize(source.widgetId);
    if (this.options.editor.hasContentChanged()) {
      const draft = this.options.editor.getValue();
      const updated = {
        ...source,
        contentVersion: source.contentVersion + 1,
        text: draft,
      };
      this.source = updated;
      this.session = createEditingSession(
        updated.widgetId,
        updated.text,
        updated.contentVersion,
      );
      this.options.residency.contentChanged(
        updated.widgetId,
        updated.contentVersion,
        draft,
      );
      this.options.onContentChanged?.(updated);
    }
    this.pendingSwap = {
      direction: "exit",
      widgetId: source.widgetId,
      ...(this.source !== source ? { source: this.source } : {}),
      ...(pendingGesture ? { pendingGesture } : {}),
    };
    this.session = undefined;
    return true;
  }

  takeFrameSwap(): FrameSwap | undefined {
    const swap = this.pendingSwap;
    if (!swap) return undefined;
    if (
      swap.direction === "exit" &&
      swap.source &&
      !this.options.tilesCurrent(swap.widgetId, swap.source.contentVersion)
    )
      return undefined;
    this.pendingSwap = undefined;
    this.options.editor.setVisible(swap.direction === "enter");
    if (swap.direction === "exit") this.options.editor.close();
    return swap;
  }

  sourceForActiveWidget(): EditingSource | undefined {
    return this.source;
  }
}
