import type { CameraView } from "../../board/index";
import { Camera } from "../../board/index";
import type { GesturePhase } from "../../shared/frame";
import type { Rect } from "../../shared/geometry/geometry";
import type { CodeTextMetrics } from "../text/text-metrics";
import { TilePass, type TileDrawContext } from "../passes/tile-pass";
import type { Viewport } from "../viewport";
import {
  resetFrameDrawMetrics,
  type FrameDrawMetrics,
} from "./frame-draw-metrics";
import { TILE_CELL_LAYERS, TILE_CELLS_PER_LAYER, TilePool } from "./tile-pool";
import {
  TileFramePainter,
  type TileFramePaintInput,
} from "./tile-frame-painter";
import { computeTilePoolCapacity, tilePoolGrowthTarget } from "./tile-plan";
import { TimeToSharpClock } from "./time-to-sharp-clock";
import { TileJobQueue, type TileJobOwner } from "./tile-job-queue";
import type {
  TileContentSource,
  TileLabelContentSource,
} from "./tile-kind-jobs";
import { bodyViewWindow } from "./tile-view-window";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  WidgetTiles,
} from "./widget-tile-set";
import type { WidgetId, WidgetTable } from "./widget-table";

export interface TileDebugSnapshot {
  readonly rasterScales: readonly number[];
  readonly timeToSharpMs: number | undefined;
}

export interface TileDemand {
  capacity: number;
  requested: number;
  pinned: number;
  inFlight: number;
  posted: number;
  stale: number;
  uploadFailed: number;
  visibleExact: boolean;
  clockRunning: boolean;
  gestureActive: boolean;
  minimapActive: boolean;
}

interface TileResidencyConfig {
  readonly metrics: Pick<CodeTextMetrics, "narrowAdvance">;
  readonly font: { readonly family: string; readonly size: number };
  readonly viewport: Viewport;
  readonly table: WidgetTable;
  readonly tableTexture: WebGLTexture;
  readonly titleSourceFor: (fileId: string, path: string) => TileContentSource;
  readonly labelSourceFor: (
    path: string,
    frame: Rect,
    zoom: number,
  ) => TileLabelContentSource;
}

export class TileResidency {
  readonly pool: TilePool;
  private readonly tilePass: TilePass;
  private readonly jobQueue: TileJobQueue;
  private readonly painter: TileFramePainter;
  private readonly table: WidgetTable;
  private readonly widgets = new Map<string, WidgetTiles>();
  private readonly registeredIds: string[] = [];
  private readonly filePaths = new Map<string, string>();
  private readonly keyOwners = new Map<string, WidgetTiles>();
  private readonly visibleWidgets: WidgetTiles[] = [];
  private readonly viewportInput: Viewport = {
    width: 0,
    height: 0,
    devicePixelRatio: 1,
  };
  private readonly missingFrame = { x: 0, y: 0, width: 0, height: 0 };
  private readonly missingWindow = { left: 0, top: 0, right: 0, bottom: 0 };
  private readonly missingInput = {
    camera: new Camera(),
    viewport: this.viewportInput,
    frame: this.missingFrame,
    bodyTop: 0,
    contentScroll: 0,
    targetZoom: 0,
    focusX: 0,
    focusY: 0,
  };
  private readonly ownerForKey = (key: string): TileJobOwner | undefined =>
    this.ownerForKeyValue(key);
  private readonly paintInput: TileFramePaintInput = {
    widgets: this.visibleWidgets,
    count: 0,
    detailIsMinimap: false,
    hiddenBodyId: undefined,
  };
  private readonly metrics: FrameDrawMetrics = {
    tileMemoryBytes: 0,
    missingTile: false,
    visibleWidgetCount: 0,
    drawnTileCount: 0,
    drawnLabelTileCount: 0,
    drawnMinimapCount: 0,
    drawnFallbackTileCount: 0,
    drawnUnhighlightedTileCount: 0,
    lowestEpochDrawn: -1,
    lowestContentVersion: -1,
    timeToSharpMs: Number.NaN,
  };
  private readonly titleSourceFor: TileResidencyConfig["titleSourceFor"];
  private readonly labelSourceFor: TileResidencyConfig["labelSourceFor"];
  private readonly recordCapacity: number;
  private redrawCallback: (() => void) | undefined;
  private growthTimer: ReturnType<typeof setTimeout> | undefined;
  private growthTarget = 0;
  private growthScheduled = false;
  private readonly timeToSharpClock = new TimeToSharpClock();
  private hiddenBodyId: string | undefined;
  private minimapActive = false;
  private textWanted = false;
  private zoomGestureActive = false;
  private textPrefetchActive = false;
  private textPrefetchZoom = 0;
  private zoomFocusX = 0;
  private zoomFocusY = 0;
  private zoomOut = false;
  private priorityFileId: string | undefined;
  private lastTextReady = false;
  private visibleTextExact = false;
  private visibleMissingContent = false;
  private settledZoom = 1;
  private lastTimeToSharpMs: number | undefined;
  private reportTimeToSharp = false;
  private tileRequests = 0;
  private missingTiles = 0;
  private readonly growPool = (): void => {
    this.pool.grow(this.growthTarget);
    this.tilePass.ensureInstanceCapacity(
      this.pool.fullCapacity + TILE_CELL_LAYERS * TILE_CELLS_PER_LAYER,
    );
    this.growthScheduled = false;
    this.growthTimer = undefined;
    this.redrawCallback?.();
  };

  constructor(gl: WebGL2RenderingContext, config: TileResidencyConfig) {
    this.table = config.table;
    this.titleSourceFor = config.titleSourceFor;
    this.labelSourceFor = config.labelSourceFor;
    const { width, height, devicePixelRatio } = config.viewport;
    const capacity = Math.max(
      128,
      computeTilePoolCapacity(width, height, devicePixelRatio),
    );
    this.recordCapacity = capacity;
    this.pool = new TilePool(gl, capacity);
    this.tilePass = new TilePass(
      gl,
      this.pool,
      config.tableTexture,
      capacity + TILE_CELL_LAYERS * TILE_CELLS_PER_LAYER,
    );
    this.jobQueue = new TileJobQueue({
      pool: this.pool,
      metrics: config.metrics,
      rasterFont: `${String(config.font.size)}px ${config.font.family}`,
      ownerForKey: this.ownerForKey,
    });
    this.painter = new TileFramePainter({
      tilePass: this.tilePass,
      pool: this.pool,
      metrics: this.metrics,
    });
  }

  setFilePaths(paths: ReadonlyMap<string, string>): void {
    this.filePaths.clear();
    for (let index = this.registeredIds.length - 1; index >= 0; index -= 1) {
      const fileId = this.registeredIds[index];
      if (fileId && !paths.has(fileId)) this.removeWidget(fileId, index);
    }
    paths.forEach((path, fileId) => {
      this.filePaths.set(fileId, path);
      if (pathsContain(this.registeredIds, fileId)) return;
      this.registeredIds.push(fileId);
    });
  }

  isRegistered(fileId: string): boolean {
    return pathsContain(this.registeredIds, fileId);
  }

  setContentSource(fileId: string, source: TileContentSource): void {
    if (!this.isRegistered(fileId) || source.fileId !== fileId) return;
    let widget = this.widgets.get(fileId);
    if (!widget) {
      widget = new WidgetTiles(fileId, this.pool, this.recordCapacity, (key) =>
        this.keyOwners.delete(key),
      );
      this.widgets.set(fileId, widget);
    }
    widget.setContentSource(source);
  }

  setLabelSource(fileId: string, label: TileContentSource["label"]): void {
    this.widgets.get(fileId)?.setLabelSource(label);
  }

  setDetailLevel(detailIsMinimap: boolean, textWanted: boolean): void {
    if (!this.minimapActive && detailIsMinimap)
      this.timeToSharpClock.leftText();
    this.minimapActive = detailIsMinimap;
    this.textWanted = textWanted;
  }

  textReady(): boolean {
    return this.lastTextReady;
  }

  setGesturePhase(phase: GesturePhase): void {
    this.updateTextPrefetch(phase);
    const zoomStarted = phase.zoomGestureActive && !this.zoomGestureActive;
    if (zoomStarted) this.timeToSharpClock.zoomGestureStarted();
    this.zoomGestureActive = phase.zoomGestureActive;
    this.zoomFocusX = phase.zoomFocusX;
    this.zoomFocusY = phase.zoomFocusY;
    this.zoomOut = phase.zoomingOut;
    if (!phase.gestureEnded) return;
    this.zoomGestureActive = false;
    this.textPrefetchActive = false;
    if (!phase.endedGestureWasZoom) return;
    this.updateSettledZoom(phase.cameraScale);
    this.timeToSharpClock.zoomGestureEnded(
      !this.minimapActive,
      performance.now(),
    );
  }

  setPriorityFile(fileId: string | undefined): void {
    if (this.priorityFileId === fileId) return;
    this.priorityFileId = fileId;
  }

  private updateTextPrefetch(phase: GesturePhase): void {
    if (!phase.detailIsMinimap || !phase.zoomGestureActive || !phase.zoomingIn)
      return;
    this.textPrefetchActive = true;
    this.textPrefetchZoom = phase.textThresholdZoom;
  }

  rasterError(): string | undefined {
    return this.jobQueue.rasterError();
  }

  settled(): boolean {
    if (
      this.zoomGestureActive ||
      this.timeToSharpClock.running ||
      this.jobQueue.inFlightCount > 0 ||
      this.jobQueue.rasterError()
    )
      return false;
    return this.minimapActive || this.visibleTextExact;
  }

  onNeedsRedraw(callback: () => void): void {
    this.redrawCallback = callback;
    this.jobQueue.onResult(callback);
  }

  debugSnapshot(fileId?: string): TileDebugSnapshot {
    const selectedFileId = fileId ?? this.registeredIds[0];
    const widget = selectedFileId
      ? this.widgets.get(selectedFileId)
      : undefined;
    if (!widget)
      return { rasterScales: [], timeToSharpMs: this.lastTimeToSharpMs };
    const scales: number[] = [];
    for (
      let row = widget.visibleFirstRow;
      row <= widget.visibleLastRow;
      row += 1
    ) {
      for (
        let column = widget.visibleFirstColumn;
        column <= widget.visibleLastColumn;
        column += 1
      ) {
        const record = widget.findRecord(
          CONTENT_KIND,
          widget.requestedScale,
          column,
          row,
        );
        if (record >= 0 && widget.isRecordReady(record))
          scales.push(widget.recordRasterScale(record));
      }
    }
    return { rasterScales: scales, timeToSharpMs: this.lastTimeToSharpMs };
  }

  tileDemand(out: TileDemand): void {
    out.capacity = this.pool.fullCapacity;
    out.requested = this.tileRequests;
    out.pinned = this.pool.fullPinnedCount();
    out.inFlight = this.jobQueue.inFlightCount;
    out.posted = this.jobQueue.postedTotal;
    out.stale = this.jobQueue.staleTotal;
    out.uploadFailed = this.jobQueue.uploadFailedTotal;
    out.visibleExact = this.visibleTextExact;
    out.clockRunning = this.timeToSharpClock.running;
    out.gestureActive = this.zoomGestureActive;
    out.minimapActive = this.minimapActive;
  }

  // Compare the handed-back scroll because this stage runs before drain re-plans it.
  exitViewCovered(fileId: string, contentVersion: number): boolean {
    const widget = this.widgets.get(fileId);
    if (widget === undefined) return false;
    if (this.jobQueue.rasterError()) return true;
    return widget.exitViewCovered(
      contentVersion,
      this.table.contentScrollAt(widget.row),
    );
  }

  drainTiles(
    camera: CameraView,
    viewport: Viewport,
    bodyTop: number,
    deadline: number,
  ): number {
    const uploadedTiles = this.jobQueue.drainResults(this.ownerForKey);
    this.viewportInput.width = viewport.width;
    this.viewportInput.height = viewport.height;
    this.viewportInput.devicePixelRatio = viewport.devicePixelRatio;
    this.painter.setBodyTopCss(bodyTop);
    this.collectVisible(camera, this.viewportInput, bodyTop);
    this.planVisible(camera, this.viewportInput, bodyTop);
    this.unpinAll();
    this.jobQueue.beginFrame(deadline);
    this.pinVisible();
    this.requestVisible();
    this.checkPoolGrowth();
    return uploadedTiles;
  }

  buildFrameInstances(detailIsMinimap: boolean): FrameDrawMetrics {
    this.tilePass.beginFrame();
    resetFrameDrawMetrics(this.metrics);
    this.metrics.visibleWidgetCount = this.visibleWidgets.length;
    if (!this.jobQueue.rasterError()) {
      this.paintInput.count = this.visibleWidgets.length;
      this.paintInput.detailIsMinimap = detailIsMinimap;
      this.paintInput.hiddenBodyId = this.hiddenBodyId;
      this.painter.draw(this.paintInput);
    } else {
      this.tilePass.markTitleBoundary();
    }
    this.tilePass.endFrame();
    this.metrics.tileMemoryBytes = this.pool.memoryBytes;
    this.metrics.timeToSharpMs = this.reportTimeToSharp
      ? (this.lastTimeToSharpMs ?? Number.NaN)
      : Number.NaN;
    this.reportTimeToSharp = false;
    return this.metrics;
  }

  draw(context: TileDrawContext): void {
    this.tilePass.draw(context);
  }

  setHiddenBody(fileId: string | undefined): void {
    this.hiddenBodyId = fileId;
  }

  dispose(): void {
    if (this.growthTimer !== undefined) {
      clearTimeout(this.growthTimer);
      this.growthTimer = undefined;
      this.growthScheduled = false;
    }
    this.jobQueue.dispose();
  }

  private collectVisible(
    camera: CameraView,
    viewport: Viewport,
    bodyTop: number,
  ): void {
    this.visibleWidgets.length = 0;
    this.visibleMissingContent = false;
    for (const fileId of this.registeredIds) {
      const row = this.table.rowFor(fileId as WidgetId);
      if (row === undefined) continue;
      let widget = this.widgets.get(fileId);
      const frame = widget?.frame ?? this.missingFrame;
      if (!this.table.readFrame(row, frame)) continue;
      const input =
        widget?.windowInput ??
        (widget
          ? {
              camera,
              viewport,
              frame: widget.frame,
              bodyTop,
              contentScroll: this.table.contentScrollAt(row),
              targetZoom: 0,
              focusX: 0,
              focusY: 0,
            }
          : this.missingInput);
      this.rememberWindowInput(widget, input);
      input.camera = camera;
      input.viewport = viewport;
      input.frame = frame;
      input.bodyTop = bodyTop;
      input.contentScroll = this.table.contentScrollAt(row);
      const window = widget?.visibleWindow ?? this.missingWindow;
      if (!bodyViewWindow(input, window)) continue;
      if (!widget) {
        const path = this.filePaths.get(fileId);
        if (!path) {
          this.visibleMissingContent = true;
          continue;
        }
        widget = this.createWidget(fileId, path, frame);
        widget.windowInput = {
          camera,
          viewport,
          frame: widget.frame,
          bodyTop,
          contentScroll: this.table.contentScrollAt(row),
          targetZoom: 0,
          focusX: 0,
          focusY: 0,
        };
        this.widgets.set(fileId, widget);
      }
      widget.row = row;
      widget.visibleWindow.left = window.left;
      widget.visibleWindow.top = window.top;
      widget.visibleWindow.right = window.right;
      widget.visibleWindow.bottom = window.bottom;
      this.insertVisible(widget);
    }
  }

  private planVisible(
    camera: CameraView,
    viewport: Viewport,
    bodyTop: number,
  ): void {
    this.updateSettledZoom(camera.scale);
    let ready = !this.visibleMissingContent;
    let allVisibleExact = true;
    for (const widget of this.visibleWidgets) {
      const input = widget.prepareInput;
      input.camera = camera;
      input.viewport = viewport;
      input.bodyTop = bodyTop;
      input.contentScroll = this.table.contentScrollAt(widget.row);
      input.minimapActive = this.minimapActive;
      input.textWanted = this.textWanted;
      input.zoomGestureActive = this.zoomGestureActive;
      input.textPrefetchActive = this.textPrefetchActive;
      input.textPrefetchZoom = this.textPrefetchZoom;
      input.zoomFocusX = this.zoomFocusX;
      input.zoomFocusY = this.zoomFocusY;
      input.zoomOut = this.zoomOut;
      input.settledZoom = this.settledZoom;
      if (this.minimapActive && !this.zoomGestureActive)
        this.refreshLabelSource(widget);
      widget.prepare(input);
      if (!widget.contentSource || !widget.textReady) ready = false;
      if (widget.contentSource?.hasText) {
        if (!widget.exactVisibleReady) allVisibleExact = false;
      }
    }
    this.visibleTextExact = allVisibleExact;
    if (this.timeToSharpClock.running) {
      const timeToSharpMs = this.timeToSharpClock.check(
        this.visibleTextExact,
        performance.now(),
      );
      if (timeToSharpMs !== undefined) {
        this.lastTimeToSharpMs = timeToSharpMs;
        this.reportTimeToSharp = true;
      }
    }
    this.lastTextReady = ready;
  }

  private unpinAll(): void {
    for (const fileId of this.registeredIds) {
      const widget = this.widgets.get(fileId);
      if (widget) this.jobQueue.unpinRecords(widget);
    }
  }

  private pinVisible(): void {
    for (const widget of this.visibleWidgets) {
      this.jobQueue.pinDrawSet(widget);
    }
  }

  private requestVisible(): void {
    this.tileRequests = 0;
    this.missingTiles = 0;
    const priorityFileId = this.priorityFileId;
    if (priorityFileId !== undefined) {
      for (const widget of this.visibleWidgets) {
        if (widget.fileId !== priorityFileId) continue;
        this.requestWidget(widget);
        break;
      }
    }
    for (const widget of this.visibleWidgets) {
      if (widget.fileId === priorityFileId) continue;
      this.requestWidget(widget);
    }
  }

  private requestWidget(widget: WidgetTiles): void {
    if (!widget.contentSource) return;
    if (widget.requestLabel) {
      const record = widget.ensureRecord(
        LABEL_KIND,
        widget.requestedLabelScale,
        0,
        0,
      );
      this.registerRecord(widget, record);
      if (record >= 0) this.jobQueue.ensureTile(widget, record);
    }
    for (let header = 0; header < widget.requestHeaderCount; header += 1) {
      const record = widget.ensureRecord(
        HEADER_KIND,
        widget.requestedHeaderScale,
        widget.requestHeaderColumns[header] ?? 0,
        0,
      );
      this.registerRecord(widget, record);
      if (record >= 0) this.jobQueue.ensureTile(widget, record);
    }
    for (let request = 0; request < widget.requestCount; request += 1) {
      const record = widget.ensureRecord(
        CONTENT_KIND,
        widget.requestScales[request] ?? 1,
        widget.requestColumns[request] ?? 0,
        widget.requestRows[request] ?? 0,
      );
      this.registerRecord(widget, record);
      if (record >= 0) {
        this.jobQueue.ensureTile(widget, record);
        this.tileRequests += 1;
        if (!widget.isRecordReady(record)) this.missingTiles += 1;
      }
    }
  }

  private checkPoolGrowth(): void {
    if (this.missingTiles === 0 || this.growthScheduled) return;
    const need = this.pool.fullPinnedCount() + this.missingTiles;
    const target = tilePoolGrowthTarget(
      need,
      this.pool.fullCapacity,
      this.pool.columnCount,
      this.pool.maxFullSlots,
    );
    if (target <= this.pool.fullCapacity) return;
    this.growthTarget = target;
    this.growthScheduled = true;
    this.growthTimer = setTimeout(this.growPool, 0);
  }

  private registerRecord(widget: WidgetTiles, record: number): void {
    const key = record >= 0 ? widget.recordKey(record) : undefined;
    if (key) this.keyOwners.set(key, widget);
  }

  private insertVisible(widget: WidgetTiles): void {
    let position = this.visibleWidgets.length;
    this.visibleWidgets.push(widget);
    while (
      position > 0 &&
      this.table.depthAt(widget.row) <
        this.table.depthAt(this.visibleWidgets[position - 1]?.row ?? -1)
    ) {
      const previous = this.visibleWidgets[position - 1];
      if (!previous) break;
      this.visibleWidgets[position] = previous;
      position -= 1;
    }
    this.visibleWidgets[position] = widget;
  }

  private removeWidget(fileId: string, index: number): void {
    const widget = this.widgets.get(fileId);
    if (widget) {
      for (let record = 0; record < widget.recordCapacity; record += 1) {
        const key = widget.recordKey(record);
        if (key) this.keyOwners.delete(key);
      }
      widget.release();
    }
    this.widgets.delete(fileId);
    this.registeredIds.splice(index, 1);
  }

  private ownerForKeyValue(key: string): TileJobOwner | undefined {
    return this.keyOwners.get(key);
  }

  private createWidget(fileId: string, path: string, frame: Rect): WidgetTiles {
    const widget = new WidgetTiles(
      fileId,
      this.pool,
      this.recordCapacity,
      (key) => this.keyOwners.delete(key),
    );
    widget.frame.x = frame.x;
    widget.frame.y = frame.y;
    widget.frame.width = frame.width;
    widget.frame.height = frame.height;
    widget.setContentSource(this.titleSourceFor(fileId, path));
    return widget;
  }

  private rememberWindowInput(
    widget: WidgetTiles | undefined,
    input: NonNullable<WidgetTiles["windowInput"]>,
  ): void {
    if (!widget || widget.windowInput) return;
    widget.windowInput = input;
  }

  private refreshLabelSource(widget: WidgetTiles): void {
    const source = widget.contentSource;
    if (!source || !widget.needsLabelLayout(this.settledZoom)) return;
    widget.setLabelSource(
      this.labelSourceFor(source.filePath, widget.frame, this.settledZoom),
    );
    widget.rememberLabelLayout(this.settledZoom);
  }

  private updateSettledZoom(cameraScale: number): void {
    if (this.zoomGestureActive || cameraScale === this.settledZoom) return;
    this.settledZoom = cameraScale;
  }
}

function pathsContain(paths: readonly string[], fileId: string): boolean {
  for (const path of paths) {
    if (path === fileId) return true;
  }
  return false;
}
