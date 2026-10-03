import type { BoardService } from "../board";
import type { EditingTransition } from "../editing";
import {
  type FrameIntents,
  GestureTargeting,
  type WheelInput,
} from "../interaction/gesture-targeting";
import type { FrameLoop, WebGlRenderer } from "../rendering";

const CAMERA_CHANGED = 1;
const WIDGET_CHANGED = 2;

interface InputWiringOptions {
  readonly canvas: HTMLCanvasElement;
  readonly editorContainer: HTMLElement;
  readonly board: BoardService;
  readonly targeting: GestureTargeting;
  readonly getEditing: () => EditingTransition | undefined;
  readonly getRenderer: () => WebGlRenderer | undefined;
  readonly getFrameLoop: () => FrameLoop | undefined;
  readonly updateWidgetBodyRect: () => void;
  readonly toggleMetricsOverlay: () => void;
}

interface InputWiring {
  readonly applyInput: () => void;
  readonly wire: () => void;
}

interface EditorWheelInput extends WheelInput {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  offsetX: number;
  offsetY: number;
  timeStamp: number;
}

export function createInputWiring(options: InputWiringOptions): InputWiring {
  let forwardedEditorWheel: WheelEvent | undefined;
  const editorWheelInput: EditorWheelInput = {
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    offsetX: 0,
    offsetY: 0,
    timeStamp: 0,
    preventDefault: () => forwardedEditorWheel?.preventDefault(),
  };
  return {
    applyInput: () => {
      applyPendingInput(options);
    },
    wire: () => {
      wireCanvasInput(options);
      wireKeyboardInput(options);
      wireEditorWheel(
        options,
        editorWheelInput,
        (event) => {
          forwardedEditorWheel = event;
        },
        () => {
          forwardedEditorWheel = undefined;
        },
      );
    },
  };
}

function applyPendingInput(options: InputWiringOptions): void {
  const frameLoop = options.getFrameLoop();
  const renderer = options.getRenderer();
  if (!frameLoop || !renderer) return;
  const editing = options.getEditing();
  if (editing?.isExitHeld) {
    keepGestureAlive(options.targeting, frameLoop);
    return;
  }
  if (endActiveEditing(options, editing, frameLoop)) return;
  const intents = options.targeting.takeIntents(performance.now());
  if (intents.toggleMetricsOverlay) options.toggleMetricsOverlay();
  applyIntents(options, frameLoop, renderer, intents);
}

function endActiveEditing(
  options: InputWiringOptions,
  editing: EditingTransition | undefined,
  frameLoop: FrameLoop,
): boolean {
  const request = options.targeting.endEditingRequest;
  if (request === undefined || !editing?.isEditing) return false;
  const gesture = options.targeting.endEditingGesture;
  editing.end(request, gesture ? { kind: gesture } : undefined);
  if (!editing.isExitHeld) return false;
  keepGestureAlive(options.targeting, frameLoop);
  return true;
}

function applyIntents(
  options: InputWiringOptions,
  frameLoop: FrameLoop,
  renderer: WebGlRenderer,
  intents: FrameIntents,
): void {
  const devicePixelRatio = window.devicePixelRatio || 1;
  if (
    options.board.detailLevel === "minimap" &&
    intents.zoomFactor > 1 &&
    intents.zoomGestureActive
  ) {
    renderer.beginTextPrefetch(
      options.board.textThresholdZoom(devicePixelRatio),
    );
  }
  const changes = applyBoardIntents(options, intents);
  if (changes !== 0) options.updateWidgetBodyRect();
  const level = options.board.updateDetailLevel(
    devicePixelRatio,
    renderer.textReady(),
  );
  if (options.canvas.getAttribute("data-detail-level") !== level) {
    options.canvas.setAttribute("data-detail-level", level);
  }
  renderer.setDetailLevel(level, options.board.textWanted(devicePixelRatio));
  frameLoop.setGestureInProgress(intents.gestureInProgress);
  renderer.setGestureInProgress(intents.gestureInProgress);
  renderer.setZoomGestureActive(intents.zoomGestureActive);
  renderer.setZoomFocus(
    intents.zoomFocusX,
    intents.zoomFocusY,
    intents.zoomingOut,
  );
  if (intents.gestureEnded) {
    renderer.notifyGestureEnded(
      intents.endedGestureWasZoom,
      options.board.camera.scale,
    );
  }
}

function applyBoardIntents(
  options: InputWiringOptions,
  intents: FrameIntents,
): number {
  let changes = 0;
  if (intents.bringToFrontId !== undefined) {
    options.board.bringToFront(intents.bringToFrontId);
  }
  if (intents.moveWidgetId !== undefined) {
    options.board.moveWidget(
      intents.moveWidgetId,
      intents.moveX,
      intents.moveY,
    );
    changes |= WIDGET_CHANGED;
  }
  if (intents.resizeWidgetId !== undefined) {
    options.board.resizeWidget(
      intents.resizeWidgetId,
      intents.resizeWidth,
      intents.resizeHeight,
    );
    changes |= WIDGET_CHANGED;
  }
  changes |= applyCameraIntents(options, intents);
  if (intents.scrollWidgetId !== undefined && intents.scrollDeltaY !== 0) {
    options.board.scrollWidget(intents.scrollWidgetId, intents.scrollDeltaY);
  }
  return changes;
}

function applyCameraIntents(
  options: InputWiringOptions,
  intents: FrameIntents,
): number {
  let changes = 0;
  if (intents.panX || intents.panY) {
    options.board.pan(intents.panX, intents.panY);
    changes |= CAMERA_CHANGED;
  }
  if (intents.zoomFactor !== 1) {
    options.board.zoomAt(intents.zoomX, intents.zoomY, intents.zoomFactor);
    changes |= CAMERA_CHANGED;
  }
  if (intents.zoomToWidgetId !== undefined) {
    const viewportWidth = options.canvas.clientWidth || window.innerWidth;
    const viewportHeight = options.canvas.clientHeight || window.innerHeight;
    options.board.zoomToWidget(
      intents.zoomToWidgetId,
      viewportWidth,
      viewportHeight,
    );
    changes |= CAMERA_CHANGED;
  }
  if (intents.fitAll || intents.zoomTo100) {
    const viewportWidth = options.canvas.clientWidth || window.innerWidth;
    const viewportHeight = options.canvas.clientHeight || window.innerHeight;
    if (intents.fitAll) {
      options.board.fitAll(viewportWidth, viewportHeight);
    }
    if (intents.zoomTo100) {
      options.board.zoomTo100(viewportWidth, viewportHeight);
    }
    changes |= CAMERA_CHANGED;
  }
  return changes;
}

function keepGestureAlive(
  targeting: GestureTargeting,
  frameLoop: FrameLoop,
): void {
  frameLoop.setGestureInProgress(targeting.gestureInProgress);
}

function wireCanvasInput(options: InputWiringOptions): void {
  let capturedPointerId: number | undefined;
  options.canvas.addEventListener(
    "wheel",
    (event) => {
      options.targeting.wheel(event);
      options.getFrameLoop()?.invalidate();
    },
    { passive: false },
  );
  options.canvas.addEventListener("dblclick", (event) => {
    options.targeting.doubleClick(event);
    options.getFrameLoop()?.invalidate();
  });
  options.canvas.addEventListener("pointerdown", (event) => {
    options.targeting.pointerDown(event);
    if (event.button === 0) {
      capturedPointerId = event.pointerId;
      options.canvas.setPointerCapture(event.pointerId);
    }
    options.getFrameLoop()?.invalidate();
  });
  options.canvas.addEventListener("pointermove", (event) => {
    options.targeting.pointerMove(event);
    if (options.targeting.gestureInProgress) {
      options.getFrameLoop()?.invalidate();
    }
  });
  const pointerEnd = (event: PointerEvent): void => {
    options.targeting.pointerUp(event);
    if (capturedPointerId === event.pointerId) {
      options.canvas.releasePointerCapture(event.pointerId);
      capturedPointerId = undefined;
    }
    options.getFrameLoop()?.invalidate();
  };
  options.canvas.addEventListener("pointerup", pointerEnd);
  options.canvas.addEventListener("pointercancel", pointerEnd);
}

function wireKeyboardInput(options: InputWiringOptions): void {
  window.addEventListener("keydown", (event) => {
    if (isKeyboardExcludedTarget(event.target, options.editorContainer)) return;
    options.targeting.keyDown(event);
    options.getFrameLoop()?.invalidate();
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") options.targeting.keyUp(event);
  });
}

function isKeyboardExcludedTarget(
  target: EventTarget | null,
  editorContainer: HTMLElement,
): boolean {
  if (!(target instanceof Node)) return false;
  if (editorContainer.contains(target)) return true;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.tagName === "BUTTON"
  );
}

function wireEditorWheel(
  options: InputWiringOptions,
  adapter: EditorWheelInput,
  setEvent: (event: WheelEvent) => void,
  clearEvent: () => void,
): void {
  options.editorContainer.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      setEvent(event);
      adapter.deltaX = event.deltaX;
      adapter.deltaY = event.deltaY;
      adapter.ctrlKey = event.ctrlKey;
      adapter.metaKey = event.metaKey;
      adapter.offsetX = event.clientX;
      adapter.offsetY = event.clientY;
      adapter.timeStamp = event.timeStamp;
      options.targeting.wheel(adapter);
      event.stopPropagation();
      options.getFrameLoop()?.invalidate();
      clearEvent();
    },
    { capture: true, passive: false },
  );
}
