import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import { createTextMetrics } from "../../src/rendering/text/text-metrics";
import {
  BODY_HEIGHT,
  HEADER_HEIGHT,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  WIDGET_WIDTH,
  droppedFrameCount,
  expectedSceneCounts,
  median,
  percentile,
} from "./pure";
import {
  DPR,
  MAIN_TILE_BUDGET_MS,
  TEXT_THRESHOLD_DEVICE_PX,
  TILE_DEVICE_SIZE,
  TILE_MEMORY_BUDGET,
  clampScroll,
  createWidgets,
  rawFiles,
  required,
  scrollOffsetFor,
  type RendererName,
  type RuntimeMetrics,
  type SpikeApi,
  type Widget,
} from "./model";
import { AtlasRenderer } from "./atlas";
import { SceneGpu } from "./scene-gpu";
import { TileRenderer } from "./tiles";

function buildScene(): void {
  const canvas = required(
    document.querySelector<HTMLCanvasElement>("#scene"),
    "the scene canvas",
  );
  const ready = required(
    document.querySelector<HTMLElement>("#ready-state"),
    "the ready state",
  );
  const status = required(
    document.querySelector<HTMLElement>("#status"),
    "the status",
  );
  const params = new URLSearchParams(window.location.search);
  const requestedRenderer = params.get("renderer");
  if (
    requestedRenderer !== null &&
    requestedRenderer !== "atlas" &&
    requestedRenderer !== "tiles-main" &&
    requestedRenderer !== "tiles-worker"
  )
    throw new Error(`Unknown renderer ${requestedRenderer}`);
  const rendererName: RendererName = requestedRenderer ?? "atlas";
  const validationMode = params.get("validation") === "1";
  const timingMode = params.get("timing") === "1";
  const metrics = createTextMetrics(DEFAULT_CODE_FONT);
  const widgets = createWidgets(metrics);
  const gpu = new SceneGpu(canvas, {
    validation: validationMode,
    timing: timingMode,
  });
  const atlas =
    rendererName === "atlas"
      ? new AtlasRenderer(gpu, widgets, metrics)
      : undefined;
  const tiles =
    rendererName === "atlas"
      ? undefined
      : new TileRenderer(gpu, widgets, rendererName, metrics);
  let cameraX = 0;
  let cameraY = 0;
  let zoom = 1;
  let gestureActive = false;
  let cameraGestureActive = false;
  // GestureTargeting is simplified for this spike: instead of locking a
  // target for the gesture's lifetime (D8), every wheel event re-hit-tests
  // the pointer, which is equivalent for a scripted gesture that keeps the
  // pointer stationary (the scroll scenario's plan).
  let scrollOffsets = new Map<number, number>();
  let lastScrolledWidgetIndex: number | undefined;
  // Forces flat (no-text) rendering for the gap-check's reference capture:
  // same camera, same non-text pixels (rects, background), text withheld.
  let forceFlat = false;
  let frameCount = 0;
  let frameTimes: number[] = [];
  let drawnGlyphCount = 0;
  let firstFrameChecked = false;
  let detailLevel: "text" | "flat" = "flat";
  let flatDetailFrames = 0;
  let rafIntervals: number[] = [];
  let wheelHandlerTimes: number[] = [];
  let lastRafTime: number | undefined;
  let longAnimationFrameDurations: number[] = [];
  let longTaskDurations: number[] = [];
  let lastValidation = {
    expectedGlyphs: 0,
    actualGlyphs: 0,
    expectedTileArea: 0,
    actualTileArea: 0,
  };
  const observers: PerformanceObserver[] = [];
  if (timingMode && typeof PerformanceObserver !== "undefined") {
    for (const entryType of ["long-animation-frame", "longtask"] as const) {
      if (!PerformanceObserver.supportedEntryTypes.includes(entryType))
        continue;
      const observer = new PerformanceObserver((list) => {
        const durations = list.getEntries().map((entry) => entry.duration);
        if (entryType === "long-animation-frame")
          longAnimationFrameDurations.push(...durations);
        else longTaskDurations.push(...durations);
      });
      observer.observe({ type: entryType, buffered: true });
      observers.push(observer);
    }
  }

  const resetMetrics = (): void => {
    frameCount = 0;
    frameTimes = [];
    drawnGlyphCount = 0;
    detailLevel = "flat";
    flatDetailFrames = 0;
    rafIntervals = [];
    wheelHandlerTimes = [];
    lastRafTime = undefined;
    longAnimationFrameDurations = [];
    longTaskDurations = [];
    lastValidation = {
      expectedGlyphs: 0,
      actualGlyphs: 0,
      expectedTileArea: 0,
      actualTileArea: 0,
    };
    gpu.resetMetrics();
    tiles?.reset();
    atlas?.reset();
    scrollOffsets = new Map();
    lastScrolledWidgetIndex = undefined;
  };

  const widgetBodyAt = (
    screenX: number,
    screenY: number,
  ): Widget | undefined => {
    const worldX = cameraX + screenX / zoom;
    const worldY = cameraY + screenY / zoom;
    for (const widget of widgets) {
      const bodyTop = widget.y + HEADER_HEIGHT;
      const bodyBottom = bodyTop + BODY_HEIGHT;
      if (
        worldX >= widget.x &&
        worldX < widget.x + WIDGET_WIDTH &&
        worldY >= bodyTop &&
        worldY < bodyBottom
      )
        return widget;
    }
    return undefined;
  };

  const endGesture = (): void => {
    gestureActive = false;
    cameraGestureActive = false;
    tiles?.settleZoom(zoom);
  };

  canvas.addEventListener(
    "wheel",
    (event) => {
      const handlerStart = performance.now();
      event.preventDefault();
      if (event.ctrlKey) {
        zoom = Math.max(
          0.05,
          Math.min(4, zoom * Math.exp(-event.deltaY / 100)),
        );
        gestureActive = true;
        cameraGestureActive = true;
      } else {
        const target = widgetBodyAt(event.clientX, event.clientY);
        if (target) {
          const current = scrollOffsetFor(scrollOffsets, target.index);
          scrollOffsets.set(
            target.index,
            clampScroll(target, current + event.deltaY),
          );
          lastScrolledWidgetIndex = target.index;
          cameraGestureActive = true;
        } else {
          cameraX += event.deltaX;
          cameraY += event.deltaY;
          cameraGestureActive = true;
        }
      }
      wheelHandlerTimes.push(performance.now() - handlerStart);
    },
    { passive: false },
  );

  const visibleWidgets = (): Widget[] =>
    widgets.filter((widget) => {
      const left = (widget.x - cameraX) * zoom;
      const top = (widget.y - cameraY) * zoom;
      return (
        left < VIEW_WIDTH &&
        top < VIEW_HEIGHT &&
        left + WIDGET_WIDTH * zoom > 0 &&
        top + (BODY_HEIGHT + HEADER_HEIGHT) * zoom > 0
      );
    });

  const draw = (): void => {
    const start = performance.now();
    if (lastRafTime !== undefined) rafIntervals.push(start - lastRafTime);
    lastRafTime = start;
    const visible = visibleWidgets();
    const rects = visible.map((widget) => ({
      x: widget.x,
      y: widget.y,
      width: WIDGET_WIDTH,
      height: HEADER_HEIGHT + BODY_HEIGHT,
      color: [0.12, 0.15, 0.2] as const,
    }));
    gpu.begin(cameraX, cameraY, zoom);
    gpu.drawRects(rects);
    const textDetail =
      !forceFlat &&
      zoom * DEFAULT_CODE_FONT.lineHeight * DPR >= TEXT_THRESHOLD_DEVICE_PX;
    detailLevel = textDetail ? "text" : "flat";
    if (textDetail) {
      if (atlas)
        drawnGlyphCount = atlas.draw(
          visible,
          cameraX,
          cameraY,
          zoom,
          gestureActive,
          scrollOffsets,
        );
      if (tiles) {
        const visibleTiles = tiles.visibleTiles(
          cameraX,
          cameraY,
          zoom,
          gestureActive,
          scrollOffsets,
        );
        tiles.prepare(
          visibleTiles,
          MAIN_TILE_BUDGET_MS,
          gestureActive,
          cameraGestureActive,
        );
        drawnGlyphCount = tiles.draw(visibleTiles, cameraX, cameraY, zoom);
      }
    } else {
      drawnGlyphCount = 0;
      flatDetailFrames += 1;
    }
    gpu.endFrame();
    const expected = expectedSceneCounts(
      widgets,
      cameraX,
      cameraY,
      zoom,
      scrollOffsets,
    );
    lastValidation = {
      expectedGlyphs: expected.glyphs,
      actualGlyphs: drawnGlyphCount,
      expectedTileArea: expected.tileArea,
      actualTileArea: tiles?.metrics().coveredTileArea ?? expected.tileArea,
    };
    frameCount += 1;
    if (!firstFrameChecked) {
      gpu.assertFirstFrameClean();
      firstFrameChecked = true;
    }
    frameTimes.push(performance.now() - start);
    status.textContent = `${rendererName} · zoom ${zoom.toFixed(3)} · widgets ${String(visible.length)} · glyphs ${String(drawnGlyphCount)}`;
    requestAnimationFrame(draw);
  };

  const getMetrics = (): RuntimeMetrics => {
    const tileMetrics = tiles?.metrics();
    const atlasMetrics = atlas?.metrics();
    return {
      renderer: rendererName,
      frameCount,
      jsFrameP50Ms: percentile(frameTimes, 0.5),
      jsFrameP99Ms: percentile(frameTimes, 0.99),
      rafIntervalP50Ms: percentile(rafIntervals, 0.5),
      rafIntervalP99Ms: percentile(rafIntervals, 0.99),
      rafDroppedFrames: droppedFrameCount(rafIntervals),
      wheelHandlerP99Ms: percentile(wheelHandlerTimes, 0.99),
      longAnimationFrameCount: longAnimationFrameDurations.length,
      longAnimationFrameP99Ms: percentile(longAnimationFrameDurations, 0.99),
      longTaskCount: longTaskDurations.length,
      longTaskP99Ms: percentile(longTaskDurations, 0.99),
      gpuMsMedian: gpu.hasGpuTimer()
        ? median(gpu.getGpuTimes())
        : "not available",
      gpuMsP99: gpu.hasGpuTimer()
        ? percentile(gpu.getGpuTimes(), 0.99)
        : "not available",
      gpuTimerAvailable: gpu.hasGpuTimer(),
      detailLevel,
      flatDetailFrames,
      droppedTileFrames: tileMetrics?.emptyTileFrames ?? 0,
      tilesRasterized: tileMetrics?.tilesRasterized ?? 0,
      tilesUploaded: tileMetrics?.tilesUploaded ?? 0,
      residentTileGlyphs: tileMetrics?.residentTileGlyphs ?? 0,
      tilesRasterizedDuringGesture:
        tileMetrics?.tilesRasterizedDuringGesture ?? 0,
      rasterMsMedian: tileMetrics?.rasterMsMedian ?? 0,
      rasterMsP99: tileMetrics?.rasterMsP99 ?? 0,
      uploadMsMedian: tileMetrics?.uploadMsMedian ?? 0,
      imageBitmapTransferUploadMsMedian:
        tileMetrics?.imageBitmapTransferUploadMsMedian ?? 0,
      emptyTileFrames: tileMetrics?.emptyTileFrames ?? 0,
      timeToSharpMs: tileMetrics?.timeToSharpMs ?? "not measured",
      tileMemoryBytes: tileMetrics?.tileMemoryBytes ?? 0,
      coveredTileArea: tileMetrics?.coveredTileArea ?? 0,
      atlasSizeSwitches: atlasMetrics?.atlasSizeSwitches ?? 0,
      atlasBuilds: atlasMetrics?.atlasBuilds ?? 0,
      atlasTextureCreations: atlasMetrics?.atlasTextureCreations ?? 0,
      atlasInstanceBufferRebuilds:
        atlasMetrics?.atlasInstanceBufferRebuilds ?? 0,
      atlasInstanceBufferPartialUpdates:
        atlasMetrics?.atlasInstanceBufferPartialUpdates ?? 0,
      atlasGestureViolations: atlasMetrics?.atlasGestureViolations ?? 0,
      atlasBuildsDuringGesture: atlasMetrics?.atlasBuildsDuringGesture ?? 0,
      atlasTextureCreationsDuringGesture:
        atlasMetrics?.atlasTextureCreationsDuringGesture ?? 0,
      atlasInstanceBufferRebuildsDuringGesture:
        atlasMetrics?.atlasInstanceBufferRebuildsDuringGesture ?? 0,
      atlasPreparationFramesDuringGesture:
        atlasMetrics?.atlasPreparationFramesDuringGesture ?? 0,
      atlasPreparationMsMedian: atlasMetrics?.atlasPreparationMsMedian ?? 0,
      atlasPreparationMsP99: atlasMetrics?.atlasPreparationMsP99 ?? 0,
      atlasPreparationCreateMsMax:
        atlasMetrics?.atlasPreparationCreateMsMax ?? 0,
      atlasPreparationFrames: atlasMetrics?.atlasPreparationFrames ?? 0,
      atlasBuildMs: atlasMetrics?.atlasBuildMs ?? 0,
      atlasMemoryBytes: atlasMetrics?.atlasMemoryBytes ?? 0,
      atlasWidgetBuildMsMedian: atlasMetrics?.atlasWidgetBuildMsMedian ?? 0,
      atlasWidgetBuildMsP99: atlasMetrics?.atlasWidgetBuildMsP99 ?? 0,
      atlasWidgetBuildMsMax: atlasMetrics?.atlasWidgetBuildMsMax ?? 0,
      atlasUploadMsMedian: atlasMetrics?.atlasUploadMsMedian ?? 0,
      atlasUploadMsP99: atlasMetrics?.atlasUploadMsP99 ?? 0,
      atlasMissingTextFrames: atlasMetrics?.atlasMissingTextFrames ?? 0,
      atlasInstanceBytes: atlasMetrics?.atlasInstanceBytes ?? 0,
      atlasDrawCallCount: atlasMetrics?.atlasDrawCallCount ?? 0,
      atlasWindowRebuilds: atlasMetrics?.atlasWindowRebuilds ?? 0,
      atlasWindowBuildMsP99: atlasMetrics?.atlasWindowBuildMsP99 ?? 0,
      drawnGlyphCount,
    };
  };

  const getSceneCheck = (): { readonly drawnGlyphs: number } => ({
    drawnGlyphs: drawnGlyphCount,
  });

  const getValidation = (): ReturnType<SpikeApi["getValidation"]> => ({
    ...lastValidation,
    ...gpu.getValidation(),
  });

  window.__spikeH2 = {
    getState: () => ({
      ready: true,
      renderer: rendererName,
      widgetCount: widgets.length,
      datasetAvailable: Object.keys(rawFiles).length > 0,
      devicePixelRatio: DPR,
      tileDeviceSize: TILE_DEVICE_SIZE,
      tileMemoryBudget: TILE_MEMORY_BUDGET,
      textThresholdDevicePx: TEXT_THRESHOLD_DEVICE_PX,
      cameraX,
      cameraY,
      zoom,
      scrollWidgetIndex: lastScrolledWidgetIndex ?? null,
      scrollOffset:
        lastScrolledWidgetIndex === undefined
          ? 0
          : scrollOffsetFor(scrollOffsets, lastScrolledWidgetIndex),
    }),
    resetMetrics,
    setCamera: (nextX, nextY, nextZoom) => {
      cameraX = nextX;
      cameraY = nextY;
      zoom = nextZoom;
      gestureActive = false;
      endGesture();
    },
    getMetrics,
    getSceneCheck,
    getValidation,
    disableValidationLint: () => {
      gpu.disableValidationLint();
    },
    endGesture,
    setForceFlat: (value: boolean) => {
      forceFlat = value;
    },
  };
  ready.textContent = `ready: ${rendererName}`;
  requestAnimationFrame(draw);
}

async function loadValidationLint(): Promise<void> {
  try {
    await import("webgl-lint");
  } catch {
    throw new Error("VALIDATION FAILED: could not load webgl-lint");
  }
}

const validationRequested =
  new URLSearchParams(window.location.search).get("validation") === "1";
if (validationRequested)
  void loadValidationLint().then(buildScene, (error: unknown) => {
    throw error;
  });
else buildScene();
