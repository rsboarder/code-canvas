import { Camera, type CameraView } from "../../board/index";
import type { Rect } from "../../shared/geometry/geometry";
import type { RasterResult } from "../text/raster-job";
import type { Viewport } from "../viewport";
import type { TileContentSource, TileJobOwner } from "./tile-job-queue";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  TileRecords,
} from "./tile-records";
import { previousPowerOfTwo, TileSetPlanner } from "./tile-sets";
import {
  prefetchViewWindow,
  type PrefetchViewWindowInput,
  type ViewWindow,
} from "./tile-view-window";
import type { TilePool } from "./tile-pool";

export class WidgetTiles implements TileJobOwner {
  readonly records: TileRecords;
  readonly planner: TileSetPlanner;
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
  epoch = 0;
  row = -1;
  textReady = false;
  exactVisibleReady = false;
  private labelZoom = Number.NaN;
  private labelFrameWidth = Number.NaN;
  private labelFrameHeight = Number.NaN;

  constructor(
    fileId: string,
    pool: TilePool,
    capacity: number,
    onKeyReleased?: (key: string) => void,
  ) {
    this.fileId = fileId;
    this.records = new TileRecords(pool, capacity, { onKeyReleased });
    this.planner = new TileSetPlanner(this.records.records, capacity);
  }

  setContentSource(source: TileContentSource): void {
    const label = source.label ?? this.contentSource?.label;
    const nextSource = label ? { ...source, label } : source;
    this.contentSource = nextSource;
    this.epoch += 1;
    this.records.setContentSource(nextSource, this.epoch);
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

  isResultCurrent(
    record: number,
    result: Pick<RasterResult, "rasterScale" | "contentVersion">,
  ): boolean {
    const records = this.records.records;
    const kind = records.kind[record];
    if (
      records.rasterScale[record] !== result.rasterScale ||
      (kind === CONTENT_KIND && records.epoch[record] !== this.epoch) ||
      (kind === CONTENT_KIND &&
        this.records.requestedContentVersion[record] !== result.contentVersion)
    )
      return false;
    if (kind === HEADER_KIND) return this.isHeaderRequested(record);
    if (kind === LABEL_KIND)
      return (
        this.planner.requestLabel &&
        records.rasterScale[record] === this.planner.requestedLabelScale
      );
    return this.planner.isRequested(
      result.rasterScale,
      records.column[record] ?? 0,
      records.row[record] ?? 0,
      records.epoch[record] ?? 0,
    );
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
    this.planner.setContentSize(this.frame.width, source.contentHeight);
    this.planner.setHeaderHeight(bodyTop);
    this.records.setHeaderHeight(bodyTop);
    this.records.setContentWidth(this.frame.width);
    this.planner.setVisibleBounds(
      this.visibleWindow.left,
      this.visibleWindow.top,
      this.visibleWindow.right,
      this.visibleWindow.bottom,
    );
    this.planner.setZoom(
      zoomGestureActive ? camera.scale : settledZoom,
      viewport.devicePixelRatio,
      zoomGestureActive,
    );
    this.planner.setAtRestScale(settledZoom * viewport.devicePixelRatio);
    this.planner.setLabelIdentity(source.label?.identity ?? "");
    this.planner.setLabelActive(true);
    this.planner.setMinimapActive(minimapActive);
    this.planner.setTextWanted(textWanted);
    this.setPrefetch(input);
    this.planner.setEpoch(this.epoch);
    this.planner.build(this.records.records.active.length);
    this.textReady = source.hasText && this.planner.textReady();
    this.exactVisibleReady = source.hasText && this.planner.exactVisibleReady();
  }

  release(): void {
    for (
      let index = 0;
      index < this.records.records.active.length;
      index += 1
    ) {
      if (this.records.records.active[index]) this.records.releaseRecord(index);
    }
    this.contentSource = undefined;
    this.labelZoom = Number.NaN;
    this.labelFrameWidth = Number.NaN;
    this.labelFrameHeight = Number.NaN;
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
    this.planner.setPrefetchRasterScale(
      textPrefetch ? textPrefetchZoom * viewport.devicePixelRatio : 0,
    );
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

  private isHeaderRequested(record: number): boolean {
    const records = this.records.records;
    if (records.rasterScale[record] !== this.planner.requestedHeaderScale)
      return false;
    const column = records.column[record] ?? 0;
    for (let index = 0; index < this.planner.requestHeaderCount; index += 1) {
      if (this.planner.requestHeaderColumns[index] === column) return true;
    }
    return false;
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
