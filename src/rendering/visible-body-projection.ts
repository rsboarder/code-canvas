import { Camera, type CameraView } from "../board/index";
import type { Rect } from "../shared/geometry/geometry";
import type { Viewport } from "./viewport";
import {
  bodyViewWindow,
  type BodyViewWindowInput,
  type ViewWindow,
} from "./scene/tile-view-window";
import { MAX_WIDGET_ROWS, WidgetTable } from "./scene/widget-table";

export class VisibleBodyProjection {
  private readonly table: WidgetTable;
  private readonly visibleRows = new Uint8Array(MAX_WIDGET_ROWS);
  private readonly windows: ViewWindow[] = [];
  private readonly frame: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly input: BodyViewWindowInput = {
    camera: new Camera(),
    viewport: { width: 0, height: 0, devicePixelRatio: 1 },
    frame: this.frame,
    bodyTop: 0,
    contentScroll: 0,
  };
  private previousRowCount = 0;
  private hasSnapshot = false;
  private cameraOffsetX = 0;
  private cameraOffsetY = 0;
  private cameraScale = 1;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private viewportDevicePixelRatio = 1;
  private bodyTop = 0;

  constructor(table: WidgetTable) {
    this.table = table;
    for (let row = 0; row < MAX_WIDGET_ROWS; row += 1)
      this.windows.push({ left: 0, top: 0, right: 0, bottom: 0 });
  }

  update(camera: CameraView, viewport: Viewport, bodyTop: number): void {
    this.rememberInputs(camera, viewport, bodyTop);
    this.input.camera = camera;
    this.input.viewport = viewport;
    this.input.bodyTop = bodyTop;
    const rowCount = this.table.rowCount;
    for (let row = 0; row < rowCount; row += 1) this.updateRow(row);
    for (let row = rowCount; row < this.previousRowCount; row += 1)
      this.visibleRows[row] = 0;
    this.previousRowCount = rowCount;
    this.hasSnapshot = true;
  }

  refresh(camera: CameraView, viewport: Viewport, bodyTop: number): boolean {
    if (this.matches(camera, viewport, bodyTop)) return false;
    this.update(camera, viewport, bodyTop);
    return true;
  }

  windowAt(row: number): Readonly<ViewWindow> | undefined {
    if (row < 0 || row >= this.previousRowCount) return undefined;
    if (this.visibleRows[row] === 0) return undefined;
    return this.windows[row];
  }

  private updateRow(row: number): void {
    this.visibleRows[row] = 0;
    if (this.table.widgetIdAt(row) === undefined) return;
    if (!this.table.readFrame(row, this.frame)) return;
    this.input.contentScroll = this.table.contentScrollAt(row);
    const window = this.windows[row];
    if (window && bodyViewWindow(this.input, window)) this.visibleRows[row] = 1;
  }

  private rememberInputs(
    camera: CameraView,
    viewport: Viewport,
    bodyTop: number,
  ): void {
    this.cameraOffsetX = camera.offsetX;
    this.cameraOffsetY = camera.offsetY;
    this.cameraScale = camera.scale;
    this.viewportWidth = viewport.width;
    this.viewportHeight = viewport.height;
    this.viewportDevicePixelRatio = viewport.devicePixelRatio;
    this.bodyTop = bodyTop;
  }

  private matches(
    camera: CameraView,
    viewport: Viewport,
    bodyTop: number,
  ): boolean {
    return (
      this.hasSnapshot &&
      this.cameraOffsetX === camera.offsetX &&
      this.cameraOffsetY === camera.offsetY &&
      this.cameraScale === camera.scale &&
      this.viewportWidth === viewport.width &&
      this.viewportHeight === viewport.height &&
      this.viewportDevicePixelRatio === viewport.devicePixelRatio &&
      this.bodyTop === bodyTop
    );
  }
}
