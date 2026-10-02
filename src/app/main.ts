import { Camera, DetailLevel, panCamera, zoomCamera } from "../board/index";
import {
  DocumentResidency,
  LineLayout,
  type TokenizedLines,
} from "../code-view/index";
import { EditingTransition, type EditingSource } from "../editing/index";
import { createMonacoEditorHost } from "../editing/infrastructure/monaco-editor-host";
import { GestureInput } from "../interaction/input";
import { FrameStats } from "../performance/frame-stats";
import { FrameLog } from "./frame-log";
import {
  createTextMetrics,
  FrameLoop,
  WebGlRenderer,
  type CodeTextMetrics,
  type FrameStage,
  type TextMetricsProbe,
} from "../rendering/index";
import { DEFAULT_CODE_FONT } from "../shared/font";
import type { Rect } from "../shared/geometry/geometry";
import { WorkerTokenizer } from "../code-view/infrastructure/worker-tokenizer";
import { configureMonacoTextMate } from "../code-view/infrastructure/monaco-tokens";
import { themePalette } from "../code-view/infrastructure/theme";
import { openSourceFile } from "../workspace/infrastructure/directory-reader";

interface CodeCanvasTestHook {
  textMetrics(): TextMetricsProbe;
  tileDebug(): ReturnType<WebGlRenderer["debugSnapshot"]>;
  frameLog(): ReturnType<FrameLog["snapshot"]>;
  setCamera(x: number, y: number, scale: number): void;
}

declare global {
  interface Window {
    __codeCanvasTest?: CodeCanvasTestHook;
  }
}

const root = document.body;
root.style.background = "#0e121b";
root.style.color = "#d4d4d4";
root.style.fontFamily = "system-ui, sans-serif";
root.style.overflow = "hidden";

const toolbar = document.createElement("div");
toolbar.style.position = "fixed";
toolbar.style.zIndex = "2";
toolbar.style.top = "16px";
toolbar.style.left = "16px";
toolbar.style.display = "flex";
toolbar.style.gap = "12px";

const openButton = document.createElement("button");
openButton.textContent = "Open folder";
openButton.setAttribute("data-testid", "open-folder");
openButton.style.padding = "8px 14px";
openButton.style.cursor = "pointer";
const status = document.createElement("span");
status.textContent = "Choose a folder to open a TypeScript source file.";
status.style.padding = "8px 0";
toolbar.append(openButton, status);
root.append(toolbar);

const canvas = document.createElement("canvas");
canvas.id = "canvas";
canvas.setAttribute("data-testid", "canvas");
canvas.style.display = "block";
canvas.style.width = "100vw";
canvas.style.height = "100vh";
canvas.style.touchAction = "none";
setCanvasAttribute("data-detail-level", "text");
setCanvasAttribute("data-highlighted", "false");
setCanvasAttribute("data-editing", "false");
root.append(canvas);

const editorContainer = document.createElement("div");
editorContainer.setAttribute("data-testid", "editor");
root.append(editorContainer);

const camera = new Camera({ x: 60, y: 76 });
const detail = new DetailLevel();
const codeFont = DEFAULT_CODE_FONT;
const textMetrics: CodeTextMetrics = createTextMetrics(codeFont);
const input = new GestureInput();
const tokenizer = new WorkerTokenizer();
const residency = new DocumentResidency(tokenizer);
const frameStats = new FrameStats();
const frameLog = new FrameLog();
let renderer: WebGlRenderer | undefined;
let frameLoop: FrameLoop | undefined;
let editing: EditingTransition | undefined;
let editorHost: Awaited<ReturnType<typeof createMonacoEditorHost>> | undefined;
let widgetFrame: Rect | undefined;
let currentSource: EditingSource | undefined;
let editorVisible = false;

function setCanvasAttribute(name: string, value: string): void {
  if (canvas.getAttribute(name) !== value) canvas.setAttribute(name, value);
}

function bodyRect(): Rect | undefined {
  if (!widgetFrame) return undefined;
  return {
    x: camera.offsetX + widgetFrame.x * camera.scale,
    y: camera.offsetY + (widgetFrame.y + codeFont.bodyTop) * camera.scale,
    width: widgetFrame.width * camera.scale,
    height: (widgetFrame.height - codeFont.bodyTop) * camera.scale,
  };
}

function updateWidgetBodyRect(): void {
  const rect = bodyRect();
  if (!rect) return;
  setCanvasAttribute("data-widget-body-rect", JSON.stringify(rect));
  editorHost?.setBounds(editorBounds(), camera.scale);
  canvas.setAttribute("data-text-metrics-scale", String(camera.scale));
}

function applyHarnessCamera(x: number, y: number, scale: number): void {
  camera.setPosition({ x, y }, scale);
  updateWidgetBodyRect();
  const onScreenLineHeight =
    codeFont.lineHeight * camera.scale * (window.devicePixelRatio || 1);
  const level = detail.update(
    onScreenLineHeight,
    renderer?.textReady() ?? false,
  );
  setCanvasAttribute("data-detail-level", level);
  renderer?.setDetailLevel(
    level,
    level === "minimap" && detail.textWanted(onScreenLineHeight),
  );
  frameLoop?.invalidate();
}

function readHarnessCamera(): { x: number; y: number; scale: number } {
  return { x: camera.offsetX, y: camera.offsetY, scale: camera.scale };
}

function editorBounds(): Rect {
  if (!widgetFrame) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: camera.offsetX + widgetFrame.x * camera.scale,
    y: camera.offsetY + (widgetFrame.y + codeFont.bodyTop) * camera.scale,
    width: widgetFrame.width,
    height: widgetFrame.height - codeFont.bodyTop,
  };
}

function exposeEditorPosition(): void {
  const position = editorHost?.getPosition();
  if (!position) return;
  canvas.setAttribute("data-editor-position", JSON.stringify(position));
}

function applyInput(): void {
  if (!frameLoop || !renderer) return;
  if (editing?.isExitHeld) return;
  const gesture = input.consume();
  const zoomingInFromMinimap =
    detail.value === "minimap" &&
    gesture.zoomFactor > 1 &&
    input.isZoomGestureActive();
  if (zoomingInFromMinimap) {
    renderer.beginTextPrefetch(
      detail.textThresholdZoom(
        codeFont.lineHeight,
        window.devicePixelRatio || 1,
      ),
    );
  }
  let cameraChanged = false;
  if (gesture.panX || gesture.panY) {
    panCamera(camera, gesture.panX, gesture.panY);
    cameraChanged = true;
  }
  if (gesture.zoomFactor !== 1) {
    zoomCamera(camera, gesture.zoomX, gesture.zoomY, gesture.zoomFactor);
    cameraChanged = true;
  }
  if (cameraChanged) updateWidgetBodyRect();
  const onScreenLineHeight =
    codeFont.lineHeight * camera.scale * (window.devicePixelRatio || 1);
  const level = detail.update(onScreenLineHeight, renderer.textReady());
  setCanvasAttribute("data-detail-level", level);
  renderer.setDetailLevel(
    level,
    level === "minimap" && detail.textWanted(onScreenLineHeight),
  );
  renderer.setGestureInProgress(input.isGestureInProgress());
  renderer.setZoomGestureActive(input.isZoomGestureActive());
  renderer.setZoomFocus(
    input.zoomFocusX(),
    input.zoomFocusY(),
    input.zoomDirectionSign() < 0,
  );
}

function reportRasterError(): void {
  const error = renderer?.rasterError();
  if (error && status.textContent !== error) status.textContent = error;
}

function applyEditingSwap(): void {
  if (!editing || !renderer) return;
  const swap = editing.takeFrameSwap();
  if (!swap) return;
  if (swap.direction === "exit" && swap.source) {
    renderer.setDocument(
      swap.source.widgetId,
      swap.source.path,
      swap.source.text,
      swap.source.frame,
    );
  }
  renderer.setWidgetVisible(swap.direction === "exit");
  editorVisible = swap.direction === "enter";
  setCanvasAttribute("data-editing", String(swap.direction === "enter"));
  if (swap.direction === "enter") {
    updateWidgetBodyRect();
    exposeEditorPosition();
    editorHost?.focus();
  }
  if (swap.direction === "exit") applyInput();
}

function readSource(widgetId: string): EditingSource | undefined {
  return currentSource?.widgetId === widgetId ? currentSource : undefined;
}

function cursorAtPoint(source: EditingSource, point: { x: number; y: number }) {
  const rect = bodyRect();
  if (!rect || !editorHost) return { lineNumber: 1, column: 1 };
  const layout = new LineLayout(source.text, textMetrics);
  const line = Math.max(
    0,
    Math.min(
      layout.lines.length - 1,
      Math.floor((point.y - rect.y) / camera.scale / codeFont.lineHeight),
    ),
  );
  const x = Math.max(0, (point.x - rect.x) / camera.scale);
  return {
    lineNumber: line + 1,
    column: layout.columnAtX(line, x),
  };
}

function beginEditing(event: MouseEvent): void {
  if (!editing || !editorHost || detail.value !== "text" || !currentSource)
    return;
  const rect = bodyRect();
  if (!rect) return;
  const point = { x: event.offsetX, y: event.offsetY };
  if (
    point.x < rect.x ||
    point.y < rect.y ||
    point.x > rect.x + rect.width ||
    point.y > rect.y + rect.height
  ) {
    return;
  }
  if (
    !editing.begin(
      currentSource.widgetId,
      point,
      cursorAtPoint(currentSource, point),
    )
  )
    return;
  currentSource = editing.sourceForActiveWidget() ?? currentSource;
  setCanvasAttribute(
    "data-editor-line-count",
    String(editorHost.getLineCount()),
  );
  updateWidgetBodyRect();
  exposeEditorPosition();
  frameLoop?.invalidate();
}

function installDevTestHook(): void {
  window.__codeCanvasTest = {
    textMetrics: () => {
      if (!renderer) throw new Error("Renderer is not ready");
      return renderer.getTextMetricsProbe();
    },
    tileDebug: () => {
      if (!renderer) throw new Error("Renderer is not ready");
      return renderer.debugSnapshot();
    },
    frameLog: () => frameLog.snapshot(),
    setCamera: applyHarnessCamera,
  };
}

async function openFolder(): Promise<void> {
  const source = await openSourceFile();
  if (!source || !renderer) {
    status.textContent = "No .ts or .tsx Source File found.";
    return;
  }
  status.textContent = source.path;
  const lineCount = new LineLayout(source.text, textMetrics).lines.length;
  widgetFrame = {
    x: 0,
    y: 0,
    width: 760,
    height: Math.min(
      900,
      codeFont.bodyTop + lineCount * codeFont.lineHeight + codeFont.size,
    ),
  };
  currentSource = {
    widgetId: source.fileId,
    path: source.path,
    text: source.text,
    contentVersion: 1,
    frame: widgetFrame,
  };
  renderer.setDocument(source.fileId, source.path, source.text, widgetFrame);
  renderer.setVisibleRange(0, 60);
  setCanvasAttribute("data-highlighted", "false");
  setCanvasAttribute("data-content-version", "1");
  setCanvasAttribute("data-editor-line-count", "");
  updateWidgetBodyRect();
  residency.contentChanged(source.fileId, 1, source.text);
  residency.visibleRangesChanged(
    new Map([[source.fileId, [{ start: 0, end: 60 }]]]),
  );
  frameLoop?.invalidate();
}

function wireEditing(host: NonNullable<typeof editorHost>): void {
  editing = new EditingTransition({
    camera,
    editor: host,
    residency,
    readSource,
    tilesCurrent: (widgetId, contentVersion) =>
      renderer?.tilesCurrentFor(widgetId, contentVersion) ?? false,
    onContentChanged: (source) => {
      currentSource = source;
      renderer?.setDocument(
        source.widgetId,
        source.path,
        source.text,
        source.frame,
      );
      setCanvasAttribute("data-content-version", String(source.contentVersion));
      setCanvasAttribute("data-highlighted", "false");
    },
  });
  host.onEscape(() => {
    if (!editing?.isEditing) return;
    editing.end("escape");
    frameLoop?.invalidate();
  });
}

function createFrameStages(): FrameStage[] {
  const stages: FrameStage[] = [
    { name: "apply-input", run: applyInput },
    { name: "report-raster-error", run: reportRasterError },
    { name: "editing-swap", run: applyEditingSwap },
    {
      name: "residency-drain",
      run: () => {
        if (!renderer) return;
        residency.drain(2, renderer);
        // Posting raster jobs and uploading returned tiles runs in this same
        // budgeted slot (design D7 "GpuUploader"), not from the raster
        // worker's message handler.
        const uploadedTiles = renderer.drainTiles(camera);
        if (uploadedTiles > 0) frameLoop?.invalidate();
      },
    },
    {
      name: "draw",
      run: () => {
        const metrics = renderer?.draw(camera);
        if (metrics) frameLoop?.setFrameMetrics(metrics);
      },
    },
  ];
  if (import.meta.env.DEV)
    stages.push({ name: "frame-log", run: recordFrameLog });
  return stages;
}

function recordFrameLog(): void {
  if (!renderer) return;
  const metrics = renderer.frameMetrics();
  frameLog.record(metrics, {
    cameraOffsetX: camera.offsetX,
    cameraOffsetY: camera.offsetY,
    cameraScale: camera.scale,
    detailLevel: detail.value === "minimap" ? 1 : 0,
    onScreenLineHeight:
      codeFont.lineHeight * camera.scale * (window.devicePixelRatio || 1),
    textReady: renderer.textReady(),
    editorVisible,
  });
}

function wireInput(): void {
  input.attach(
    canvas,
    () => frameLoop?.invalidate(),
    (kind) => {
      if (!editing?.isEditing) return;
      editing.end(kind === "zoom" ? "zoom" : "pan", { kind });
      frameLoop?.invalidate();
    },
    (inProgress, wasZoom) => {
      frameLoop?.setGestureInProgress(inProgress);
      if (!inProgress) {
        renderer?.notifyGestureEnded(wasZoom, camera.scale);
        // The gesture-end callback fires from a timer, not a FrameLoop tick
        // (design D8): without this, a loop that went idle the instant the
        // gesture ended would never run the tick that starts the zoom
        // settle's re-raster (design D6 "Zoom").
        frameLoop?.invalidate();
      }
    },
  );
}

async function start(): Promise<void> {
  try {
    editorHost = await createMonacoEditorHost(
      editorContainer,
      codeFont,
      configureMonacoTextMate,
      themePalette,
    );
  } catch (error) {
    console.error(
      "Monaco editing is unavailable; continuing with GPU view.",
      error,
    );
    editorHost = undefined;
  }
  renderer = new WebGlRenderer(
    canvas,
    textMetrics,
    codeFont,
    themePalette.background,
  );
  if (import.meta.env.DEV) installDevTestHook();
  if (editorHost) wireEditing(editorHost);
  frameLoop = new FrameLoop(createFrameStages(), (sample) => {
    frameStats.record(sample);
  });
  renderer.onNeedsRedraw(() => frameLoop?.invalidate());
  void installHarnessBridge();
  tokenizer.subscribe((result: TokenizedLines) => {
    if (!residency.receiveTokens(result)) return;
    setCanvasAttribute("data-highlighted", "true");
    frameLoop?.invalidate();
  });
  wireInput();
  canvas.addEventListener("dblclick", beginEditing);
  openButton.addEventListener("click", () => void openFolder());
  window.addEventListener("resize", () => frameLoop?.invalidate());
  frameLoop.invalidate();
}

async function installHarnessBridge(): Promise<void> {
  if (import.meta.env.VITE_PERF_HARNESS !== "1") return;
  const [
    { installPerfBridge },
    { createSyntheticLoadStage },
    { createCameraRangeStage },
    gpuModule,
  ] = await Promise.all([
    import("../performance/install-bridge"),
    import("../performance/synthetic-load"),
    import("../performance/camera-range"),
    import("../rendering/synthetic-gpu-load"),
  ]);
  const gpuLoad = new gpuModule.default(canvas);
  const stage = createSyntheticLoadStage(
    (iterations) => {
      gpuLoad.draw(iterations);
    },
    () => {
      frameLoop?.invalidate();
    },
  );
  const cameraRangeStage = createCameraRangeStage(() => camera.scale);
  frameLoop?.addStage(stage);
  frameLoop?.addStage(cameraRangeStage);
  installPerfBridge(
    frameStats,
    applyHarnessCamera,
    {
      camera: readHarnessCamera,
      cameraRange: cameraRangeStage.range,
      resetCameraRange: cameraRangeStage.reset,
    },
    (load) => {
      stage.setLoad(load);
    },
  );
}

void start();
