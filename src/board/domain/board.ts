import type { SourceFileId } from "../../shared/domain";
import type { Vec2 } from "../../shared/geometry";

import { Camera, type CameraView } from "./camera";
import type { BoardMetrics } from "./board-metrics";
import { DetailLevel, type DetailLevelName } from "./detail-level";
import { type HitTestResult, type HitZone } from "./hit-test";
import { type ReconciledLayout } from "./reconcile";
import { type SavedLayout } from "./saved-layout";
import { StackOrder } from "./stack-order";
import { Widget } from "./widget";

const FIT_MARGIN_SCREEN_PX = 40;

interface WidgetView {
  readonly id: SourceFileId;
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly contentScroll: number;
  readonly maxContentScroll: number;
  readonly lineCount: number;
}

export class Board {
  private readonly widgets = new Map<SourceFileId, Widget>();
  private readonly stack = new StackOrder();
  private readonly cameraValue: Camera;
  private readonly detail = new DetailLevel();
  private readonly boardPoint: Vec2 = { x: 0, y: 0 };
  private readonly cameraPoint: Vec2 = { x: 0, y: 0 };

  private constructor(
    private readonly metrics: BoardMetrics,
    layout: ReconciledLayout,
  ) {
    this.cameraValue = new Camera(
      layout.camera === undefined
        ? { x: 0, y: 0 }
        : { x: layout.camera.x, y: layout.camera.y },
      layout.camera?.scale ?? 1,
    );
    for (const placement of layout.widgets) {
      if (this.widgets.has(placement.fileId)) {
        throw new RangeError("Board cannot contain duplicate widget ids.");
      }
      const widget = new Widget(
        placement.fileId,
        placement.path,
        placement.lineCount,
        {
          frame: {
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
          },
          metrics,
        },
      );
      widget.scrollTo(placement.contentScroll);
      this.widgets.set(widget.id, widget);
      this.stack.add(widget.id);
    }
  }

  static fromLayout(metrics: BoardMetrics, layout: ReconciledLayout): Board {
    return new Board(metrics, layout);
  }

  get camera(): CameraView {
    return this.cameraValue;
  }

  get detailLevel(): DetailLevelName {
    return this.detail.value;
  }

  get widgetCount(): number {
    return this.stack.size;
  }

  widget(id: SourceFileId): WidgetView | undefined {
    return this.widgets.get(id);
  }

  widgetIdAtFromTop(index: number): SourceFileId | undefined {
    return this.stack.idAtFromTop(index);
  }

  stackIndexOf(id: SourceFileId): number {
    return this.stack.indexOf(id);
  }

  fitAll(viewportWidth: number, viewportHeight: number): void {
    if (this.widgets.size === 0) return;

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const widget of this.widgets.values()) {
      left = Math.min(left, widget.x);
      top = Math.min(top, widget.y);
      right = Math.max(right, widget.x + widget.width);
      bottom = Math.max(bottom, widget.y + widget.height);
    }

    const boxWidth = right - left;
    const boxHeight = bottom - top;
    const scale = Math.min(
      (viewportWidth - FIT_MARGIN_SCREEN_PX * 2) / boxWidth,
      (viewportHeight - FIT_MARGIN_SCREEN_PX * 2) / boxHeight,
    );
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    this.cameraPoint.x = viewportWidth / 2 - centerX * scale;
    this.cameraPoint.y = viewportHeight / 2 - centerY * scale;
    this.cameraValue.setPosition(this.cameraPoint, scale);
    this.cameraPoint.x = viewportWidth / 2 - centerX * this.cameraValue.scale;
    this.cameraPoint.y = viewportHeight / 2 - centerY * this.cameraValue.scale;
    this.cameraValue.setPosition(this.cameraPoint, this.cameraValue.scale);
  }

  zoomToWidget(
    id: SourceFileId,
    viewportWidth: number,
    viewportHeight: number,
  ): boolean {
    const widget = this.widgets.get(id);
    if (widget === undefined) return false;

    this.cameraPoint.x =
      widget.width + FIT_MARGIN_SCREEN_PX * 2 <= viewportWidth
        ? viewportWidth / 2 - (widget.x + widget.width / 2)
        : FIT_MARGIN_SCREEN_PX - widget.x;
    this.cameraPoint.y =
      widget.height + FIT_MARGIN_SCREEN_PX * 2 <= viewportHeight
        ? viewportHeight / 2 - (widget.y + widget.height / 2)
        : FIT_MARGIN_SCREEN_PX - widget.y;
    this.cameraValue.setPosition(this.cameraPoint, 1);
    return true;
  }

  panCamera(dx: number, dy: number): void {
    this.cameraPoint.x = dx;
    this.cameraPoint.y = dy;
    this.cameraValue.pan(this.cameraPoint);
  }

  zoomCameraAt(screenX: number, screenY: number, factor: number): void {
    this.cameraPoint.x = screenX;
    this.cameraPoint.y = screenY;
    this.cameraValue.zoomToward(this.cameraPoint, factor);
  }

  setCamera(x: number, y: number, scale: number): void {
    this.cameraPoint.x = x;
    this.cameraPoint.y = y;
    this.cameraValue.setPosition(this.cameraPoint, scale);
  }

  moveWidget(id: SourceFileId, x: number, y: number): void {
    this.requireWidget(id).moveTo(x, y);
  }

  resizeWidget(id: SourceFileId, width: number, height: number): void {
    this.requireWidget(id).resizeTo(width, height);
  }

  scrollWidget(id: SourceFileId, deltaY: number): number {
    return this.requireWidget(id).scrollBy(deltaY);
  }

  bringToFront(id: SourceFileId): void {
    this.requireWidget(id);
    this.stack.bringToFront(id);
  }

  setLineCount(id: SourceFileId, lineCount: number): void {
    this.requireWidget(id).setLineCount(lineCount);
  }

  updateDetailLevel(
    devicePixelRatio: number,
    textReady: boolean,
  ): DetailLevelName {
    return this.detail.update(this.lineHeight(devicePixelRatio), textReady);
  }

  textWanted(devicePixelRatio: number): boolean {
    return (
      this.detail.value === "minimap" &&
      this.detail.textWanted(this.lineHeight(devicePixelRatio))
    );
  }

  textThresholdZoom(devicePixelRatio: number): number {
    return this.detail.textThresholdZoom(
      this.metrics.baseLineHeight,
      devicePixelRatio,
    );
  }

  hitTest(screenX: number, screenY: number, out: HitTestResult): HitTestResult {
    this.cameraPoint.x = screenX;
    this.cameraPoint.y = screenY;
    this.cameraValue.toBoard(this.cameraPoint, this.boardPoint);
    out.zone = "empty";
    out.widgetId = undefined;
    out.contentX = 0;
    out.contentY = 0;
    for (let index = 0; index < this.stack.size; index += 1) {
      const id = this.stack.idAtFromTop(index);
      if (id === undefined) continue;
      const widget = this.widgets.get(id);
      if (widget === undefined) continue;
      const zone = this.zoneFor(widget, this.boardPoint.x, this.boardPoint.y);
      if (zone === "empty") continue;
      out.zone = zone;
      out.widgetId = id;
      if (zone === "body") {
        out.contentX = this.boardPoint.x - widget.x;
        out.contentY =
          this.boardPoint.y -
          widget.y -
          this.metrics.headerHeight +
          widget.contentScroll;
      }
      return out;
    }
    return out;
  }

  toSavedLayout(): SavedLayout {
    const widgets: SavedLayout["widgets"][number][] = [];
    for (let index = this.stack.size - 1; index >= 0; index -= 1) {
      const id = this.stack.idAtFromTop(index);
      if (id === undefined) continue;
      const widget = this.widgets.get(id);
      if (widget === undefined) continue;
      widgets.push({
        fileId: widget.id,
        x: widget.x,
        y: widget.y,
        width: widget.width,
        height: widget.height,
        contentScroll: widget.contentScroll,
      });
    }
    return {
      camera: {
        x: this.cameraValue.offsetX,
        y: this.cameraValue.offsetY,
        scale: this.cameraValue.scale,
      },
      widgets,
    };
  }

  private lineHeight(devicePixelRatio: number): number {
    return (
      this.metrics.baseLineHeight * this.cameraValue.scale * devicePixelRatio
    );
  }

  private requireWidget(id: SourceFileId): Widget {
    const widget = this.widgets.get(id);
    if (widget === undefined) {
      throw new RangeError("Unknown widget id.");
    }
    return widget;
  }

  private zoneFor(widget: Widget, x: number, y: number): HitZone {
    const edge = this.edgeZone(widget, x, y);
    if (edge !== undefined) return edge;
    if (!this.isInsideFrame(widget, x, y)) return "empty";
    if (this.detail.value === "minimap") return "header";
    return y < widget.y + this.metrics.headerHeight ? "header" : "body";
  }

  private edgeZone(widget: Widget, x: number, y: number): HitZone | undefined {
    const right = widget.x + widget.width;
    const bottom = widget.y + widget.height;
    const band = this.metrics.edgeGrabScreenPx / this.cameraValue.scale;
    const inRightBand =
      x >= right && x < right + band && y >= widget.y && y < bottom + band;
    const inBottomBand =
      y >= bottom && y < bottom + band && x >= widget.x && x < right + band;
    if (inRightBand && inBottomBand) return "corner";
    if (inRightBand) return "right-edge";
    if (inBottomBand) return "bottom-edge";
    return undefined;
  }

  private isInsideFrame(widget: Widget, x: number, y: number): boolean {
    return (
      x >= widget.x &&
      x < widget.x + widget.width &&
      y >= widget.y &&
      y < widget.y + widget.height
    );
  }
}
