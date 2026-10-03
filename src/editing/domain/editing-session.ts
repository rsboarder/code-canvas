import type { SourceFileId } from "../../shared/domain";
import type { Rect } from "../../shared/geometry";
import type { Draft } from "./draft";

export type EditingEndReason =
  "escape" | "pan" | "zoom" | "outside" | "another-widget";

export interface EditorPlacement {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
  readonly frame: Rect;
}

export class EditingSession {
  private currentDraft: Draft | undefined;
  private currentPlacement: EditorPlacement | undefined;
  private editing = false;
  private unpublished = false;
  private editTime = Number.NaN;

  get isEditing(): boolean {
    return this.editing;
  }

  get widgetId(): SourceFileId | undefined {
    return this.currentDraft?.fileId;
  }

  get draft(): Draft | undefined {
    return this.currentDraft;
  }

  get placement(): EditorPlacement | undefined {
    return this.currentPlacement;
  }

  get hasUnpublishedEdits(): boolean {
    return this.unpublished;
  }

  get lastEditAt(): number {
    return this.editTime;
  }

  begin(draft: Draft, placement: EditorPlacement): boolean {
    if (this.editing) return false;
    this.currentDraft = draft;
    this.currentPlacement = copyPlacement(placement);
    this.editing = true;
    this.unpublished = false;
    this.editTime = Number.NaN;
    return true;
  }

  recordEdit(now: number): void {
    this.requireEditing();
    this.unpublished = true;
    this.editTime = now;
  }

  publish(text: string, contentVersion: number): void {
    this.requireEditing();
    const draft = this.currentDraft;
    if (!draft || !(contentVersion > draft.contentVersion)) {
      throw new RangeError("Published Content Version must increase.");
    }
    this.currentDraft = {
      fileId: draft.fileId,
      text,
      contentVersion,
    };
    this.unpublished = false;
    this.editTime = Number.NaN;
  }

  end(): Draft {
    this.requireEditing();
    if (this.unpublished) {
      throw new Error("Cannot end an Editing Session with unpublished edits.");
    }
    return this.finish();
  }

  discard(): Draft {
    this.requireEditing();
    return this.finish();
  }

  private finish(): Draft {
    const draft = this.currentDraft;
    if (!draft) throw new Error("Editing Session has no Draft.");
    this.currentDraft = undefined;
    this.currentPlacement = undefined;
    this.editing = false;
    this.editTime = Number.NaN;
    return draft;
  }

  private requireEditing(): void {
    if (!this.editing) throw new Error("Editing Session is Idle.");
  }
}

function copyPlacement(placement: EditorPlacement): EditorPlacement {
  return {
    cameraOffsetX: placement.cameraOffsetX,
    cameraOffsetY: placement.cameraOffsetY,
    cameraScale: placement.cameraScale,
    frame: { ...placement.frame },
  };
}
