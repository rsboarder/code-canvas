import {
  BoardService,
  createWidgetRow,
  createHitTestResult,
  type BoardMetrics,
} from "../board/index";
import { DocumentResidency } from "../code-view/index";
import { EditingTransition } from "../editing/index";
import { createMonacoEditorHost } from "../editing/infrastructure/monaco-editor-host";
import { GestureTargeting } from "../interaction/gesture-targeting";
import { FrameStats } from "../performance/frame-stats";
import { MetricsOverlay } from "../performance/metrics-overlay";
import { FrameLog } from "./frame-log";
import {
  createTextMetrics,
  FrameLoop,
  WebGlRenderer,
  type CodeTextMetrics,
  type TextMetricsProbe,
} from "../rendering/index";
import { DEFAULT_CODE_FONT } from "../shared/font";
import type { FrameStage } from "../shared/frame";
import type { Rect } from "../shared/geometry/geometry";
import { configureMonacoTextMate } from "../code-view/infrastructure/monaco-tokens";
import { themePalette } from "../code-view/infrastructure/theme";
import {
  createTokenizerWorker,
  tokenizerPoolSize,
  type WorkerTokenizerPoolOptions,
  WorkerTokenizerPool,
} from "../code-view/infrastructure/worker-tokenizer-pool";
import { createEventBus } from "../shared/events";
import type { SourceFileId } from "../shared/domain";
import type { WorkspaceEvent, WorkspaceService } from "../workspace";
import { createInputWiring } from "./input-wiring";
import {
  createWorkspaceWiring,
  type WorkspaceWiring,
} from "./workspace-wiring";
import { createWriteErrorNotification } from "./write-error-notification";
import {
  createSaveConflictNotice,
  type SaveConflictEditing,
} from "./save-conflict-notice";
import { createToolbar } from "./toolbar";
import { createFolderActions } from "./folder-actions";

interface CodeCanvasTestHook {
  textMetrics(): TextMetricsProbe;
  cellColors(): ReturnType<WebGlRenderer["cellColors"]>;
  tileDebug(): ReturnType<WebGlRenderer["debugSnapshot"]>;
  frameLog(): ReturnType<FrameLog["snapshot"]>;
  widgetRects(): readonly {
    filePath: string;
    rect: { x: number; y: number; width: number; height: number };
  }[];
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

const toolbar = createToolbar(root);

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

const codeFont = DEFAULT_CODE_FONT;
const boardMetrics: BoardMetrics = {
  baseLineHeight: codeFont.lineHeight,
  headerHeight: codeFont.bodyTop,
  minimumWidth: 240,
  minimumBodyLines: 3,
  columnWidth: 760,
  gridGap: 40,
  maximumHeight: 900,
  edgeGrabScreenPx: 8,
};
const events = createEventBus<WorkspaceEvent>();
const board = new BoardService(boardMetrics, events);
const textMetrics: CodeTextMetrics = createTextMetrics(codeFont);
const tokenizer = new WorkerTokenizerPool({
  size: tokenizerPoolSize(navigator.hardwareConcurrency),
  createWorker: createTokenizerWorker,
} satisfies WorkerTokenizerPoolOptions);
const residency = new DocumentResidency({
  tokenizer,
  lineMetrics: textMetrics,
});
const frameStats = new FrameStats();
const metricsOverlay = new MetricsOverlay(root, frameStats);
const frameLog = new FrameLog();
let renderer: WebGlRenderer | undefined;
let frameLoop: FrameLoop | undefined;
let editing: EditingTransition | undefined;
let editorHost: Awaited<ReturnType<typeof createMonacoEditorHost>> | undefined;
let workspaceWiring: WorkspaceWiring | undefined;
let layoutVersionSeen = board.layoutVersion;
const editingState = {
  get activeWidgetId(): string | undefined {
    return editing?.activeWidgetId;
  },
};
const targeting = new GestureTargeting(board, editingState);
const widgetRow = createWidgetRow();
const hit = createHitTestResult();
let currentSource: { widgetId: SourceFileId; path: string } | undefined;
let editorVisible = false;
const inputWiring = createInputWiring({
  canvas,
  editorContainer,
  board,
  targeting,
  getEditing: () => editing,
  getRenderer: () => renderer,
  getFrameLoop: () => frameLoop,
  updateWidgetBodyRect,
  toggleMetricsOverlay: () => {
    metricsOverlay.toggle();
  },
});

function setCanvasAttribute(name: string, value: string): void {
  if (canvas.getAttribute(name) !== value) canvas.setAttribute(name, value);
}

function bodyRect(): Rect | undefined {
  const row = readCurrentWidgetRow();
  if (!row) return undefined;
  return {
    x: board.camera.offsetX + row.x * board.camera.scale,
    y: board.camera.offsetY + (row.y + codeFont.bodyTop) * board.camera.scale,
    width: row.width * board.camera.scale,
    height: (row.height - codeFont.bodyTop) * board.camera.scale,
  };
}

function readCurrentWidgetRow() {
  const widgetId = editing?.activeWidgetId ?? currentSource?.widgetId;
  if (widgetId === undefined) return undefined;
  return board.readWidget(widgetId, widgetRow);
}

events.subscribe("FileContentChanged", (event) => {
  const source = currentSource;
  if (event.fileId !== source?.widgetId) return;
  renderer?.setDocument(source.widgetId, source.path);
  setCanvasAttribute("data-content-version", String(event.contentVersion));
  setCanvasAttribute("data-highlighted", "false");
});

events.subscribe("FilesDiscovered", (event) => {
  renderer?.setMinimapFiles(event.files.map((file) => file.fileId));
});

function updateWidgetBodyRect(): void {
  const rect = bodyRect();
  if (!rect) return;
  setCanvasAttribute("data-widget-body-rect", JSON.stringify(rect));
  editorHost?.setBounds(editorBounds(), board.camera.scale);
  canvas.setAttribute("data-text-metrics-scale", String(board.camera.scale));
}

function applyHarnessCamera(x: number, y: number, scale: number): void {
  board.setCamera(x, y, scale);
  updateWidgetBodyRect();
  const devicePixelRatio = window.devicePixelRatio || 1;
  const level = board.updateDetailLevel(
    devicePixelRatio,
    renderer?.textReady() ?? false,
  );
  setCanvasAttribute("data-detail-level", level);
  renderer?.setDetailLevel(level, board.textWanted(devicePixelRatio));
  frameLoop?.invalidate();
}

function readHarnessCamera(): { x: number; y: number; scale: number } {
  return {
    x: board.camera.offsetX,
    y: board.camera.offsetY,
    scale: board.camera.scale,
  };
}

function editorBounds(): Rect {
  const row = readCurrentWidgetRow();
  if (!row) return { x: 0, y: 0, width: 1, height: 1 };
  return {
    x: board.camera.offsetX + row.x * board.camera.scale,
    y: board.camera.offsetY + (row.y + codeFont.bodyTop) * board.camera.scale,
    width: row.width,
    height: row.height - codeFont.bodyTop,
  };
}

function exposeEditorPosition(): void {
  const position = editorHost?.getPosition();
  if (!position) return;
  canvas.setAttribute("data-editor-position", JSON.stringify(position));
}

function applyInput(): void {
  inputWiring.applyInput();
}

function restoreWorkspaceLayout(): void {
  if (!workspaceWiring || board.layoutVersion === layoutVersionSeen) return;
  layoutVersionSeen = board.layoutVersion;
  setCanvasAttribute("data-widget-count", String(board.widgetCount));
  const paths = new Map<string, string>();
  for (let index = 0; index < board.widgetCount; index += 1) {
    const id = board.widgetIdAtFromTop(index);
    if (!id) continue;
    const file = workspaceWiring.documentFile(id);
    if (file) paths.set(id, file.path);
  }
  renderer?.setFilePaths(paths);
  const documentFile = workspaceWiring.firstDocumentFile();
  if (!documentFile || !renderer) return;
  const fileId = documentFile.fileId;
  currentSource = {
    widgetId: fileId,
    path: documentFile.path,
  };
  toolbar.setStatus(documentFile.path);
  renderer.setDocument(fileId, documentFile.path);
  renderer.setVisibleRange(0, 60);
  setCanvasAttribute("data-highlighted", "false");
  setCanvasAttribute(
    "data-content-version",
    String(documentFile.contentVersion),
  );
  setCanvasAttribute("data-editor-line-count", "");
  updateWidgetBodyRect();
  frameLoop?.invalidate();
}

function widgetRects(): readonly {
  filePath: string;
  rect: { x: number; y: number; width: number; height: number };
}[] {
  const rects: {
    filePath: string;
    rect: { x: number; y: number; width: number; height: number };
  }[] = [];
  if (!workspaceWiring) return rects;
  for (let index = 0; index < board.widgetCount; index += 1) {
    const id = board.widgetIdAtFromTop(index);
    if (!id) continue;
    const file = workspaceWiring.documentFile(id);
    if (!file) continue;
    const row = board.readWidget(id, widgetRow);
    rects.push({
      filePath: file.path,
      rect: {
        x: board.camera.offsetX + row.x * board.camera.scale,
        y: board.camera.offsetY + row.y * board.camera.scale,
        width: row.width * board.camera.scale,
        height: row.height * board.camera.scale,
      },
    });
  }
  return rects;
}

function reportRasterError(): void {
  const error = renderer?.rasterError();
  if (error) toolbar.setStatus(error);
}

function applyEditingSwap(): void {
  if (!editing || !renderer) return;
  const swap = editing.takeFrameSwap();
  if (!swap) return;
  renderer.setHiddenBody(
    swap.direction === "enter" ? swap.widgetId : undefined,
  );
  editorVisible = swap.direction === "enter";
  setCanvasAttribute("data-editing", String(swap.direction === "enter"));
  if (swap.direction === "enter") {
    updateWidgetBodyRect();
    exposeEditorPosition();
    editorHost?.focus();
  }
  if (swap.direction === "exit") applyInput();
}

function beginEditing(event: MouseEvent): void {
  if (!editing || !editorHost || board.detailLevel !== "text") return;
  board.hitTest(event.offsetX, event.offsetY, hit);
  const widgetId = hit.widgetId;
  if (hit.zone !== "body" || widgetId === undefined) return;
  if (editing.begin(widgetId, { x: hit.contentX, y: hit.contentY })) {
    frameLoop?.invalidate();
  }
}

function findWidgetIdByPath(
  path: string,
  wiring: WorkspaceWiring,
): SourceFileId | undefined {
  for (let index = 0; index < board.widgetCount; index += 1) {
    const id = board.widgetIdAtFromTop(index);
    if (id && wiring.documentFile(id)?.path === path) return id;
  }
  return undefined;
}

function waitForAnimationFrame(
  condition: () => boolean,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 10_000;
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (performance.now() >= deadline) {
        reject(new Error(timeoutMessage));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

async function beginEditingForHarness(path: string): Promise<void> {
  const editingTransition = editing;
  const wiring = workspaceWiring;
  if (!editingTransition || !editorHost || !wiring) {
    throw new Error("Editing is unavailable");
  }
  const widgetId = findWidgetIdByPath(path, wiring);
  if (!widgetId) throw new Error(`Unknown Source File path: ${path}`);
  if (editingTransition.activeWidgetId === widgetId && editorVisible) return;
  await waitForAnimationFrame(
    () => board.detailLevel === "text",
    "Timed out waiting for text detail level.",
  );
  editingTransition.begin(widgetId, { x: 0, y: 0 });
  frameLoop?.invalidate();
  await waitForAnimationFrame(
    () => editingTransition.activeWidgetId === widgetId && editorVisible,
    `Editing did not start: ${path}`,
  );
}

function installDevTestHook(): void {
  window.__codeCanvasTest = {
    textMetrics: () => {
      if (!renderer) throw new Error("Renderer is not ready");
      return renderer.getTextMetricsProbe();
    },
    cellColors: () => {
      if (!renderer) throw new Error("Renderer is not ready");
      return renderer.cellColors();
    },
    tileDebug: () => {
      if (!renderer) throw new Error("Renderer is not ready");
      return renderer.debugSnapshot();
    },
    frameLog: () => frameLog.snapshot(),
    widgetRects,
    setCamera: applyHarnessCamera,
  };
}

function wireEditing(
  host: NonNullable<typeof editorHost>,
  workspace: WorkspaceService,
): void {
  editing = new EditingTransition({
    board,
    workspace,
    editor: host,
    residency,
    lineMetrics: textMetrics,
    tilesCurrent: (widgetId, contentVersion) =>
      renderer?.tilesCurrentFor(widgetId, contentVersion) ?? false,
    onOpened: () => {
      setCanvasAttribute("data-editor-line-count", String(host.getLineCount()));
      updateWidgetBodyRect();
      exposeEditorPosition();
      frameLoop?.invalidate();
    },
  });
  let autosaveTimer: number | undefined;
  const scheduleAutosave = (): void => {
    if (autosaveTimer !== undefined) return;
    const dueAt = editing?.autosaveDueAt() ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(dueAt)) return;
    autosaveTimer = window.setTimeout(
      () => {
        autosaveTimer = undefined;
        if (editing?.autosave(performance.now())) frameLoop?.invalidate();
        scheduleAutosave();
      },
      Math.max(0, dueAt - performance.now()),
    );
  };
  host.onChange(scheduleAutosave);
  host.onEscape(() => {
    if (!editing?.isEditing) return;
    editing.end("escape");
    frameLoop?.invalidate();
  });
}

function createFrameStages(): FrameStage[] {
  const stages: FrameStage[] = [
    { name: "apply-input", run: applyInput },
    { name: "restore-workspace-layout", run: restoreWorkspaceLayout },
    {
      name: "widget-table",
      run: () => renderer?.syncWidgetTable(board),
    },
    {
      name: "cull",
      run: () => {
        if (!renderer) return;
        residency.visibleRangesChanged(renderer.cull(board.camera));
      },
    },
    { name: "report-raster-error", run: reportRasterError },
    { name: "editing-swap", run: applyEditingSwap },
    {
      name: "residency-drain",
      run: () => {
        if (!renderer) return;
        if (residency.drain(2, renderer)) frameLoop?.invalidate();
        setCanvasAttribute("data-highlighted", String(renderer.highlighted()));
        // Posting raster jobs and uploading returned tiles runs in this same
        // budgeted slot (design D7 "GpuUploader"), not from the raster
        // worker's message handler.
        const uploadedTiles = renderer.drainTiles(board.camera, 2);
        if (uploadedTiles > 0) frameLoop?.invalidate();
      },
    },
    {
      name: "draw",
      run: () => {
        const metrics = renderer?.draw(board.camera);
        if (metrics) {
          frameLoop?.setFrameMetrics(metrics);
          frameLoop?.setSampleState(
            board.detailLevel,
            metrics.visibleWidgetCount,
            residency.backlogDepth,
            board.textWanted(window.devicePixelRatio || 1),
          );
        }
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
    cameraOffsetX: board.camera.offsetX,
    cameraOffsetY: board.camera.offsetY,
    cameraScale: board.camera.scale,
    detailLevel: board.detailLevel === "minimap" ? 1 : 0,
    onScreenLineHeight:
      codeFont.lineHeight * board.camera.scale * (window.devicePixelRatio || 1),
    textReady: renderer.textReady(),
    editorVisible,
  });
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
  renderer = new WebGlRenderer(canvas, textMetrics, codeFont, themePalette);
  workspaceWiring = await createWorkspaceWiring({
    board,
    residency,
    events,
    viewport: () => ({
      width: canvas.clientWidth || window.innerWidth,
      height: canvas.clientHeight || window.innerHeight,
    }),
    onLayoutRestored: () => frameLoop?.invalidate(),
  });
  const folderActions = createFolderActions({
    workspace: workspaceWiring.workspace,
    toolbar,
    events,
  });
  createWriteErrorNotification({
    root,
    events,
    workspace: workspaceWiring.workspace,
  });
  createSaveConflictNotice({
    root,
    events,
    workspace: workspaceWiring.workspace,
    pathOf: (fileId) => workspaceWiring?.documentFile(fileId)?.path,
    editing: {
      activeWidgetId: () => editing?.activeWidgetId,
      discard: () => {
        if (editing?.discard()) frameLoop?.invalidate();
      },
      focus: () => editorHost?.focus(),
    } satisfies SaveConflictEditing,
  });
  if (import.meta.env.DEV) installDevTestHook();
  if (editorHost) wireEditing(editorHost, workspaceWiring.workspace);
  frameLoop = new FrameLoop(createFrameStages(), (sample) => {
    frameStats.record(sample);
  });
  renderer.onNeedsRedraw(() => frameLoop?.invalidate());
  toolbar.enable({
    openFolder: () => void folderActions.openFolder(),
    reopenFolder: () => void folderActions.reopenLastFolder(),
    fitAll: () => {
      targeting.requestFitAll();
      frameLoop?.invalidate();
    },
    zoomTo100: () => {
      targeting.requestZoomTo100();
      frameLoop?.invalidate();
    },
  });
  void folderActions.offerReopenOnStart();
  void installHarnessBridge();
  tokenizer.subscribe(() => {
    frameLoop?.invalidate();
  });
  inputWiring.wire();
  canvas.addEventListener("dblclick", beginEditing);
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
  const cameraRangeStage = createCameraRangeStage(() => board.camera.scale);
  frameLoop?.addStage(stage);
  frameLoop?.addStage(cameraRangeStage);
  const demand = {
    capacity: 0,
    requested: 0,
    pinned: 0,
    inFlight: 0,
    posted: 0,
    stale: 0,
    uploadFailed: 0,
    visibleExact: false,
    clockRunning: false,
    gestureActive: false,
    minimapActive: false,
  };
  installPerfBridge(
    frameStats,
    applyHarnessCamera,
    {
      camera: readHarnessCamera,
      cameraRange: cameraRangeStage.range,
      resetCameraRange: cameraRangeStage.reset,
      settleState: () => {
        if (renderer) renderer.tileDemand(demand);
        else resetTileDemand(demand);
        return {
          frameLoopIdle: frameLoop?.idle ?? false,
          syntheticLoadActive: stage.isActive(),
          tilesSettled: renderer?.settled() ?? false,
          residencyBacklog: residency.backlogDepth,
          tokenizationPending: residency.tokenizationPendingCount,
          textSwitchPending: board.textWanted(window.devicePixelRatio || 1),
          tilePoolCapacity: demand.capacity,
          tileRequests: demand.requested,
          tilesPinned: demand.pinned,
          tilesInFlight: demand.inFlight,
          tilesPosted: demand.posted,
          tilesStale: demand.stale,
          tilesUploadFailed: demand.uploadFailed,
          tilesVisibleExact: demand.visibleExact,
          tilesClockRunning: demand.clockRunning,
          tilesGestureActive: demand.gestureActive,
          tilesMinimapActive: demand.minimapActive,
        };
      },
      beginEditing: beginEditingForHarness,
    },
    (load) => {
      stage.setLoad(load);
    },
  );
}

function resetTileDemand(demand: {
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
}): void {
  demand.capacity = 0;
  demand.requested = 0;
  demand.pinned = 0;
  demand.inFlight = 0;
  demand.posted = 0;
  demand.stale = 0;
  demand.uploadFailed = 0;
  demand.visibleExact = false;
  demand.clockRunning = false;
  demand.gestureActive = false;
  demand.minimapActive = false;
}

void start();
