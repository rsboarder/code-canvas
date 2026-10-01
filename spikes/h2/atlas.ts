import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import { createTextMetrics } from "../../src/rendering/text/text-metrics";
import {
  computeClusterSet,
  createAtlasPreparation,
  createAtlasTexture,
  pickDiscreteRasterSize,
  type AtlasPreparation,
  type AtlasRecord,
  type RasterAtlas,
} from "../h/renderer";
import { median, percentile } from "./pure";
import {
  ATLAS_INSTANCE_BYTES,
  ATLAS_INSTANCE_FLOATS,
  COLOR_RGB,
  DPR,
  TEXT_THRESHOLD_DEVICE_PX,
  VISIBLE_LINE_COUNT,
  scrollOffsetFor,
  visibleLineRange,
  windowCoversRange,
  type H2Atlas,
  type ScrollOffsets,
  type Widget,
  type WidgetInstanceBuffer,
  type WidgetWindow,
} from "./model";
import {
  BODY_HEIGHT,
  HEADER_HEIGHT,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  WIDGET_WIDTH,
} from "./pure";
import { SceneGpu } from "./scene-gpu";

const BUILD_BUDGET_MS = 2;
// Widgets this far outside the viewport (world px) are pre-built before they
// scroll into view, so a visible widget is rarely the one hitting the queue
// cold. One widget+gap cell (WIDGET_WIDTH + GRID_GAP territory) in each
// direction covers the immediately adjacent row/column.
const MARGIN_PX = 800;
// Line window margin (D7/D6): one screen's worth of lines above and below
// the strictly visible range, same size as the visible range itself
// (VISIBLE_LINE_COUNT). A widget's instance buffer therefore holds at most
// ~3 screens' worth of lines regardless of the file's total length (now up
// to 2000 lines — model.ts no longer caps it at 80).
const WINDOW_MARGIN_LINES = VISIBLE_LINE_COUNT;

function desiredWindow(
  widget: Widget,
  scrollOffsets: ScrollOffsets,
): WidgetWindow {
  const visible = visibleLineRange(widget, scrollOffsets);
  return {
    firstLine: Math.max(0, visible.firstLine - WINDOW_MARGIN_LINES),
    lastLine: Math.min(
      widget.cells.length,
      visible.lastLine + WINDOW_MARGIN_LINES,
    ),
  };
}

function rasterSizeForZoom(zoom: number): number {
  return pickDiscreteRasterSize(DEFAULT_CODE_FONT.size * zoom);
}

// Per atlas-slot geometry (local glyph offset + quad size, in CSS px) and UV
// rect, in the same slot order as `clusters` — the slot table the instanced
// vertex shader indexes via texelFetch (D6: "a slot table in a
// uniform/data texture"). Replicates the per-glyph math the old non-instanced
// path computed on the CPU per vertex, computed once per atlas instead.
// Row 0 (first slotCount*4 floats) is geometry, row 1 is UV.
function buildSlotTableData(
  raster: RasterAtlas,
  clusters: readonly string[],
  scale: number,
): Float32Array {
  const slotCount = Math.max(1, clusters.length);
  const data = new Float32Array(slotCount * 2 * 4);
  clusters.forEach((cluster, index) => {
    const record: AtlasRecord | undefined = raster.records.get(cluster)?.[0];
    if (!record) return;
    const geomOffset = index * 4;
    data[geomOffset] = -(record.padding * scale) / DPR;
    data[geomOffset + 1] = -((record.padding + record.baseline) * scale) / DPR;
    data[geomOffset + 2] = (record.drawWidth * scale) / DPR;
    data[geomOffset + 3] = (record.drawHeight * scale) / DPR;
    const uvOffset = slotCount * 4 + index * 4;
    data[uvOffset] = record.uvX / raster.width;
    data[uvOffset + 1] = record.uvY / raster.height;
    data[uvOffset + 2] = (record.uvX + record.uvWidth) / raster.width;
    data[uvOffset + 3] = (record.uvY + record.uvHeight) / raster.height;
  });
  return data;
}

function createAtlasFromRaster(
  gpu: SceneGpu,
  raster: RasterAtlas,
  clusters: readonly string[],
  scale: number,
): H2Atlas {
  const uploadStart = performance.now();
  const texture = createAtlasTexture(gpu.gl, raster, "straight");
  const slotCount = Math.max(1, clusters.length);
  const slotTexture = gpu.createAtlasSlotTexture(
    buildSlotTableData(raster, clusters, scale),
    slotCount,
  );
  const uploadMs = performance.now() - uploadStart;
  return {
    ...raster,
    texture,
    slotTexture,
    slotCount,
    uploadMs,
    buildMs: raster.rasterMs + uploadMs,
  };
}

export class AtlasRenderer {
  private readonly atlases = new Map<number, H2Atlas>();
  // Flat, independent of raster size: the clusters array (and therefore
  // every widget's atlasSlot) is shared across every raster size's atlas, so
  // a widget's instance buffer never needs rebuilding when the active raster
  // size changes — only prepareAtlas's own slot table/texture do. Each entry
  // is the widget's currently drawable line window (D7); it may lag behind
  // the widget's current scroll offset while a rebuild is in flight — the
  // old window keeps being drawn until the new one swaps in.
  private readonly activeWindows = new Map<number, WidgetInstanceBuffer>();
  private readonly preparations = new Map<number, AtlasPreparation>();
  private readonly preparationTimes: number[] = [];
  private readonly preparationCreateTimes: number[] = [];
  // The unique glyph-cluster set depends only on widget text content, not
  // raster size: computed once here instead of inside every
  // createAtlasPreparation call (one per raster size switch), which was the
  // ~60 ms-per-call cost behind the atlas's remaining long frames.
  private readonly clusters: readonly string[];
  private readonly clusterIndex: ReadonlyMap<string, number>;
  private buildQueue: Widget[] = [];
  private readonly queued = new Set<number>();
  private readonly widgetBuildTimes: number[] = [];
  private readonly uploadTimes: number[] = [];
  private readonly windowRebuildTimes: number[] = [];
  private windowRebuilds = 0;
  private missingTextFrames = 0;
  private visibleGlyphCount = 0;
  private drawCallCount = 0;
  private activeSize = rasterSizeForZoom(1);
  private switches = 0;
  private builds = 0;
  private textureCreations = 0;
  private instanceBufferRebuilds = 0;
  private instanceBufferPartialUpdates = 0;
  private gestureViolations = 0;
  private buildsDuringGesture = 0;
  private textureCreationsDuringGesture = 0;
  private instanceBufferRebuildsDuringGesture = 0;
  private preparationFramesDuringGesture = 0;
  private preparationFrames = 0;
  private buildMs = 0;
  private memoryBytes = 0;

  constructor(
    private readonly gpu: SceneGpu,
    private readonly widgets: readonly Widget[],
    private readonly textMetrics: ReturnType<typeof createTextMetrics>,
  ) {
    this.clusters = computeClusterSet(widgets);
    this.clusterIndex = new Map(
      this.clusters.map((text, index) => [text, index]),
    );
  }

  reset(): void {
    for (const atlas of this.atlases.values()) {
      this.gpu.gl.deleteTexture(atlas.texture);
      this.gpu.gl.deleteTexture(atlas.slotTexture);
    }
    for (const entry of this.activeWindows.values())
      this.gpu.deleteAtlasWidgetBuffer(entry.buffer, entry.vao);
    this.atlases.clear();
    this.activeWindows.clear();
    this.preparations.clear();
    this.preparationTimes.length = 0;
    this.preparationCreateTimes.length = 0;
    this.activeSize = rasterSizeForZoom(1);
    this.switches = 0;
    this.builds = 0;
    this.textureCreations = 0;
    this.instanceBufferRebuilds = 0;
    this.instanceBufferPartialUpdates = 0;
    this.gestureViolations = 0;
    this.buildsDuringGesture = 0;
    this.textureCreationsDuringGesture = 0;
    this.instanceBufferRebuildsDuringGesture = 0;
    this.preparationFramesDuringGesture = 0;
    this.preparationFrames = 0;
    this.visibleGlyphCount = 0;
    this.drawCallCount = 0;
    this.buildMs = 0;
    this.memoryBytes = 0;
    this.buildQueue = [];
    this.queued.clear();
    this.widgetBuildTimes.length = 0;
    this.uploadTimes.length = 0;
    this.windowRebuildTimes.length = 0;
    this.windowRebuilds = 0;
    this.missingTextFrames = 0;
  }

  draw(
    widgets: readonly Widget[],
    cameraX: number,
    cameraY: number,
    zoom: number,
    gestureActive: boolean,
    scrollOffsets: ScrollOffsets = new Map(),
  ): number {
    const target = rasterSizeForZoom(zoom);
    if (zoom * DEFAULT_CODE_FONT.lineHeight * DPR < TEXT_THRESHOLD_DEVICE_PX)
      return 0;
    if (!this.atlases.has(this.activeSize)) {
      this.prepareAtlas(this.activeSize, 2, gestureActive);
      if (!this.atlases.has(this.activeSize)) return 0;
    }
    if (target !== this.activeSize) {
      this.prepareAtlas(target, 2, gestureActive);
      if (!gestureActive && this.atlases.has(target)) {
        this.activeSize = target;
        this.switches += 1;
      }
    }
    const atlas = this.atlases.get(this.activeSize);
    if (!atlas) return 0;
    // Pre-build widgets within a margin before they are visible; enqueue the
    // strictly visible ones first so a tight budget favours what's on screen.
    // "Needs" means either no window yet, or the current window no longer
    // covers the widget's strictly-visible lines (scrolled past its margin).
    this.enqueueNeedsWindow(widgets, scrollOffsets);
    this.enqueueNeedsWindow(
      this.widgetsWithMargin(cameraX, cameraY, zoom),
      scrollOffsets,
    );
    this.drainBuildQueue(BUILD_BUDGET_MS, gestureActive, scrollOffsets);

    this.gpu.beginAtlasInstancedDraw(
      cameraX,
      cameraY,
      zoom,
      DEFAULT_CODE_FONT.lineHeight,
      this.textMetrics.baseline,
      COLOR_RGB,
      atlas.slotTexture,
      atlas.texture,
    );
    let glyphCount = 0;
    let drawCalls = 0;
    let missingThisFrame = false;
    for (const widget of widgets) {
      const entry = this.activeWindows.get(widget.index);
      if (!entry) {
        missingThisFrame = true;
        continue;
      }
      const visible = visibleLineRange(widget, scrollOffsets);
      // The widget still draws its stale (old) window while a rebuild is in
      // flight (D8 "fast scrolling": draw the already-loaded window, missing
      // lines load in subsequent frames) — but that frame counts as missing
      // text, since the lines that should be visible now aren't built yet.
      if (!windowCoversRange(entry.window, visible)) missingThisFrame = true;
      if (entry.instanceCount > 0) {
        const clipTop = widget.y + HEADER_HEIGHT;
        this.gpu.drawAtlasWidget(
          entry.vao,
          entry.instanceCount,
          widget.x,
          clipTop,
          scrollOffsetFor(scrollOffsets, widget.index),
          [widget.x, clipTop, widget.x + WIDGET_WIDTH, clipTop + BODY_HEIGHT],
        );
        drawCalls += 1;
      }
      // Counted glyphs are only the ones within the strictly visible range
      // currently built (not the window's margin, and not visible lines a
      // stale window hasn't caught up to yet), matching what
      // expectedSceneCounts (pure.ts) expects and what the fragment shader's
      // clip actually leaves on screen.
      const countFrom = Math.max(entry.window.firstLine, visible.firstLine);
      const countTo = Math.min(entry.window.lastLine, visible.lastLine);
      for (let line = countFrom; line < countTo; line += 1)
        glyphCount += widget.cells[line]?.length ?? 0;
    }
    this.gpu.endAtlasInstancedDraw();
    if (missingThisFrame) this.missingTextFrames += 1;
    this.visibleGlyphCount = glyphCount;
    this.drawCallCount = drawCalls;
    return this.visibleGlyphCount;
  }

  private widgetsWithMargin(
    cameraX: number,
    cameraY: number,
    zoom: number,
  ): readonly Widget[] {
    const left = cameraX - MARGIN_PX;
    const top = cameraY - MARGIN_PX;
    const right = cameraX + VIEW_WIDTH / zoom + MARGIN_PX;
    const bottom = cameraY + VIEW_HEIGHT / zoom + MARGIN_PX;
    const result: Widget[] = [];
    for (const widget of this.widgets) {
      const widgetBottom = widget.y + HEADER_HEIGHT + BODY_HEIGHT;
      if (
        widget.x < right &&
        widget.x + WIDGET_WIDTH > left &&
        widget.y < bottom &&
        widgetBottom > top
      )
        result.push(widget);
    }
    return result;
  }

  private enqueueNeedsWindow(
    candidates: readonly Widget[],
    scrollOffsets: ScrollOffsets,
  ): void {
    for (const widget of candidates) {
      if (this.queued.has(widget.index)) continue;
      const active = this.activeWindows.get(widget.index);
      if (
        active &&
        windowCoversRange(
          active.window,
          visibleLineRange(widget, scrollOffsets),
        )
      )
        continue;
      this.queued.add(widget.index);
      this.buildQueue.push(widget);
    }
  }

  private drainBuildQueue(
    budgetMs: number,
    gestureActive: boolean,
    scrollOffsets: ScrollOffsets,
  ): void {
    const start = performance.now();
    while (this.buildQueue.length > 0 && performance.now() - start < budgetMs) {
      const widget = this.buildQueue.shift();
      if (!widget) break;
      this.queued.delete(widget.index);
      const previous = this.activeWindows.get(widget.index);
      const visible = visibleLineRange(widget, scrollOffsets);
      // Recomputed at build time, not enqueue time: scroll may have moved
      // further (or back) since this widget was queued a few frames ago.
      if (previous && windowCoversRange(previous.window, visible)) continue;
      const window = desiredWindow(widget, scrollOffsets);
      const buildStart = performance.now();
      const staged = this.buildWidgetInstances(widget, window);
      const buildMs = performance.now() - buildStart;
      this.widgetBuildTimes.push(buildMs);
      const { buffer, vao, uploadMs } = this.gpu.createAtlasWidgetBuffer(
        staged.data,
      );
      this.uploadTimes.push(uploadMs);
      if (previous) {
        // The old window keeps being drawn by every frame in between (D8
        // "fast scrolling"); only now, once the replacement is ready, is it
        // freed and swapped out.
        this.gpu.deleteAtlasWidgetBuffer(previous.buffer, previous.vao);
        this.windowRebuilds += 1;
        this.windowRebuildTimes.push(buildMs + uploadMs);
      }
      this.activeWindows.set(widget.index, {
        buffer,
        vao,
        instanceCount: staged.instanceCount,
        glyphCount: staged.glyphCount,
        window,
      });
      // atlasBuilds counts raster atlas builds (prepareAtlas, below);
      // atlasInstanceBufferPartialUpdates is the per-widget window build
      // count (first build and every rebuild), same role it had for the old
      // shared-buffer partial uploads.
      this.instanceBufferPartialUpdates += 1;
      if (gestureActive) {
        // A widget that just became buildable, or whose window needed to
        // move with its scroll, is an allowed (re)build under D7/D6; this is
        // not the forbidden case (atlasGestureViolations), which is a write
        // to an already-built, unchanged widget during a gesture.
        this.instanceBufferRebuildsDuringGesture += 1;
        this.buildsDuringGesture += 1;
      }
    }
  }

  private buildWidgetInstances(
    widget: Widget,
    window: WidgetWindow,
  ): {
    readonly data: Float32Array;
    readonly instanceCount: number;
    readonly glyphCount: number;
  } {
    let capacity = 0;
    for (
      let lineIndex = window.firstLine;
      lineIndex < window.lastLine;
      lineIndex += 1
    )
      capacity += widget.cells[lineIndex]?.length ?? 0;
    const data = new Float32Array(capacity * ATLAS_INSTANCE_FLOATS);
    let cursor = 0;
    let glyphCount = 0;
    for (
      let lineIndex = window.firstLine;
      lineIndex < window.lastLine;
      lineIndex += 1
    )
      for (const cell of widget.cells[lineIndex] ?? []) {
        const slot = this.clusterIndex.get(cell.text);
        if (slot === undefined) continue;
        data[cursor] = cell.x;
        data[cursor + 1] = lineIndex;
        data[cursor + 2] = slot;
        data[cursor + 3] = lineIndex % COLOR_RGB.length;
        cursor += ATLAS_INSTANCE_FLOATS;
        glyphCount += 1;
      }
    return {
      data: data.subarray(0, cursor),
      instanceCount: cursor / ATLAS_INSTANCE_FLOATS,
      glyphCount,
    };
  }

  metrics(): {
    readonly atlasSizeSwitches: number;
    readonly atlasBuilds: number;
    readonly atlasTextureCreations: number;
    readonly atlasInstanceBufferRebuilds: number;
    readonly atlasInstanceBufferPartialUpdates: number;
    readonly atlasGestureViolations: number;
    readonly atlasBuildsDuringGesture: number;
    readonly atlasTextureCreationsDuringGesture: number;
    readonly atlasInstanceBufferRebuildsDuringGesture: number;
    readonly atlasPreparationFramesDuringGesture: number;
    readonly atlasPreparationMsMedian: number;
    readonly atlasPreparationMsP99: number;
    readonly atlasPreparationCreateMsMax: number;
    readonly atlasPreparationFrames: number;
    readonly atlasBuildMs: number;
    readonly atlasMemoryBytes: number;
    readonly atlasWidgetBuildMsMedian: number;
    readonly atlasWidgetBuildMsP99: number;
    readonly atlasWidgetBuildMsMax: number;
    readonly atlasUploadMsMedian: number;
    readonly atlasUploadMsP99: number;
    readonly atlasMissingTextFrames: number;
    readonly atlasInstanceBytes: number;
    readonly atlasDrawCallCount: number;
    readonly atlasWindowRebuilds: number;
    readonly atlasWindowBuildMsP99: number;
  } {
    return {
      atlasSizeSwitches: this.switches,
      atlasBuilds: this.builds,
      atlasTextureCreations: this.textureCreations,
      atlasInstanceBufferRebuilds: this.instanceBufferRebuilds,
      atlasInstanceBufferPartialUpdates: this.instanceBufferPartialUpdates,
      atlasGestureViolations: this.gestureViolations,
      atlasBuildsDuringGesture: this.buildsDuringGesture,
      atlasTextureCreationsDuringGesture: this.textureCreationsDuringGesture,
      atlasInstanceBufferRebuildsDuringGesture:
        this.instanceBufferRebuildsDuringGesture,
      atlasPreparationFramesDuringGesture: this.preparationFramesDuringGesture,
      atlasPreparationMsMedian: median(this.preparationTimes),
      atlasPreparationMsP99: percentile(this.preparationTimes, 0.99),
      atlasPreparationCreateMsMax: percentile(this.preparationCreateTimes, 1),
      atlasPreparationFrames: this.preparationFrames,
      atlasBuildMs: this.buildMs,
      atlasMemoryBytes: this.memoryBytes,
      atlasWidgetBuildMsMedian: median(this.widgetBuildTimes),
      atlasWidgetBuildMsP99: percentile(this.widgetBuildTimes, 0.99),
      atlasWidgetBuildMsMax: percentile(this.widgetBuildTimes, 1),
      atlasUploadMsMedian: median(this.uploadTimes),
      atlasUploadMsP99: percentile(this.uploadTimes, 0.99),
      atlasMissingTextFrames: this.missingTextFrames,
      atlasInstanceBytes: ATLAS_INSTANCE_BYTES,
      atlasDrawCallCount: this.drawCallCount,
      atlasWindowRebuilds: this.windowRebuilds,
      atlasWindowBuildMsP99: percentile(this.windowRebuildTimes, 0.99),
    };
  }

  private prepareAtlas(
    size: number,
    budgetMs: number,
    gestureActive = false,
  ): boolean {
    if (this.atlases.has(size)) return true;
    let preparation = this.preparations.get(size);
    if (!preparation) {
      // The canvas allocation/getContext/font setup inside
      // createAtlasPreparation is also measured: it previously wasn't part
      // of atlasPreparationMs at all, hiding real preparation cost.
      const createStart = performance.now();
      preparation = createAtlasPreparation(
        this.widgets,
        this.textMetrics,
        size / DEFAULT_CODE_FONT.size,
        "discrete",
        DPR,
        "straight",
        size,
        this.clusters,
      );
      const createMs = performance.now() - createStart;
      this.preparationCreateTimes.push(createMs);
      this.preparationTimes.push(createMs);
      this.preparations.set(size, preparation);
    }
    const start = performance.now();
    const complete = preparation.step(budgetMs);
    this.preparationFrames += 1;
    if (gestureActive) this.preparationFramesDuringGesture += 1;
    this.preparationTimes.push(performance.now() - start);
    // Finishing creates the GL texture (D6: never re-create or clear the
    // in-use atlas during a gesture). Stepping may complete mid-gesture, but
    // the texture creation itself is deferred until the gesture ends; until
    // then the bounded slices above are the only gesture-time work.
    if (!complete || gestureActive) return false;
    const scale = DEFAULT_CODE_FONT.size / size;
    const atlas = createAtlasFromRaster(
      this.gpu,
      preparation.finish(),
      this.clusters,
      scale,
    );
    this.preparations.delete(size);
    this.atlases.set(size, atlas);
    this.textureCreations += 1;
    this.buildMs += atlas.buildMs;
    this.memoryBytes += atlas.memoryBytes;
    return true;
  }
}
