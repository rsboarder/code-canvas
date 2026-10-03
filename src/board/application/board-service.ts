import type { EventBus, Unsubscribe } from "../../shared/events";
import type { SourceFileId, WorkspaceFolderId } from "../../shared/domain";
import type { Vec2 } from "../../shared/geometry";
import type { FileContentChanged, WorkspaceEvent } from "../../workspace";
import type { BoardFile } from "../domain/board-file";

import { Board } from "../domain/board";
import type { BoardMetrics } from "../domain/board-metrics";
import { reconcile } from "../domain/reconcile";
import type { SavedLayout } from "../domain/saved-layout";
import type { DetailLevelName } from "../domain/detail-level";
import type { HitTestResult } from "../domain/hit-test";
import type { CameraView } from "../domain/camera";
import type {
  BoardReadModel,
  ViewportSize,
  WidgetRow,
} from "./board-read-model";

export class BoardService implements BoardReadModel {
  private board: Board;
  private readonly dirtyWidgetIds = new Set<SourceFileId>();
  private readonly unsubscribe: Unsubscribe;
  private readonly cameraView: CameraView;
  private currentFolderId: WorkspaceFolderId | undefined;
  private currentLayoutVersion = 0;
  private currentSavedLayoutRevision = 0;

  constructor(
    private readonly metrics: BoardMetrics,
    events: EventBus<WorkspaceEvent>,
  ) {
    this.board = emptyBoard(metrics);
    this.cameraView = new StableCameraView(() => this.board.camera);
    this.unsubscribe = events.subscribe(
      "FileContentChanged",
      (event: FileContentChanged) => {
        this.handleContentChanged(event);
      },
    );
  }

  get camera(): CameraView {
    return this.cameraView;
  }

  get detailLevel(): DetailLevelName {
    return this.board.detailLevel;
  }

  get layoutVersion(): number {
    return this.currentLayoutVersion;
  }

  get savedLayoutRevision(): number {
    return this.currentSavedLayoutRevision;
  }

  get widgetCount(): number {
    return this.board.widgetCount;
  }

  get folderId(): WorkspaceFolderId | undefined {
    return this.currentFolderId;
  }

  pan(dx: number, dy: number): void {
    this.board.panCamera(dx, dy);
    this.currentSavedLayoutRevision += 1;
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    this.board.zoomCameraAt(screenX, screenY, factor);
    this.currentSavedLayoutRevision += 1;
  }

  setCamera(x: number, y: number, scale: number): void {
    this.board.setCamera(x, y, scale);
    this.currentSavedLayoutRevision += 1;
  }

  fitAll(viewportWidth: number, viewportHeight: number): void {
    this.board.fitAll(viewportWidth, viewportHeight);
    this.currentSavedLayoutRevision += 1;
  }

  zoomToWidget(
    id: SourceFileId,
    viewportWidth: number,
    viewportHeight: number,
  ): boolean {
    const changed = this.board.zoomToWidget(id, viewportWidth, viewportHeight);
    if (changed) this.currentSavedLayoutRevision += 1;
    return changed;
  }

  zoomTo100(viewportWidth: number, viewportHeight: number): void {
    this.zoomAt(viewportWidth / 2, viewportHeight / 2, 1 / this.camera.scale);
  }

  moveWidget(id: SourceFileId, x: number, y: number): void {
    this.board.moveWidget(id, x, y);
    this.dirtyWidgetIds.add(id);
    this.currentSavedLayoutRevision += 1;
  }

  resizeWidget(id: SourceFileId, width: number, height: number): void {
    this.board.resizeWidget(id, width, height);
    this.dirtyWidgetIds.add(id);
    this.currentSavedLayoutRevision += 1;
  }

  scrollWidget(id: SourceFileId, deltaY: number): number {
    const appliedDelta = this.board.scrollWidget(id, deltaY);
    if (appliedDelta !== 0) {
      this.dirtyWidgetIds.add(id);
      this.currentSavedLayoutRevision += 1;
    }
    return appliedDelta;
  }

  bringToFront(id: SourceFileId): void {
    const oldIndex = this.board.stackIndexOf(id);
    const widgetCount = this.board.widgetCount;
    if (oldIndex === -1) {
      this.board.bringToFront(id);
      return;
    }
    if (oldIndex === widgetCount - 1) {
      this.board.bringToFront(id);
      this.currentSavedLayoutRevision += 1;
      return;
    }
    for (let index = 0; index <= widgetCount - oldIndex - 1; index += 1) {
      const changedId = this.board.widgetIdAtFromTop(index);
      if (changedId !== undefined) this.dirtyWidgetIds.add(changedId);
    }
    this.board.bringToFront(id);
    this.currentSavedLayoutRevision += 1;
  }

  updateDetailLevel(
    devicePixelRatio: number,
    textReady: boolean,
  ): DetailLevelName {
    return this.board.updateDetailLevel(devicePixelRatio, textReady);
  }

  restoreBoard(
    folderId: WorkspaceFolderId,
    files: readonly BoardFile[],
    saved: SavedLayout | undefined,
    viewport: ViewportSize,
  ): void {
    this.board = Board.fromLayout(
      this.metrics,
      reconcile(saved, files, this.metrics),
    );
    this.currentFolderId = folderId;
    this.currentLayoutVersion += 1;
    this.currentSavedLayoutRevision += 1;
    this.dirtyWidgetIds.clear();
    for (let index = 0; index < this.board.widgetCount; index += 1) {
      const id = this.board.widgetIdAtFromTop(index);
      if (id !== undefined) this.dirtyWidgetIds.add(id);
    }
    if (saved === undefined) this.board.fitAll(viewport.width, viewport.height);
  }

  savedLayout(): SavedLayout {
    return this.board.toSavedLayout();
  }

  readWidget(id: SourceFileId, out: WidgetRow): WidgetRow {
    const widget = this.board.widget(id);
    if (widget === undefined) throw new RangeError("Unknown widget id.");
    out.x = widget.x;
    out.y = widget.y;
    out.width = widget.width;
    out.height = widget.height;
    out.contentScroll = widget.contentScroll;
    out.maxContentScroll = widget.maxContentScroll;
    out.lineCount = widget.lineCount;
    out.stackIndex = this.board.stackIndexOf(id);
    return out;
  }

  widgetIdAtFromTop(index: number): SourceFileId | undefined {
    return this.board.widgetIdAtFromTop(index);
  }

  hitTest(screenX: number, screenY: number, out: HitTestResult): HitTestResult {
    return this.board.hitTest(screenX, screenY, out);
  }

  textWanted(devicePixelRatio: number): boolean {
    return this.board.textWanted(devicePixelRatio);
  }

  textThresholdZoom(devicePixelRatio: number): number {
    return this.board.textThresholdZoom(devicePixelRatio);
  }

  drainDirtyWidgets(out: SourceFileId[]): number {
    out.length = 0;
    for (const id of this.dirtyWidgetIds) out.push(id);
    this.dirtyWidgetIds.clear();
    return out.length;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private handleContentChanged(event: FileContentChanged): void {
    if (this.board.widget(event.fileId) === undefined) return;
    this.board.setLineCount(event.fileId, event.lineCount);
    this.dirtyWidgetIds.add(event.fileId);
    this.currentSavedLayoutRevision += 1;
  }
}

function emptyBoard(metrics: BoardMetrics): Board {
  return Board.fromLayout(metrics, { camera: undefined, widgets: [] });
}

class StableCameraView implements CameraView {
  constructor(private readonly currentCamera: () => CameraView) {}

  get offsetX(): number {
    return this.currentCamera().offsetX;
  }

  get offsetY(): number {
    return this.currentCamera().offsetY;
  }

  get scale(): number {
    return this.currentCamera().scale;
  }

  toScreen(boardPoint: Vec2, out: Vec2): Vec2 {
    return this.currentCamera().toScreen(boardPoint, out);
  }

  toBoard(screenPoint: Vec2, out: Vec2): Vec2 {
    return this.currentCamera().toBoard(screenPoint, out);
  }
}
