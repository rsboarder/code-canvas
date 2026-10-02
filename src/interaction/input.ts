import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../shared/pinch";

// DOM wheel streams have no end event, so a pan/scroll/ctrl-pinch gesture is
// considered over once no wheel event arrived for this long. GestureTargeting
// (task 10.1) will own this rule once it exists.
export const WHEEL_GESTURE_END_MS = 150;

export class GestureInput {
  private panX = 0;
  private panY = 0;
  private zoomFactor = 1;
  private zoomX = 0;
  private zoomY = 0;
  private zoomDirection = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private wheelActive = false;
  private gestureInProgress = false;
  // Whether the current gesture (start to end, including its momentum/idle
  // tail) carried a ctrl/meta wheel event — the only way to tell a zoom
  // gesture apart from a pan once GestureTargeting (task 10.1) does not yet
  // exist. Reset on every new gesture's start; rendering reads it live via
  // `isZoomGestureActive` to freeze Text Tiles at their raster scale during
  // the gesture (design D6 "Zoom"), and reads `wasZoom` on the end callback
  // to decide whether to re-rasterize at the settled scale.
  private gestureHadZoom = false;
  private wheelIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly consumed = {
    panX: 0,
    panY: 0,
    zoomFactor: 1,
    zoomX: 0,
    zoomY: 0,
  };

  attach(
    canvas: HTMLCanvasElement,
    invalidate: () => void,
    onCanvasGesture?: (kind: "pan" | "zoom") => void,
    onGestureInProgressChange?: (inProgress: boolean, wasZoom: boolean) => void,
  ): () => void {
    const reportGesture = (active: boolean): void => {
      if (active === this.gestureInProgress) return;
      this.gestureInProgress = active;
      if (active) this.resetZoomGesture();
      onGestureInProgressChange?.(active, this.gestureHadZoom);
    };
    const restartWheelIdleTimer = (): void => {
      clearTimeout(this.wheelIdleTimer);
      this.wheelIdleTimer = setTimeout(() => {
        this.wheelActive = false;
        reportGesture(this.dragging);
      }, WHEEL_GESTURE_END_MS);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      reportGesture(true);
      if (event.ctrlKey || event.metaKey) {
        onCanvasGesture?.("zoom");
        this.gestureHadZoom = true;
        const lnZoomStep = clamp(
          -event.deltaY / PINCH_WHEEL_DELTA_PER_LN_SCALE,
          -MAX_ZOOM_STEP_LN,
          MAX_ZOOM_STEP_LN,
        );
        this.zoomDirection = Math.sign(lnZoomStep);
        this.zoomFactor *= Math.exp(lnZoomStep);
        this.zoomX = event.offsetX;
        this.zoomY = event.offsetY;
      } else {
        onCanvasGesture?.("pan");
        this.panX -= event.deltaX;
        this.panY -= event.deltaY;
      }
      this.wheelActive = true;
      restartWheelIdleTimer();
      invalidate();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      onCanvasGesture?.("pan");
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      reportGesture(true);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!this.dragging) return;
      this.panX += event.clientX - this.lastX;
      this.panY += event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      invalidate();
    };
    const pointerUp = (event: PointerEvent) => {
      this.dragging = false;
      canvas.releasePointerCapture(event.pointerId);
      reportGesture(this.wheelActive);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    return () => {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      clearTimeout(this.wheelIdleTimer);
    };
  }

  consume(): {
    panX: number;
    panY: number;
    zoomFactor: number;
    zoomX: number;
    zoomY: number;
  } {
    this.consumed.panX = this.panX;
    this.consumed.panY = this.panY;
    this.consumed.zoomFactor = this.zoomFactor;
    this.consumed.zoomX = this.zoomX;
    this.consumed.zoomY = this.zoomY;
    this.panX = 0;
    this.panY = 0;
    this.zoomFactor = 1;
    return this.consumed;
  }

  // Read live, once per frame: whether a gesture (of any kind) is currently
  // in progress, for the "at rest" tile pixel-snap (design D6 "Tile pool").
  isGestureInProgress(): boolean {
    return this.gestureInProgress;
  }

  // Read live, once per frame: a zoom gesture — as opposed to a pan — is in
  // progress, so rendering should keep resident Text Tiles at their current
  // raster scale rather than re-rasterizing mid-gesture (design D6 "Zoom").
  isZoomGestureActive(): boolean {
    return this.gestureInProgress && this.gestureHadZoom;
  }

  zoomFocusX(): number {
    return this.zoomX;
  }

  zoomFocusY(): number {
    return this.zoomY;
  }

  zoomDirectionSign(): number {
    return this.zoomDirection;
  }

  private resetZoomGesture(): void {
    this.gestureHadZoom = false;
    this.zoomDirection = 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
