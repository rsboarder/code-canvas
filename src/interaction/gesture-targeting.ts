import {
  createHitTestResult,
  createWidgetRow,
  type BoardReadModel,
  type HitTestResult,
  type WidgetRow,
} from "../board";
import type { EditingEndReason } from "../editing";
import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../shared/pinch";

type WidgetId = Parameters<BoardReadModel["readWidget"]>[0];

export const WHEEL_GESTURE_END_MS = 150;

export type GestureBoard = Pick<
  BoardReadModel,
  "camera" | "detailLevel" | "hitTest" | "readWidget"
>;

interface GestureEditing {
  readonly activeWidgetId: string | undefined;
}

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly timeStamp: number;
  preventDefault(): void;
}

export interface PointerInput {
  readonly button: number;
  readonly pointerId: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly timeStamp: number;
}

export interface KeyInput {
  readonly code: string;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
}

export interface FrameIntents {
  fitAll: boolean;
  zoomTo100: boolean;
  zoomToWidgetId: WidgetId | undefined;
  toggleMetricsOverlay: boolean;
  panX: number;
  panY: number;
  zoomFactor: number;
  zoomX: number;
  zoomY: number;
  scrollWidgetId: WidgetId | undefined;
  scrollDeltaY: number;
  endEditing: EditingEndReason | undefined;
  pendingGesture: "pan" | "zoom" | undefined;
  gestureInProgress: boolean;
  zoomGestureActive: boolean;
  gestureEnded: boolean;
  endedGestureWasZoom: boolean;
  zoomFocusX: number;
  zoomFocusY: number;
  zoomingOut: boolean;
  moveWidgetId: WidgetId | undefined;
  moveX: number;
  moveY: number;
  resizeWidgetId: WidgetId | undefined;
  resizeWidth: number;
  resizeHeight: number;
  bringToFrontId: WidgetId | undefined;
}

type WheelTarget = "zoom" | "editor" | "scroll" | "pan";
type PointerTarget = "pan" | "drag" | "resize" | "click" | "none";
type ResizeZone = "right-edge" | "bottom-edge" | "corner";

export class GestureTargeting {
  private readonly hit: HitTestResult = createHitTestResult();
  private readonly widget: WidgetRow = createWidgetRow();
  private readonly intents: FrameIntents = createFrameIntents();
  private panX = 0;
  private panY = 0;
  private moveWidgetId: WidgetId | undefined;
  private moveX = 0;
  private moveY = 0;
  private resizeWidgetId: WidgetId | undefined;
  private resizeWidth = 0;
  private resizeHeight = 0;
  private bringToFrontId: WidgetId | undefined;
  private zoomFactor = 1;
  private zoomX = 0;
  private zoomY = 0;
  private zoomingOut = false;
  private scrollWidgetId: WidgetId | undefined;
  private scrollDeltaY = 0;
  private endEditing: EditingEndReason | undefined;
  private pendingGesture: "pan" | "zoom" | undefined;
  private gestureEnded = false;
  private endedGestureWasZoom = false;
  private wheelInProgress = false;
  private wheelTarget: WheelTarget = "pan";
  private wheelZoom = false;
  private wheelWidgetId: WidgetId | undefined;
  private lastWheelTimeStamp = 0;
  private wheelExitReported = false;
  private pointerInProgress = false;
  private pointerId = 0;
  private pointerTarget: PointerTarget = "none";
  private pointerResizeZone: ResizeZone | undefined;
  private pointerWidgetId: WidgetId | undefined;
  private pointerOriginX = 0;
  private pointerOriginY = 0;
  private pointerWidth = 0;
  private pointerHeight = 0;
  private pointerStartBoardX = 0;
  private pointerStartBoardY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private spaceHeld = false;
  private fitAll = false;
  private zoomTo100 = false;
  private zoomToWidgetId: WidgetId | undefined;
  private toggleMetricsOverlay = false;

  constructor(
    private readonly board: GestureBoard,
    private readonly editing: GestureEditing,
  ) {}

  get gestureInProgress(): boolean {
    return this.wheelInProgress || this.pointerInProgress;
  }

  get endEditingRequest(): EditingEndReason | undefined {
    return this.endEditing;
  }

  get endEditingGesture(): "pan" | "zoom" | undefined {
    return this.pendingGesture;
  }

  wheel(event: WheelInput): void {
    const zoom = event.ctrlKey || event.metaKey;
    const priorTarget = this.wheelTarget;
    const priorWidgetId = this.wheelWidgetId;
    if (
      this.wheelInProgress &&
      (zoom !== this.wheelZoom ||
        event.timeStamp - this.lastWheelTimeStamp >= WHEEL_GESTURE_END_MS)
    ) {
      this.endWheel();
    }
    if (!this.wheelInProgress) {
      this.beginWheel(event, zoom);
      if (priorTarget === "scroll" && priorWidgetId !== this.wheelWidgetId) {
        this.scrollDeltaY = 0;
        this.scrollWidgetId = undefined;
      }
    }
    this.lastWheelTimeStamp = event.timeStamp;
    if (this.wheelTarget !== "editor") event.preventDefault();
    this.applyWheel(event);
  }

  pointerDown(event: PointerInput): void {
    if (event.button !== 0 || this.pointerInProgress) return;
    this.pointerInProgress = true;
    this.pointerId = event.pointerId;
    this.lastPointerX = event.offsetX;
    this.lastPointerY = event.offsetY;
    this.pointerResizeZone = undefined;
    this.board.hitTest(event.offsetX, event.offsetY, this.hit);
    if (this.spaceHeld) {
      this.pointerTarget = "pan";
      this.markPointerPanEditingExit();
      return;
    }
    this.pointerTarget = this.pointerTargetForHit();
    if (this.pointerTarget === "none") return;
    const widgetId = this.hit.widgetId;
    if (widgetId === undefined) return;
    this.pointerWidgetId = widgetId;
    if (this.pointerTarget === "click") {
      this.bringToFrontId = widgetId;
      return;
    }
    this.board.readWidget(widgetId, this.widget);
    this.pointerOriginX = this.widget.x;
    this.pointerOriginY = this.widget.y;
    this.pointerWidth = this.widget.width;
    this.pointerHeight = this.widget.height;
    this.pointerStartBoardX = this.toBoardX(event.offsetX);
    this.pointerStartBoardY = this.toBoardY(event.offsetY);
    this.bringToFrontId = widgetId;
  }

  pointerMove(event: PointerInput): void {
    if (!this.pointerInProgress || event.pointerId !== this.pointerId) return;
    this.applyPointerMove(event);
    this.lastPointerX = event.offsetX;
    this.lastPointerY = event.offsetY;
  }

  pointerUp(event: PointerInput): void {
    if (!this.pointerInProgress || event.pointerId !== this.pointerId) return;
    const accepted = this.pointerTarget !== "none";
    this.applyPointerMove(event);
    this.pointerInProgress = false;
    this.pointerTarget = "none";
    this.pointerResizeZone = undefined;
    this.pointerWidgetId = undefined;
    if (!accepted) return;
    this.gestureEnded = true;
    this.endedGestureWasZoom = false;
  }

  requestFitAll(): void {
    this.fitAll = true;
    if (this.editing.activeWidgetId === undefined) return;
    this.endEditing = "zoom";
    this.pendingGesture = undefined;
  }

  requestZoomTo100(): void {
    this.zoomTo100 = true;
    if (this.editing.activeWidgetId === undefined) return;
    this.endEditing = "zoom";
    this.pendingGesture = undefined;
  }

  keyDown(event: KeyInput): void {
    if (event.code === "Space") {
      if (event.repeat) return;
      this.spaceHeld = true;
      event.preventDefault();
      return;
    }
    if (
      event.repeat ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    if (event.code === "Digit1") {
      this.requestFitAll();
    } else if (event.code === "Digit0") {
      this.requestZoomTo100();
    } else if (event.code === "KeyM") {
      this.toggleMetricsOverlay = true;
    } else {
      return;
    }
    event.preventDefault();
  }

  keyUp(event: KeyInput): void {
    if (event.code === "Space") this.spaceHeld = false;
  }

  doubleClick(event: {
    readonly offsetX: number;
    readonly offsetY: number;
  }): void {
    if (this.board.detailLevel !== "minimap") return;
    this.board.hitTest(event.offsetX, event.offsetY, this.hit);
    this.zoomToWidgetId = this.hit.widgetId;
  }

  takeIntents(now: number): FrameIntents {
    if (
      this.wheelInProgress &&
      now >= this.lastWheelTimeStamp + WHEEL_GESTURE_END_MS
    ) {
      this.endWheel();
    }
    this.intents.gestureInProgress =
      this.wheelInProgress || this.pointerInProgress;
    this.intents.zoomGestureActive = this.wheelInProgress && this.wheelZoom;
    this.intents.fitAll = this.fitAll;
    this.intents.zoomTo100 = this.zoomTo100;
    this.intents.zoomToWidgetId = this.zoomToWidgetId;
    this.intents.toggleMetricsOverlay = this.toggleMetricsOverlay;
    this.intents.panX = this.panX;
    this.intents.panY = this.panY;
    this.intents.zoomFactor = this.zoomFactor;
    this.intents.zoomX = this.zoomX;
    this.intents.zoomY = this.zoomY;
    this.intents.scrollWidgetId = this.scrollWidgetId;
    this.intents.scrollDeltaY = this.scrollDeltaY;
    this.intents.endEditing = this.endEditing;
    this.intents.pendingGesture = this.pendingGesture;
    this.intents.gestureEnded = this.gestureEnded;
    this.intents.endedGestureWasZoom = this.endedGestureWasZoom;
    this.intents.zoomFocusX = this.zoomX;
    this.intents.zoomFocusY = this.zoomY;
    this.intents.zoomingOut = this.zoomingOut;
    this.intents.moveWidgetId = this.moveWidgetId;
    this.intents.moveX = this.moveX;
    this.intents.moveY = this.moveY;
    this.intents.resizeWidgetId = this.resizeWidgetId;
    this.intents.resizeWidth = this.resizeWidth;
    this.intents.resizeHeight = this.resizeHeight;
    this.intents.bringToFrontId = this.bringToFrontId;
    const result = this.intents;
    this.resetAccumulators();
    return result;
  }

  private beginWheel(event: WheelInput, zoom: boolean): void {
    this.wheelInProgress = true;
    this.wheelZoom = zoom;
    this.wheelExitReported = false;
    this.board.hitTest(event.offsetX, event.offsetY, this.hit);
    this.wheelWidgetId = this.hit.widgetId;
    if (zoom) {
      this.wheelTarget = "zoom";
      this.markWheelEditingExit("zoom");
      return;
    }
    this.wheelTarget = this.wheelTargetForHit();
    if (this.wheelTarget === "pan") this.markWheelEditingExit("pan");
  }

  private wheelTargetForHit(): WheelTarget {
    if (
      this.editing.activeWidgetId !== undefined &&
      this.hit.zone === "body" &&
      this.hit.widgetId === this.editing.activeWidgetId
    ) {
      return "editor";
    }
    if (this.board.detailLevel !== "text" || this.hit.zone !== "body") {
      return "pan";
    }
    if (this.hit.widgetId === undefined) return "pan";
    this.board.readWidget(this.hit.widgetId, this.widget);
    return this.widget.maxContentScroll > 0 ? "scroll" : "pan";
  }

  private applyWheel(event: WheelInput): void {
    if (this.wheelTarget === "editor") return;
    if (this.wheelTarget === "zoom") {
      this.applyZoom(event);
      return;
    }
    if (this.wheelTarget === "scroll") {
      this.scrollWidgetId = this.wheelWidgetId;
      this.scrollDeltaY += event.deltaY / this.board.camera.scale;
      return;
    }
    this.panX -= event.deltaX;
    this.panY -= event.deltaY;
  }

  private applyZoom(event: WheelInput): void {
    const ln = clamp(
      -event.deltaY / PINCH_WHEEL_DELTA_PER_LN_SCALE,
      -MAX_ZOOM_STEP_LN,
      MAX_ZOOM_STEP_LN,
    );
    this.zoomFactor *= Math.exp(ln);
    this.zoomX = event.offsetX;
    this.zoomY = event.offsetY;
    this.zoomingOut = ln < 0;
    this.markWheelEditingExit("zoom");
  }

  private pointerTargetForHit(): PointerTarget {
    const activeId = this.editing.activeWidgetId;
    if (activeId !== undefined) {
      if (this.hit.widgetId === activeId) {
        if (this.hit.zone === "body") return "none";
        if (this.hit.zone !== "empty") return "none";
      } else if (this.hit.widgetId !== undefined) {
        this.endEditing = "outside";
        this.pendingGesture = undefined;
        return "none";
      }
    }
    if (activeId !== undefined) {
      if (this.hit.zone === "empty") {
        this.endEditing = "pan";
        this.pendingGesture = "pan";
      }
    }
    if (this.hit.zone === "empty") return "pan";
    if (this.hit.zone === "header") return "drag";
    if (this.hit.zone === "body") return "click";
    this.pointerResizeZone = this.hit.zone;
    return "resize";
  }

  private applyPointerMove(event: PointerInput): void {
    if (this.pointerTarget === "pan") {
      this.panX += event.offsetX - this.lastPointerX;
      this.panY += event.offsetY - this.lastPointerY;
      return;
    }
    if (this.pointerTarget === "drag") {
      this.moveWidgetId = this.pointerWidgetId;
      this.moveX =
        this.pointerOriginX +
        this.toBoardX(event.offsetX) -
        this.pointerStartBoardX;
      this.moveY =
        this.pointerOriginY +
        this.toBoardY(event.offsetY) -
        this.pointerStartBoardY;
      return;
    }
    if (this.pointerTarget !== "resize") return;
    const deltaX = this.toBoardX(event.offsetX) - this.pointerStartBoardX;
    const deltaY = this.toBoardY(event.offsetY) - this.pointerStartBoardY;
    this.resizeWidgetId = this.pointerWidgetId;
    this.resizeWidth = this.pointerWidth;
    this.resizeHeight = this.pointerHeight;
    if (this.pointerResizeZone !== "bottom-edge") this.resizeWidth += deltaX;
    if (this.pointerResizeZone !== "right-edge") this.resizeHeight += deltaY;
  }

  private markPointerPanEditingExit(): void {
    if (this.editing.activeWidgetId === undefined) return;
    this.endEditing = "pan";
    this.pendingGesture = "pan";
  }

  private toBoardX(screenX: number): number {
    return (screenX - this.board.camera.offsetX) / this.board.camera.scale;
  }

  private toBoardY(screenY: number): number {
    return (screenY - this.board.camera.offsetY) / this.board.camera.scale;
  }

  private endWheel(): void {
    this.wheelInProgress = false;
    this.gestureEnded = true;
    this.endedGestureWasZoom = this.wheelZoom;
  }

  private markWheelEditingExit(kind: "pan" | "zoom"): void {
    if (this.wheelExitReported || this.editing.activeWidgetId === undefined) {
      return;
    }
    this.endEditing = kind;
    this.pendingGesture = kind;
    this.wheelExitReported = true;
  }

  private resetAccumulators(): void {
    this.panX = 0;
    this.panY = 0;
    this.fitAll = false;
    this.zoomTo100 = false;
    this.zoomToWidgetId = undefined;
    this.toggleMetricsOverlay = false;
    this.moveWidgetId = undefined;
    this.moveX = 0;
    this.moveY = 0;
    this.resizeWidgetId = undefined;
    this.resizeWidth = 0;
    this.resizeHeight = 0;
    this.zoomFactor = 1;
    this.scrollWidgetId = undefined;
    this.scrollDeltaY = 0;
    this.endEditing = undefined;
    this.pendingGesture = undefined;
    this.gestureEnded = false;
    this.endedGestureWasZoom = false;
    this.bringToFrontId = undefined;
  }
}

function createFrameIntents(): FrameIntents {
  return {
    fitAll: false,
    zoomTo100: false,
    zoomToWidgetId: undefined,
    toggleMetricsOverlay: false,
    panX: 0,
    panY: 0,
    zoomFactor: 1,
    zoomX: 0,
    zoomY: 0,
    scrollWidgetId: undefined,
    scrollDeltaY: 0,
    endEditing: undefined,
    pendingGesture: undefined,
    gestureInProgress: false,
    zoomGestureActive: false,
    gestureEnded: false,
    endedGestureWasZoom: false,
    zoomFocusX: 0,
    zoomFocusY: 0,
    zoomingOut: false,
    moveWidgetId: undefined,
    moveX: 0,
    moveY: 0,
    resizeWidgetId: undefined,
    resizeWidth: 0,
    resizeHeight: 0,
    bringToFrontId: undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
