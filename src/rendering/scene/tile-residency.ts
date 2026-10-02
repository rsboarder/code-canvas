import type { Camera } from "../../board/index";
import type { Rect } from "../../shared/geometry/geometry";
import type { CodeTextMetrics } from "../text/text-metrics";
import { RasterWorkerPool } from "../text/raster-worker-pool";
import type { RasterCellInput } from "../text/raster-job";
import { encodeRasterCells } from "../text/raster-job";
import { TilePass, type TileDrawContext } from "../passes/tile-pass";
import type { Viewport } from "../viewport";
import {
  resetFrameDrawMetrics,
  type FrameDrawMetrics,
} from "./frame-draw-metrics";
import { TilePool } from "./tile-pool";
import { TileFramePainter } from "./tile-frame-painter";
import { computeTilePoolCapacity, tileContentSize } from "./tile-plan";
import {
  previousPowerOfTwo,
  TileSetPlanner,
  viewBoundsAtZoom,
  type TileSetRecordArrays,
} from "./tile-sets";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  TileRecords,
} from "./tile-records";
const MAX_JOBS_PER_FRAME = 4;

export interface TileContentSource {
  readonly filePath: string;
  readonly contentVersion: number;
  readonly highlighted: boolean;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly palette: readonly string[];
  readonly baseline: number;
  readonly lineHeight: number;
  readonly backgroundColor: string;
  cellsFor(column: number, row: number, rasterScale: number): RasterCellInput[];
  headerCellsFor(column: number, rasterScale: number): RasterCellInput[];
  readonly label: TileLabelContentSource;
}
export interface TileLabelContentSource {
  readonly identity: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  jobFor(rasterScale: number): {
    readonly cells: readonly RasterCellInput[];
    readonly font: string;
    readonly baseline: number;
    readonly lineHeight: number;
    readonly originY: number;
    readonly backgroundColor: string;
    readonly palette: readonly string[];
    readonly outlineColor: string;
    readonly outlineWidth: number;
  };
}
export interface TileDebugSnapshot {
  readonly rasterScales: readonly number[];
  readonly timeToSharpMs: number | undefined;
}
interface TileResidencyConfig {
  readonly metrics: Pick<CodeTextMetrics, "narrowAdvance">;
  readonly font: { readonly family: string; readonly size: number };
  readonly viewport: Viewport;
}
interface VisibleWindow {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export class TileResidency {
  readonly pool: TilePool;

  private readonly tilePass: TilePass;

  private readonly workerPool: RasterWorkerPool;

  private readonly tileRecords: TileRecords;

  private get records(): TileSetRecordArrays {
    return this.tileRecords.records;
  }

  private get keys(): (string | undefined)[] {
    return this.tileRecords.keys;
  }

  private get requestedContentVersion(): Int32Array {
    return this.tileRecords.requestedContentVersion;
  }

  private get pending(): Uint8Array {
    return this.tileRecords.pending;
  }

  private readonly planner: TileSetPlanner;

  private readonly painter: TileFramePainter;

  private readonly rasterFont: string;

  private readonly rasterJob = {
    tileKey: "",
    contentVersion: 0,
    rasterScale: 1,
    backgroundColor: "",
    palette: [] as readonly string[],
    font: "",
    baseline: 0,
    lineHeight: 0,
    originY: 0,
    outlineColor: "",
    outlineWidth: 0,
    cells: encodeRasterCells([]),
  };

  private readonly visibleWindow: VisibleWindow = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };

  private readonly prefetchWindow: VisibleWindow = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  };

  private readonly metrics: FrameDrawMetrics = {
    tileMemoryBytes: 0,
    missingTile: false,
    drawnTileCount: 0,
    drawnLabelTileCount: 0,
    drawnFallbackTileCount: 0,
    drawnUnhighlightedTileCount: 0,
    lowestEpochDrawn: -1,
    lowestContentVersion: -1,
    timeToSharpMs: Number.NaN,
  };

  private contentSource: TileContentSource | undefined;

  private lastBodyTopCss = 0;

  private settledZoom = 1;

  private zoomGestureActive = false;

  private epoch = 0;

  private replacementStartedAt: number | undefined;

  private pendingTimeToSharp: number | undefined;

  private lastTimeToSharpMs: number | undefined;

  private zoomFocusX = 0;

  private zoomFocusY = 0;

  private zoomOut = false;

  private minimapActive = false;

  private textWanted = false;

  private textPrefetchActive = false;

  private textPrefetchZoom = 0;

  private lastTextReady = false;

  constructor(gl: WebGL2RenderingContext, config: TileResidencyConfig) {
    this.rasterFont = `${String(config.font.size)}px ${config.font.family}`;
    const { width, height, devicePixelRatio } = config.viewport;
    const capacity = Math.max(
      8,
      computeTilePoolCapacity(width, height, devicePixelRatio),
    );
    const recordCapacity = capacity * 2;
    this.pool = new TilePool(gl, capacity);
    this.tilePass = new TilePass(gl, this.pool, capacity);
    this.workerPool = new RasterWorkerPool(config.metrics);
    this.tileRecords = new TileRecords(this.pool, recordCapacity);
    this.planner = new TileSetPlanner(this.tileRecords.records, recordCapacity);
    this.painter = new TileFramePainter({
      tilePass: this.tilePass,
      pool: this.pool,
      tileRecords: this.tileRecords,
      planner: this.planner,
      metrics: this.metrics,
    });
  }

  setContentSource(source: TileContentSource): void {
    this.contentSource = source;
    this.epoch += 1;
    this.tileRecords.setContentSource(source, this.epoch);
    this.lastTextReady = false;
  }

  setLabelSource(label: TileLabelContentSource): void {
    const source = this.contentSource;
    if (!source) return;
    this.contentSource = { ...source, label };
    this.tileRecords.setLabelSource({
      identity: label.identity,
      x: label.x,
      y: label.y,
      width: label.width,
      height: label.height,
    });
  }

  setDetailLevel(detailIsMinimap: boolean, textWanted: boolean): void {
    this.minimapActive = detailIsMinimap;
    this.textWanted = textWanted;
  }

  beginTextPrefetch(thresholdZoom: number): void {
    this.textPrefetchActive = true;
    this.textPrefetchZoom = thresholdZoom;
  }

  textReady(): boolean {
    return this.lastTextReady;
  }

  setZoomGestureActive(active: boolean): void {
    this.zoomGestureActive = active;
  }

  setZoomFocus(x: number, y: number, zoomOut: boolean): void {
    this.zoomFocusX = x;
    this.zoomFocusY = y;
    this.zoomOut = zoomOut;
  }

  notifyGestureEnded(wasZoom: boolean, cameraScale: number): void {
    this.zoomGestureActive = false;
    this.textPrefetchActive = false;
    if (!wasZoom || cameraScale === this.settledZoom) return;
    this.settledZoom = cameraScale;
    this.replacementStartedAt = performance.now();
  }

  rasterError(): string | undefined {
    return this.workerPool.rasterError();
  }

  onNeedsRedraw(callback: () => void): void {
    this.workerPool.onResult(callback);
  }

  debugSnapshot(): TileDebugSnapshot {
    const rasterScales: number[] = [];
    for (
      let row = this.planner.visibleFirstRow;
      row <= this.planner.visibleLastRow;
      row += 1
    ) {
      for (
        let column = this.planner.visibleFirstColumn;
        column <= this.planner.visibleLastColumn;
        column += 1
      ) {
        const record = this.tileRecords.findRecord(
          CONTENT_KIND,
          this.planner.requestedScale,
          column,
          row,
        );
        if (record >= 0 && this.records.ready[record]) {
          rasterScales.push(this.records.rasterScale[record] ?? 0);
        }
      }
    }
    return { rasterScales, timeToSharpMs: this.lastTimeToSharpMs };
  }

  tilesCurrentFor(contentVersion: number): boolean {
    if (this.contentSource?.contentVersion !== contentVersion) return false;
    if (this.workerPool.rasterError()) return true;
    return (
      !this.zoomGestureActive &&
      this.planner.requestedScale === this.planner.atRestScale &&
      this.planner.exactVisibleReady()
    );
  }

  drainTiles(
    camera: Camera,
    viewportCss: Viewport,
    widgetFrame: Rect,
    bodyTopCss: number,
  ): number {
    const uploadedTiles = this.drainWorkerResults();
    this.lastBodyTopCss = bodyTopCss;
    this.painter.setBodyTopCss(bodyTopCss);
    const source = this.contentSource;
    if (!source || this.workerPool.rasterError()) return uploadedTiles;
    if (
      !this.writeVisibleContentWindow(
        camera,
        viewportCss,
        widgetFrame,
        bodyTopCss,
      )
    ) {
      this.resetEmptyPlan(camera, viewportCss);
      return uploadedTiles;
    }
    this.preparePlanner(source, camera, viewportCss);
    this.setPrefetchPlan(camera, viewportCss, widgetFrame, bodyTopCss);
    this.planner.setEpoch(this.epoch);
    this.planner.build(this.records.active.length);
    this.lastTextReady = this.planner.textReady();
    this.pinDrawSet();
    this.ensureResidency();
    this.checkSettleComplete();
    return uploadedTiles;
  }

  private resetEmptyPlan(camera: Camera, viewportCss: Viewport): void {
    this.planner.setContentSize(0, 0);
    this.planner.setHeaderHeight(this.lastBodyTopCss);
    this.tileRecords.setHeaderHeight(this.lastBodyTopCss);
    this.planner.setVisibleBounds(0, 0, 0, 0);
    this.planner.setZoom(camera.scale, viewportCss.devicePixelRatio, false);
    this.planner.setAtRestScale(camera.scale * viewportCss.devicePixelRatio);
    this.planner.setPrefetchActive(false);
    this.planner.setPrefetchRasterScale(0);
    this.planner.setMinimapActive(this.minimapActive);
    this.planner.setTextWanted(this.textWanted);
    this.planner.setEpoch(this.epoch);
    this.planner.build(this.records.active.length);
    this.lastTextReady = this.planner.textReady();
  }

  private preparePlanner(
    source: TileContentSource,
    camera: Camera,
    viewportCss: Viewport,
  ): void {
    const atRestScale = this.settledZoom * viewportCss.devicePixelRatio;
    if (!this.zoomGestureActive && camera.scale !== this.settledZoom) {
      this.settledZoom = camera.scale;
      this.replacementStartedAt = performance.now();
    }
    const zoom = this.zoomGestureActive ? camera.scale : this.settledZoom;
    this.planner.setContentSize(source.contentWidth, source.contentHeight);
    this.planner.setHeaderHeight(this.lastBodyTopCss);
    this.tileRecords.setHeaderHeight(this.lastBodyTopCss);
    this.planner.setVisibleBounds(
      this.visibleWindow.left,
      this.visibleWindow.top,
      this.visibleWindow.right,
      this.visibleWindow.bottom,
    );
    this.planner.setZoom(
      zoom,
      viewportCss.devicePixelRatio,
      this.zoomGestureActive,
    );
    this.planner.setAtRestScale(
      this.zoomGestureActive
        ? atRestScale
        : this.settledZoom * viewportCss.devicePixelRatio,
    );
    this.planner.setLabelIdentity(source.label.identity);
    this.planner.setMinimapActive(this.minimapActive);
    this.planner.setTextWanted(this.textWanted);
  }

  private setPrefetchPlan(
    camera: Camera,
    viewportCss: Viewport,
    widgetFrame: Rect,
    bodyTopCss: number,
  ): void {
    const textPrefetch =
      this.minimapActive &&
      this.zoomGestureActive &&
      this.textPrefetchActive &&
      this.textPrefetchZoom > 0;
    const zoomOutPrefetch =
      this.zoomGestureActive && this.zoomOut && !this.minimapActive;
    this.planner.setPrefetchRasterScale(
      textPrefetch ? this.textPrefetchZoom * viewportCss.devicePixelRatio : 0,
    );
    if (!textPrefetch && !zoomOutPrefetch) {
      this.planner.setPrefetchActive(false);
      return;
    }
    this.textPrefetchZoom = textPrefetch
      ? this.textPrefetchZoom
      : previousPowerOfTwo(camera.scale);
    this.writePrefetchWindow(camera, viewportCss, widgetFrame, bodyTopCss);
    this.planner.setPrefetchActive(true);
    this.planner.setPrefetchBounds(
      this.prefetchWindow.left,
      this.prefetchWindow.top,
      this.prefetchWindow.right,
      this.prefetchWindow.bottom,
    );
  }

  buildFrameInstances(detailIsMinimap: boolean): FrameDrawMetrics {
    this.tilePass.beginFrame();
    resetFrameDrawMetrics(this.metrics);
    if (!this.workerPool.rasterError()) {
      this.painter.draw(detailIsMinimap);
    } else {
      this.tilePass.markTitleBoundary();
    }
    this.tilePass.endFrame();
    this.metrics.tileMemoryBytes = this.pool.memoryBytes;
    this.metrics.missingTile = this.planner.missingTile;
    this.metrics.timeToSharpMs = this.pendingTimeToSharp ?? Number.NaN;
    this.pendingTimeToSharp = undefined;
    return this.metrics;
  }

  draw(context: TileDrawContext): void {
    this.tilePass.draw(context);
  }

  dispose(): void {
    this.workerPool.dispose();
  }

  private ensureResidency(): void {
    const source = this.contentSource;
    if (!source) return;
    let jobsPosted = 0;
    if (this.planner.requestLabel) {
      const record = this.ensureRecord(
        LABEL_KIND,
        this.planner.requestedLabelScale,
        0,
        0,
      );
      if (record >= 0) jobsPosted = this.ensureTile(record, jobsPosted);
    }
    for (let index = 0; index < this.planner.requestHeaderCount; index += 1) {
      const column = this.planner.requestHeaderColumns[index] ?? 0;
      const record = this.ensureRecord(
        HEADER_KIND,
        this.planner.requestedHeaderScale,
        column,
        0,
      );
      if (record >= 0) jobsPosted = this.ensureTile(record, jobsPosted);
    }
    for (let index = 0; index < this.planner.requestCount; index += 1) {
      const column = this.planner.requestColumns[index] ?? 0;
      const row = this.planner.requestRows[index] ?? 0;
      const rasterScale =
        this.planner.requestScales[index] ?? this.planner.requestedScale;
      const record = this.ensureRecord(CONTENT_KIND, rasterScale, column, row);
      if (record >= 0) jobsPosted = this.ensureTile(record, jobsPosted);
    }
  }

  private ensureRecord(
    kind: number,
    rasterScale: number,
    column: number,
    row: number,
  ): number {
    return this.tileRecords.ensureRecord(kind, rasterScale, column, row);
  }

  private ensureTile(record: number, jobsPosted: number): number {
    const key = this.keys[record];
    if (!key) return jobsPosted;
    this.pool.touch(key);
    if (this.records.ready[record] || this.pending[record]) return jobsPosted;
    if (jobsPosted >= MAX_JOBS_PER_FRAME) return jobsPosted;
    const acquired = this.pool.acquire(key, false);
    if (acquired.slot < 0) return jobsPosted;
    if (acquired.evictedKey) this.deactivateByKey(acquired.evictedKey);
    this.pending[record] = 1;
    const source = this.contentSource;
    if (!source) return jobsPosted;
    this.postJob(record, source);
    return jobsPosted + 1;
  }

  private postJob(record: number, source: TileContentSource): void {
    const kind = this.records.kind[record] ?? CONTENT_KIND;
    const column = this.records.column[record] ?? 0;
    const row = this.records.row[record] ?? 0;
    const rasterScale = this.records.rasterScale[record] ?? 1;
    const size = tileContentSize(rasterScale);
    const labelJob =
      kind === LABEL_KIND ? source.label.jobFor(rasterScale) : undefined;
    const cells =
      kind === HEADER_KIND
        ? source.headerCellsFor(column, rasterScale)
        : labelJob
          ? labelJob.cells
          : source.cellsFor(column, row, rasterScale);
    const key = this.keys[record];
    if (!key) return;
    this.requestedContentVersion[record] = source.contentVersion;
    this.rasterJob.tileKey = key;
    this.rasterJob.contentVersion = source.contentVersion;
    this.rasterJob.rasterScale = rasterScale;
    this.rasterJob.backgroundColor = source.backgroundColor;
    this.rasterJob.palette = source.palette;
    this.rasterJob.font = this.rasterFont;
    this.rasterJob.baseline = source.baseline;
    this.rasterJob.lineHeight = source.lineHeight;
    this.rasterJob.originY = kind === HEADER_KIND ? 0 : row * size;
    this.rasterJob.outlineColor = "";
    this.rasterJob.outlineWidth = 0;
    if (labelJob) {
      this.rasterJob.backgroundColor = labelJob.backgroundColor;
      this.rasterJob.palette = labelJob.palette;
      this.rasterJob.font = labelJob.font;
      this.rasterJob.baseline = labelJob.baseline;
      this.rasterJob.lineHeight = labelJob.lineHeight;
      this.rasterJob.originY = labelJob.originY;
      this.rasterJob.outlineColor = labelJob.outlineColor;
      this.rasterJob.outlineWidth = labelJob.outlineWidth;
    }
    this.rasterJob.cells = encodeRasterCells(cells);
    this.workerPool.post(this.rasterJob);
  }

  private pinDrawSet(): void {
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (!this.records.active[index]) continue;
      const key = this.keys[index];
      if (key) this.pool.setPinned(key, false);
    }
    this.pinRecords(this.planner.drawFallback, this.planner.drawFallbackCount);
    this.pinRecords(this.planner.drawCurrent, this.planner.drawCurrentCount);
    this.pinRecords(
      this.planner.drawHeaderFallback,
      this.planner.drawHeaderFallbackCount,
    );
    this.pinRecords(
      this.planner.drawHeaderCurrent,
      this.planner.drawHeaderCurrentCount,
    );
    this.pinRecords(
      this.planner.drawLabelFallback,
      this.planner.drawLabelFallbackCount,
    );
    this.pinRecords(
      this.planner.drawLabelCurrent,
      this.planner.drawLabelCurrentCount,
    );
    this.pinTextPrefetchRecords();
  }

  private pinTextPrefetchRecords(): void {
    if (
      !this.minimapActive ||
      !this.zoomGestureActive ||
      !this.textPrefetchActive
    )
      return;
    for (let index = 0; index < this.records.active.length; index += 1) {
      if (
        this.records.active[index] &&
        this.records.kind[index] === CONTENT_KIND &&
        this.records.epoch[index] === this.epoch &&
        this.records.rasterScale[index] === this.planner.prefetchScale()
      ) {
        const key = this.keys[index];
        if (key) this.pool.setPinned(key, true);
      }
    }
  }

  private pinRecords(records: Int32Array, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const record = records[index] ?? -1;
      const key = record >= 0 ? this.keys[record] : undefined;
      if (key) this.pool.setPinned(key, true);
    }
  }

  private drainWorkerResults(): number {
    let uploadedTiles = 0;
    const results = this.workerPool.drainResults();
    for (const result of results) {
      const record = this.tileRecords.findRecordByKey(result.tileKey);
      if (record < 0 || !this.isResultCurrent(record, result)) {
        result.bitmap.close();
        if (record >= 0) this.releaseRecord(record);
        continue;
      }
      const layer = this.pool.layerFor(result.tileKey);
      if (layer === undefined) {
        result.bitmap.close();
        this.releaseRecord(record);
        continue;
      }
      this.pool.upload(layer, result.bitmap);
      result.bitmap.close();
      this.pending[record] = 0;
      this.records.ready[record] = 1;
      uploadedTiles += 1;
    }
    return uploadedTiles;
  }

  private isResultCurrent(
    record: number,
    result: { readonly rasterScale: number; readonly contentVersion: number },
  ): boolean {
    return (
      (this.records.kind[record] !== CONTENT_KIND ||
        this.records.epoch[record] === this.epoch) &&
      this.records.rasterScale[record] === result.rasterScale &&
      (this.records.kind[record] !== CONTENT_KIND ||
        this.requestedContentVersion[record] === result.contentVersion) &&
      (this.records.kind[record] === HEADER_KIND
        ? this.isHeaderRequested(record)
        : this.records.kind[record] === LABEL_KIND
          ? this.planner.requestLabel &&
            this.records.rasterScale[record] ===
              this.planner.requestedLabelScale
          : this.planner.isRequested(
              result.rasterScale,
              this.records.column[record] ?? 0,
              this.records.row[record] ?? 0,
              this.records.epoch[record] ?? 0,
            ))
    );
  }

  private isHeaderRequested(record: number): boolean {
    if (this.records.rasterScale[record] !== this.planner.requestedHeaderScale)
      return false;
    const column = this.records.column[record] ?? 0;
    for (let index = 0; index < this.planner.requestHeaderCount; index += 1) {
      if (this.planner.requestHeaderColumns[index] === column) return true;
    }
    return false;
  }

  private checkSettleComplete(): void {
    if (this.replacementStartedAt === undefined) return;
    if (!this.planner.exactVisibleReady()) return;
    this.pendingTimeToSharp = performance.now() - this.replacementStartedAt;
    this.lastTimeToSharpMs = this.pendingTimeToSharp;
    this.replacementStartedAt = undefined;
  }

  private deactivateByKey(key: string): void {
    this.tileRecords.deactivateByKey(key);
  }

  private releaseRecord(record: number): void {
    this.tileRecords.releaseRecord(record);
  }

  private writePrefetchWindow(
    camera: Camera,
    viewportCss: Viewport,
    widgetFrame: Rect,
    bodyTopCss: number,
  ): void {
    const bounds = viewBoundsAtZoom({
      cameraOffsetX: camera.offsetX,
      cameraOffsetY: camera.offsetY,
      currentZoom: camera.scale,
      targetZoom: this.textPrefetchZoom,
      focusX: this.zoomFocusX,
      focusY: this.zoomFocusY,
      viewportWidth: viewportCss.width,
      viewportHeight: viewportCss.height,
    });
    const bodyTop = widgetFrame.y + bodyTopCss;
    this.prefetchWindow.left = bounds.left - widgetFrame.x;
    this.prefetchWindow.top = bounds.top - bodyTop;
    this.prefetchWindow.right = bounds.right - widgetFrame.x;
    this.prefetchWindow.bottom = bounds.bottom - bodyTop;
  }
  private writeVisibleContentWindow(
    camera: Camera,
    viewportCss: Viewport,
    widgetFrame: Rect,
    bodyTopCss: number,
  ): boolean {
    const worldLeft = -camera.offsetX / camera.scale;
    const worldRight = (viewportCss.width - camera.offsetX) / camera.scale;
    const worldTop = -camera.offsetY / camera.scale;
    const worldBottom = (viewportCss.height - camera.offsetY) / camera.scale;
    const bodyTop = widgetFrame.y + bodyTopCss;
    const bodyBottom = widgetFrame.y + widgetFrame.height;
    if (
      worldRight <= widgetFrame.x ||
      worldLeft >= widgetFrame.x + widgetFrame.width ||
      worldBottom <= bodyTop ||
      worldTop >= bodyBottom
    )
      return false;
    this.visibleWindow.left = Math.max(0, worldLeft - widgetFrame.x);
    this.visibleWindow.right = Math.min(
      widgetFrame.width,
      worldRight - widgetFrame.x,
    );
    this.visibleWindow.top = Math.max(0, worldTop - bodyTop);
    this.visibleWindow.bottom = Math.min(
      widgetFrame.height - bodyTopCss,
      worldBottom - bodyTop,
    );
    return (
      this.visibleWindow.right > this.visibleWindow.left &&
      this.visibleWindow.bottom > this.visibleWindow.top
    );
  }
}
