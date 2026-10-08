import { Camera, type CameraView } from "../../../board/index";
import type { Rect } from "../../../shared/geometry/geometry";
import type { Viewport } from "../../viewport";
import type { TileContentSource } from "../tile-kind-jobs";
import { TileRecords } from "./tile-records";
import {
  createWidgetTileFrameState,
  type WidgetTileFrameState,
} from "./frame-state";
import { previousPowerOfTwo, TileSetPlanner } from "./tile-sets";
import {
  prefetchViewWindow,
  type PrefetchViewWindowInput,
  type ViewWindow,
} from "../tile-view-window";

export class WidgetTiles {
  private readonly frameState: WidgetTileFrameState;
  readonly frame: Rect = { x: 0, y: 0, width: 0, height: 0 };
  readonly visibleWindow: ViewWindow = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  readonly prefetchWindow: ViewWindow = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };
  readonly prepareInput: WidgetPrepareInput = {
    camera: new Camera(),
    viewport: { width: 0, height: 0, devicePixelRatio: 1 },
    bodyTop: 0,
    contentScroll: 0,
    minimapActive: false,
    textWanted: false,
    zoomGestureActive: false,
    textPrefetchActive: false,
    textPrefetchZoom: 0,
    zoomFocusX: 0,
    zoomFocusY: 0,
    zoomOut: false,
    document: false,
    settledZoom: 1,
  };
  readonly fileId: string;
  contentSource: TileContentSource | undefined;
  windowInput: PrefetchViewWindowInput | undefined;
  row = -1;
  textReady = false;
  exactVisibleReady = false;
  private labelZoom = Number.NaN;
  private labelFrameWidth = Number.NaN;
  private labelFrameHeight = Number.NaN;
  private records: TileRecords;
  private planner: TileSetPlanner;

  constructor(fileId: string, capacity: number) {
    this.fileId = fileId;
    this.frameState = createWidgetTileFrameState();
    this.records = new TileRecords(capacity, this.frameState);
    this.planner = new TileSetPlanner(
      this.records.records,
      capacity,
      this.frameState,
    );
  }

  setContentSource(source: TileContentSource): void {
    const label = source.label ?? this.contentSource?.label;
    const nextSource = label ? { ...source, label } : source;
    this.contentSource = nextSource;
    this.frameState.epoch += 1;
    this.records.setContentSource(nextSource);
    this.textReady = false;
    this.exactVisibleReady = false;
  }

  setLabelSource(label: TileContentSource["label"]): void {
    const source = this.contentSource;
    if (!source || !label) return;
    this.contentSource = { ...source, label };
    this.records.setLabelSource(label);
  }

  needsLabelLayout(zoom: number): boolean {
    return (
      this.labelZoom !== zoom ||
      this.labelFrameWidth !== this.frame.width ||
      this.labelFrameHeight !== this.frame.height
    );
  }

  rememberLabelLayout(zoom: number): void {
    this.labelZoom = zoom;
    this.labelFrameWidth = this.frame.width;
    this.labelFrameHeight = this.frame.height;
  }

  get epoch(): number {
    return this.frameState.epoch;
  }

  get tileRecords(): TileRecords {
    return this.records;
  }

  get plan(): TileSetPlanner {
    return this.planner;
  }

  get drawSet(): TileSetPlanner["drawSet"] {
    return this.planner.drawSetView;
  }

  get requestCount(): number {
    return this.planner.requestCount;
  }

  get requestHeaderCount(): number {
    return this.planner.requestHeaderCount;
  }

  get requestLabel(): boolean {
    return this.planner.requestLabel;
  }

  requestScale(kind: number): number {
    return this.planner.requestScale(kind);
  }

  get visibleFirstColumn(): number {
    return this.planner.visibleFirstColumn;
  }

  get visibleLastColumn(): number {
    return this.planner.visibleLastColumn;
  }

  get visibleFirstRow(): number {
    return this.planner.visibleFirstRow;
  }

  get visibleLastRow(): number {
    return this.planner.visibleLastRow;
  }

  get requestScales(): Float64Array {
    return this.planner.requestScales;
  }

  get requestColumns(): Int32Array {
    return this.planner.requestColumns;
  }

  get requestRows(): Int32Array {
    return this.planner.requestRows;
  }

  get requestHeaderColumns(): Int32Array {
    return this.planner.requestHeaderColumns;
  }

  findRecord(kind: number, scale: number, column: number, row: number): number {
    return this.records.findRecord(kind, scale, column, row);
  }

  exitViewCovered(contentVersion: number, contentScroll: number): boolean {
    const sourceVersion = this.contentSource?.contentVersion;
    if (sourceVersion === undefined || sourceVersion < contentVersion)
      return false;
    return this.frameState.contentScroll === contentScroll && this.textReady;
  }

  restoreResidency(): void {
    const capacity = this.records.records.active.length;
    this.records = new TileRecords(capacity, this.frameState);
    this.planner = new TileSetPlanner(
      this.records.records,
      capacity,
      this.frameState,
    );
    if (this.contentSource) this.records.setContentSource(this.contentSource);
    this.textReady = false;
    this.exactVisibleReady = false;
  }

  prepare(input: WidgetPrepareInput): void {
    const {
      camera,
      viewport,
      bodyTop,
      minimapActive,
      textWanted,
      zoomGestureActive,
      settledZoom,
    } = input;
    const source = this.contentSource;
    if (!source) {
      this.textReady = false;
      this.exactVisibleReady = false;
      return;
    }
    this.frameState.contentWidth = this.frame.width;
    this.frameState.contentHeight = source.contentHeight;
    this.frameState.headerHeight = bodyTop;
    this.frameState.contentScroll = input.contentScroll;
    this.records.setContentWidth(this.frame.width);
    this.frameState.visibleLeft = this.visibleWindow.left;
    this.frameState.visibleTop = this.visibleWindow.top;
    this.frameState.visibleRight = this.visibleWindow.right;
    this.frameState.visibleBottom = this.visibleWindow.bottom;
    this.planner.setZoom(
      zoomGestureActive ? camera.scale : settledZoom,
      viewport.devicePixelRatio,
      zoomGestureActive,
    );
    this.frameState.atRestScale = settledZoom * viewport.devicePixelRatio;
    this.frameState.labelIdentity = source.label?.identity ?? "";
    this.planner.setLabelActive(true);
    this.planner.setMinimapActive(minimapActive);
    this.planner.setTextWanted(textWanted);
    this.setPrefetch(input);
    this.planner.build(this.records.records.active.length);
    this.textReady = source.hasText && this.planner.textReady();
    this.exactVisibleReady = source.hasText && this.planner.exactVisibleReady();
  }

  private setPrefetch(input: WidgetPrepareInput): void {
    const {
      camera,
      viewport,
      contentScroll,
      bodyTop,
      textPrefetchActive,
      textPrefetchZoom,
      zoomGestureActive,
      zoomOut,
      zoomFocusX,
      zoomFocusY,
      minimapActive,
    } = input;
    const textPrefetch =
      minimapActive &&
      zoomGestureActive &&
      textPrefetchActive &&
      textPrefetchZoom > 0;
    const zoomOutPrefetch = zoomGestureActive && zoomOut && !minimapActive;
    this.planner.setPrefetchZoom(textPrefetch ? textPrefetchZoom : 0);
    if (!textPrefetch && !zoomOutPrefetch) {
      this.planner.setPrefetchActive(false);
      return;
    }
    const targetZoom = textPrefetch
      ? textPrefetchZoom
      : previousPowerOfTwo(camera.scale);
    const windowInput = this.windowInput;
    if (!windowInput) {
      this.windowInput = {
        camera,
        viewport,
        frame: this.frame,
        bodyTop,
        contentScroll,
        targetZoom,
        focusX: zoomFocusX,
        focusY: zoomFocusY,
      };
    } else {
      windowInput.camera = camera;
      windowInput.viewport = viewport;
      windowInput.bodyTop = bodyTop;
      windowInput.contentScroll = contentScroll;
      windowInput.targetZoom = targetZoom;
      windowInput.focusX = zoomFocusX;
      windowInput.focusY = zoomFocusY;
    }
    const currentInput = this.windowInput;
    if (!currentInput) return;
    prefetchViewWindow(currentInput, this.prefetchWindow);
    currentInput.contentScroll = contentScroll;
    this.planner.setPrefetchActive(true);
    this.planner.setPrefetchBounds(
      this.prefetchWindow.left,
      this.prefetchWindow.top,
      this.prefetchWindow.right,
      this.prefetchWindow.bottom,
    );
  }
}

interface WidgetPrepareInput {
  camera: CameraView;
  viewport: Viewport;
  bodyTop: number;
  contentScroll: number;
  minimapActive: boolean;
  textWanted: boolean;
  zoomGestureActive: boolean;
  textPrefetchActive: boolean;
  textPrefetchZoom: number;
  zoomFocusX: number;
  zoomFocusY: number;
  zoomOut: boolean;
  document: boolean;
  settledZoom: number;
}
