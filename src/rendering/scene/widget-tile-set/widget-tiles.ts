import { Camera, type CameraView } from "../../../board/index";
import type { Rect } from "../../../shared/geometry/geometry";
import type { RasterResult } from "../../text/raster-job";
import type { Viewport } from "../../viewport";
import type { TileJobOwner } from "../tile-job-queue";
import type { TileContentSource } from "../tile-kind-jobs";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  TileRecords,
  type TileRecordPool,
} from "./tile-records";
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

export interface TileRecordView {
  key: string | undefined;
  active: boolean;
  ready: boolean;
  pending: boolean;
  kind: number;
  rasterScale: number;
  epoch: number;
  contentVersion: number;
  column: number;
  row: number;
  localX: number;
  localY: number;
  width: number;
  height: number;
  highlighted: boolean;
}

export class WidgetTiles implements TileJobOwner {
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
  private readonly records: TileRecords;
  private readonly planner: TileSetPlanner;
  private readonly recordView: TileRecordView = {
    key: undefined,
    active: false,
    ready: false,
    pending: false,
    kind: CONTENT_KIND,
    rasterScale: 1,
    epoch: 0,
    contentVersion: -1,
    column: 0,
    row: 0,
    localX: 0,
    localY: 0,
    width: 0,
    height: 0,
    highlighted: false,
  };

  constructor(
    fileId: string,
    pool: TileRecordPool,
    capacity: number,
    onKeyReleased?: (key: string) => void,
  ) {
    this.fileId = fileId;
    this.frameState = createWidgetTileFrameState();
    this.records = new TileRecords(pool, capacity, this.frameState, {
      onKeyReleased,
    });
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

  get recordCapacity(): number {
    return this.records.records.active.length;
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

  get requestedScale(): number {
    return this.planner.requestedScale;
  }

  get requestedHeaderScale(): number {
    return this.planner.requestedHeaderScale;
  }

  get requestedLabelScale(): number {
    return this.planner.requestedLabelScale;
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

  drawRecords(kind: number, fallback: boolean): Int32Array {
    if (kind === HEADER_KIND)
      return fallback
        ? this.planner.drawHeaderFallback
        : this.planner.drawHeaderCurrent;
    if (kind === LABEL_KIND)
      return fallback
        ? this.planner.drawLabelFallback
        : this.planner.drawLabelCurrent;
    return fallback ? this.planner.drawFallback : this.planner.drawCurrent;
  }

  drawRecordCount(kind: number, fallback: boolean): number {
    if (kind === HEADER_KIND)
      return fallback
        ? this.planner.drawHeaderFallbackCount
        : this.planner.drawHeaderCurrentCount;
    if (kind === LABEL_KIND)
      return fallback
        ? this.planner.drawLabelFallbackCount
        : this.planner.drawLabelCurrentCount;
    return fallback
      ? this.planner.drawFallbackCount
      : this.planner.drawCurrentCount;
  }

  prefetchScale(): number {
    return this.planner.prefetchScale();
  }

  ensureRecord(
    kind: number,
    scale: number,
    column: number,
    row: number,
  ): number {
    return this.records.ensureRecord(kind, scale, column, row);
  }

  readRecord(record: number): TileRecordView {
    this.recordView.key = this.records.keys[record];
    this.recordView.active = this.records.records.active[record] === 1;
    this.recordView.ready = this.records.records.ready[record] === 1;
    this.recordView.pending = this.records.pending[record] === 1;
    this.recordView.kind = this.records.recordKind(record);
    this.recordView.rasterScale = this.records.recordRasterScale(record);
    this.recordView.epoch = this.records.records.epoch[record] ?? 0;
    this.recordView.contentVersion =
      this.records.records.contentVersion[record] ?? -1;
    this.recordView.column = this.records.recordColumn(record);
    this.recordView.row = this.records.recordRow(record);
    this.recordView.localX = this.records.records.localX[record] ?? 0;
    this.recordView.localY = this.records.records.localY[record] ?? 0;
    this.recordView.width = this.records.recordWidth(record);
    this.recordView.height = this.records.recordHeight(record);
    this.recordView.highlighted = this.records.highlighted[record] === 1;
    return this.recordView;
  }

  recordKey(record: number): string | undefined {
    return this.records.keys[record];
  }

  findRecordByKey(key: string): number {
    return this.records.findRecordByKey(key);
  }

  findRecord(kind: number, scale: number, column: number, row: number): number {
    return this.records.findRecord(kind, scale, column, row);
  }

  isRecordReady(record: number): boolean {
    return this.records.records.ready[record] === 1;
  }

  releaseRecord(record: number): void {
    this.records.releaseRecord(record);
  }

  deactivateRecordByKey(key: string): void {
    this.records.deactivateByKey(key);
  }

  setRecordPending(record: number, pending: boolean): void {
    this.records.pending[record] = pending ? 1 : 0;
  }

  setRecordReady(record: number, ready: boolean): void {
    this.records.records.ready[record] = ready ? 1 : 0;
  }

  setRequestedContentVersion(record: number, version: number): void {
    this.records.requestedContentVersion[record] = version;
  }

  isRecordActive(record: number): boolean {
    return this.records.records.active[record] === 1;
  }

  isRequested(
    rasterScale: number,
    column: number,
    row: number,
    epoch: number,
  ): boolean {
    return this.planner.isRequested(rasterScale, column, row, epoch);
  }

  exitViewCovered(contentVersion: number, contentScroll: number): boolean {
    const sourceVersion = this.contentSource?.contentVersion;
    if (sourceVersion === undefined || sourceVersion < contentVersion)
      return false;
    return this.frameState.contentScroll === contentScroll && this.textReady;
  }

  recordKind(record: number): number {
    return this.records.recordKind(record);
  }

  recordRasterScale(record: number): number {
    return this.records.recordRasterScale(record);
  }

  recordEpoch(record: number): number {
    return this.records.recordEpoch(record);
  }

  recordColumn(record: number): number {
    return this.records.recordColumn(record);
  }

  recordRow(record: number): number {
    return this.records.recordRow(record);
  }

  recordWidth(record: number): number {
    return this.records.recordWidth(record);
  }

  recordHeight(record: number): number {
    return this.records.recordHeight(record);
  }

  isResultCurrent(
    record: number,
    result: Pick<RasterResult, "rasterScale" | "contentVersion">,
  ): boolean {
    const records = this.records.records;
    const kind = records.kind[record];
    if (
      records.rasterScale[record] !== result.rasterScale ||
      (kind === CONTENT_KIND &&
        records.epoch[record] !== this.frameState.epoch) ||
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
