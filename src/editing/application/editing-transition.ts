import {
  createWidgetRow,
  type BoardReadModel,
  type BoardService,
} from "../../board/index";
import {
  DocumentResidency,
  LineLayout,
  type LineNumberGutter,
  type LineMetrics,
} from "../../code-view/index";
import type { SourceFileId } from "../../shared/domain";
import type { WorkspaceService } from "../../workspace/index";
import {
  EditingSession,
  type EditingEndReason,
} from "../domain/editing-session";
import { AutosavePolicy } from "../domain/autosave-policy";
import type { EditorHost, EditorOpenOptions } from "./editor-host";

export interface PendingGesture {
  readonly kind: "pan" | "zoom";
  readonly x?: number;
  readonly y?: number;
}

export interface FrameSwap {
  readonly direction: "enter" | "exit";
  readonly widgetId: SourceFileId;
  readonly pendingGesture?: PendingGesture;
}

interface EditingTransitionOptions {
  readonly board: Pick<
    BoardReadModel,
    "camera" | "detailLevel" | "readWidget"
  > &
    Pick<BoardService, "setContentScroll">;
  readonly workspace: Pick<WorkspaceService, "readForEditing" | "applyDraft">;
  readonly editor: EditorHost;
  readonly residency: DocumentResidency;
  readonly lineMetrics: LineMetrics;
  readonly gutter: LineNumberGutter;
  readonly tilesCurrent: (
    widgetId: SourceFileId,
    contentVersion: number,
  ) => boolean;
  readonly onOpened: () => void;
}

function editorLanguage(path: string): EditorOpenOptions["language"] {
  return path.endsWith(".tsx") ? "typescriptreact" : "typescript";
}

export class EditingTransition {
  private readonly session = new EditingSession();
  private readonly autosavePolicy = new AutosavePolicy();
  private pendingSwap: FrameSwap | undefined;
  private pendingExitVersion: number | undefined;
  private latestPublishedVersion: number | undefined;
  private pendingRead: { cancelled: boolean } | undefined;
  private pendingBeginWidgetId: SourceFileId | undefined;
  private pendingBeginX = 0;
  private pendingBeginY = 0;
  private readonly widgetRow = createWidgetRow();

  constructor(private readonly options: EditingTransitionOptions) {
    this.options.editor.onChange(() => {
      if (this.session.isEditing) this.session.recordEdit(performance.now());
    });
  }

  get activeWidgetId(): SourceFileId | undefined {
    return this.session.widgetId;
  }

  get isEditing(): boolean {
    return this.session.isEditing;
  }

  get isExitHeld(): boolean {
    return this.pendingSwap?.direction === "exit";
  }

  get pendingExitFileId(): SourceFileId | undefined {
    return this.pendingSwap?.direction === "exit"
      ? this.pendingSwap.widgetId
      : undefined;
  }

  autosave(now: number): boolean {
    if (!this.autosavePolicy.isDue(this.session, now)) return false;
    const draft = this.session.draft;
    if (!draft) return false;
    const text = this.options.editor.getValue();
    const applied = this.options.workspace.applyDraft(draft.fileId, text);
    this.session.publish(text, applied.contentVersion);
    this.latestPublishedVersion = applied.contentVersion;
    return true;
  }

  autosaveDueAt(): number {
    return this.autosavePolicy.dueAt(this.session);
  }

  begin(
    widgetId: SourceFileId,
    contentPoint: { x: number; y: number },
  ): boolean {
    if (this.pendingRead) return false;
    if (this.session.isEditing) {
      if (this.session.widgetId === widgetId) return false;
      this.end("another-widget");
      this.rememberBegin(widgetId, contentPoint);
      return true;
    }
    if (this.pendingSwap) {
      if (this.pendingSwap.direction !== "exit") return false;
      if (this.pendingSwap.widgetId === widgetId) return false;
      this.rememberBegin(widgetId, contentPoint);
      return true;
    }
    const read = { cancelled: false };
    this.pendingRead = read;
    void this.options.workspace
      .readForEditing(widgetId)
      .then(async (result) => {
        if (result.kind === "ready" && !read.cancelled) {
          await this.options.editor.prepare({
            text: result.text,
            language: editorLanguage(result.path),
          });
        }
        this.finishRead(widgetId, contentPoint, read, result);
      })
      .catch(() => {
        this.finishUnavailable(read);
      });
    return true;
  }

  end(_reason: EditingEndReason, pendingGesture?: PendingGesture): boolean {
    return this.exitSession(pendingGesture, true);
  }

  discard(): boolean {
    return this.exitSession(undefined, false);
  }

  private exitSession(
    pendingGesture: PendingGesture | undefined,
    applyDraft: boolean,
  ): boolean {
    if (this.pendingRead) {
      this.pendingRead.cancelled = true;
      this.pendingRead = undefined;
      return false;
    }
    if (!this.session.isEditing) return false;
    const draft = this.session.draft;
    this.options.editor.setReadOnly(true);
    if (!draft) return false;
    if (applyDraft && this.session.hasUnpublishedEdits) {
      const text = this.options.editor.getValue();
      const applied = this.options.workspace.applyDraft(draft.fileId, text);
      this.session.publish(text, applied.contentVersion);
      this.latestPublishedVersion = applied.contentVersion;
    }
    this.writeEditorScroll(draft.fileId);
    this.pendingExitVersion =
      this.latestPublishedVersion ?? draft.contentVersion;
    this.options.residency.prioritize(draft.fileId);
    this.pendingSwap = {
      direction: "exit",
      widgetId: draft.fileId,
      ...(pendingGesture ? { pendingGesture } : {}),
    };
    if (applyDraft) this.session.end();
    else this.session.discard();
    return true;
  }

  takeFrameSwap(): FrameSwap | undefined {
    const swap = this.pendingSwap;
    if (!swap) return undefined;
    if (
      swap.direction === "exit" &&
      this.pendingExitVersion !== undefined &&
      !this.options.tilesCurrent(swap.widgetId, this.pendingExitVersion)
    )
      return undefined;
    this.pendingSwap = undefined;
    this.pendingExitVersion = undefined;
    this.latestPublishedVersion = undefined;
    this.options.editor.setVisible(swap.direction === "enter");
    if (swap.direction === "exit") {
      this.options.editor.close();
      this.beginRemembered();
    }
    return swap;
  }

  private rememberBegin(
    widgetId: SourceFileId,
    contentPoint: { x: number; y: number },
  ): void {
    this.pendingBeginWidgetId = widgetId;
    this.pendingBeginX = contentPoint.x;
    this.pendingBeginY = contentPoint.y;
  }

  private beginRemembered(): void {
    const widgetId = this.pendingBeginWidgetId;
    if (widgetId === undefined) return;
    const contentPoint = { x: this.pendingBeginX, y: this.pendingBeginY };
    this.pendingBeginWidgetId = undefined;
    this.begin(widgetId, contentPoint);
  }

  private finishUnavailable(read: { cancelled: boolean }): void {
    if (this.pendingRead === read) this.pendingRead = undefined;
  }

  private finishRead(
    widgetId: SourceFileId,
    contentPoint: { x: number; y: number },
    read: { cancelled: boolean },
    result: Awaited<ReturnType<WorkspaceService["readForEditing"]>>,
  ): void {
    if (this.pendingRead !== read || read.cancelled) return;
    this.pendingRead = undefined;
    if (result.kind !== "ready" || this.options.board.detailLevel !== "text") {
      return;
    }
    const row = this.options.board.readWidget(widgetId, this.widgetRow);
    if (
      !this.session.begin(
        {
          fileId: widgetId,
          text: result.text,
          contentVersion: result.contentVersion,
        },
        {
          cameraOffsetX: this.options.board.camera.offsetX,
          cameraOffsetY: this.options.board.camera.offsetY,
          cameraScale: this.options.board.camera.scale,
          frame: {
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
          },
        },
      )
    ) {
      return;
    }
    this.latestPublishedVersion = undefined;
    const codeX = this.options.gutter.codeX(row.lineCount, contentPoint.x);
    const cursor = new LineLayout(
      result.text,
      this.options.lineMetrics,
    ).positionAt(codeX, contentPoint.y);
    this.options.editor.open({
      text: result.text,
      language: editorLanguage(result.path),
      cursor,
    });
    this.options.editor.setScrollTop(row.contentScroll);
    this.options.editor.setReadOnly(false);
    this.options.editor.setVisible(false);
    this.pendingSwap = { direction: "enter", widgetId };
    this.options.onOpened();
  }

  private writeEditorScroll(widgetId: SourceFileId): void {
    this.options.board.setContentScroll(
      widgetId,
      this.options.editor.getScrollTop(),
    );
  }
}
