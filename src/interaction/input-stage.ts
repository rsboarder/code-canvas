import type { BoardService } from "../board";
import type { EditingTransition } from "../editing";
import type { GesturePhase } from "../shared/frame";
import type { FrameIntents } from "./gesture-targeting";

const CAMERA_CHANGED = 1;
const WIDGET_CHANGED = 2;

type InputBoardView = Pick<
  BoardService,
  | "camera"
  | "detailLevel"
  | "pan"
  | "zoomAt"
  | "fitAll"
  | "zoomTo100"
  | "zoomToWidget"
  | "moveWidget"
  | "resizeWidget"
  | "scrollWidget"
  | "bringToFront"
  | "textThresholdZoom"
>;

interface InputTargetingView {
  readonly editingExitRequested: boolean;
  readonly gestureInProgress: boolean;
  takeIntents(now: number): FrameIntents;
}

interface InputEditingView {
  readonly isEditing: boolean;
  readonly isExitHeld: boolean;
  end(): boolean;
  begin(
    widgetId: Parameters<EditingTransition["begin"]>[0],
    contentPoint: { x: number; y: number },
  ): boolean;
}

interface InputFrameView {
  setGestureInProgress(value: boolean): void;
  invalidate(): void;
}

interface InputPhaseView {
  setGesturePhase(phase: GesturePhase): void;
}

interface InputDetailView {
  update(devicePixelRatio: number): void;
}

interface InputStageOptions {
  readonly board: InputBoardView;
  readonly targeting: InputTargetingView;
  readonly getEditing: () => InputEditingView | undefined;
  readonly frame: InputFrameView;
  readonly phase: InputPhaseView;
  readonly detail: InputDetailView;
  readonly viewportWidth: () => number;
  readonly viewportHeight: () => number;
  readonly updateWidgetBodyRect: () => void;
  readonly toggleMetricsOverlay: () => void;
}

export interface InputStage {
  apply(now: number, devicePixelRatio: number): void;
}

interface InputPoint {
  x: number;
  y: number;
}

interface InputTick {
  readonly phase: GesturePhase;
  readonly contentPoint: InputPoint;
}

export function createInputStage(options: InputStageOptions): InputStage {
  const tick: InputTick = {
    phase: createGesturePhase(),
    contentPoint: { x: 0, y: 0 },
  };

  return {
    apply: (now, devicePixelRatio) => {
      if (options.getEditing()?.isExitHeld) {
        keepGestureAlive(options);
        return;
      }
      const editing = options.getEditing();
      if (options.targeting.editingExitRequested && editing?.isEditing) {
        editing.end();
        if (editing.isExitHeld) {
          keepGestureAlive(options);
          return;
        }
      }
      const intents = options.targeting.takeIntents(now);
      applyIntents(options, tick, intents, devicePixelRatio);
    },
  };
}

function applyIntents(
  options: InputStageOptions,
  tick: InputTick,
  intents: FrameIntents,
  devicePixelRatio: number,
): void {
  const { phase, contentPoint } = tick;
  if (intents.toggleMetricsOverlay) options.toggleMetricsOverlay();
  phase.textThresholdZoom = options.board.textThresholdZoom(devicePixelRatio);
  phase.zoomingIn = intents.zoomingIn;
  beginEditing(options, contentPoint, intents);
  const changes = applyBoardIntents(options, intents);
  if (changes !== 0) options.updateWidgetBodyRect();
  options.detail.update(devicePixelRatio);
  phase.detailIsMinimap = options.board.detailLevel === "minimap";
  phase.gestureInProgress = intents.gestureInProgress;
  phase.zoomGestureActive = intents.zoomGestureActive;
  phase.zoomFocusX = intents.zoomFocusX;
  phase.zoomFocusY = intents.zoomFocusY;
  phase.zoomingOut = intents.zoomingOut;
  phase.gestureEnded = intents.gestureEnded;
  phase.endedGestureWasZoom = intents.endedGestureWasZoom;
  phase.cameraScale = options.board.camera.scale;
  options.frame.setGestureInProgress(intents.gestureInProgress);
  options.phase.setGesturePhase(phase);
}

function beginEditing(
  options: InputStageOptions,
  contentPoint: { x: number; y: number },
  intents: FrameIntents,
): void {
  const editing = options.getEditing();
  const widgetId = intents.beginEditingWidgetId;
  if (editing === undefined || widgetId === undefined) return;
  contentPoint.x = intents.beginEditingContentX;
  contentPoint.y = intents.beginEditingContentY;
  if (editing.begin(widgetId, contentPoint)) options.frame.invalidate();
}

function applyBoardIntents(
  options: InputStageOptions,
  intents: FrameIntents,
): number {
  const board = options.board;
  let changes = 0;
  if (intents.bringToFrontId !== undefined) {
    board.bringToFront(intents.bringToFrontId);
  }
  if (intents.moveWidgetId !== undefined) {
    board.moveWidget(intents.moveWidgetId, intents.moveX, intents.moveY);
    changes |= WIDGET_CHANGED;
  }
  if (intents.resizeWidgetId !== undefined) {
    board.resizeWidget(
      intents.resizeWidgetId,
      intents.resizeWidth,
      intents.resizeHeight,
    );
    changes |= WIDGET_CHANGED;
  }
  changes |= applyCameraIntents(options, intents);
  if (intents.scrollWidgetId !== undefined && intents.scrollDeltaY !== 0) {
    board.scrollWidget(intents.scrollWidgetId, intents.scrollDeltaY);
  }
  return changes;
}

function applyCameraIntents(
  options: InputStageOptions,
  intents: FrameIntents,
): number {
  const board = options.board;
  let changes = 0;
  if (intents.panX || intents.panY) {
    board.pan(intents.panX, intents.panY);
    changes |= CAMERA_CHANGED;
  }
  if (intents.zoomFactor !== 1) {
    board.zoomAt(intents.zoomX, intents.zoomY, intents.zoomFactor);
    changes |= CAMERA_CHANGED;
  }
  if (intents.zoomToWidgetId !== undefined) {
    board.zoomToWidget(
      intents.zoomToWidgetId,
      options.viewportWidth(),
      options.viewportHeight(),
    );
    changes |= CAMERA_CHANGED;
  }
  if (intents.fitAll || intents.zoomTo100) {
    const viewportWidth = options.viewportWidth();
    const viewportHeight = options.viewportHeight();
    if (intents.fitAll) board.fitAll(viewportWidth, viewportHeight);
    if (intents.zoomTo100) board.zoomTo100(viewportWidth, viewportHeight);
    changes |= CAMERA_CHANGED;
  }
  return changes;
}

function keepGestureAlive(options: InputStageOptions): void {
  options.frame.setGestureInProgress(options.targeting.gestureInProgress);
}

function createGesturePhase(): GesturePhase {
  return {
    gestureInProgress: false,
    zoomGestureActive: false,
    zoomFocusX: 0,
    zoomFocusY: 0,
    zoomingOut: false,
    gestureEnded: false,
    endedGestureWasZoom: false,
    detailIsMinimap: false,
    zoomingIn: false,
    textThresholdZoom: 0,
    cameraScale: 1,
  };
}
