export class GestureInput {
  private panX = 0;
  private panY = 0;
  private zoomFactor = 1;
  private zoomX = 0;
  private zoomY = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  attach(
    canvas: HTMLCanvasElement,
    invalidate: () => void,
    onCanvasGesture?: (kind: "pan" | "zoom") => void,
  ): () => void {
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        onCanvasGesture?.("zoom");
        this.zoomFactor *= Math.exp(-event.deltaY * 0.002);
        this.zoomX = event.offsetX;
        this.zoomY = event.offsetY;
      } else {
        onCanvasGesture?.("pan");
        this.panX -= event.deltaX;
        this.panY -= event.deltaY;
      }
      invalidate();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      onCanvasGesture?.("pan");
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
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
    };
  }

  consume(): {
    panX: number;
    panY: number;
    zoomFactor: number;
    zoomX: number;
    zoomY: number;
  } {
    const result = {
      panX: this.panX,
      panY: this.panY,
      zoomFactor: this.zoomFactor,
      zoomX: this.zoomX,
      zoomY: this.zoomY,
    };
    this.panX = 0;
    this.panY = 0;
    this.zoomFactor = 1;
    return result;
  }
}
