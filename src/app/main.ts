import {
  BoardService,
  createWidgetRow,
  type BoardMetrics,
  type WidgetRow,
} from "../board/index";
import { DocumentResidency } from "../code-view/index";
import { EditingTransition } from "../editing/index";
import { createMonacoEditorHost } from "../editing/infrastructure/monaco-editor-host";
import { createInputStage, GestureTargeting } from "../interaction";
import { FrameStats } from "../performance/frame-stats";
import { MetricsOverlay } from "../performance/metrics-overlay";
import { FrameLog } from "./frame-log";
import {
  createTextMetrics,
  FrameLoop,
  WebGlRenderer,
  type CodeTextMetrics,
  type FrameTileMetrics,
} from "../rendering/index";
import { DEFAULT_CODE_FONT } from "../shared/font";
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
import { syncDetailLevel } from "./detail-level-sync";
import type { DevProbe } from "./dev-probe";
import { createFrameStages, type FrameStageSteps } from "./frame-stages";

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
const frameTileMetrics: FrameTileMetrics = {
  capacity: 0,
  inUse: 0,
  inFlight: 0,
  posted: 0,
};
let renderer: WebGlRenderer | undefined;
let frameLoop: FrameLoop | undefined;
let editing: EditingTransition | undefined;
let editorHost: Awaited<ReturnType<typeof createMonacoEditorHost>> | undefined;
let workspaceWiring: WorkspaceWiring | undefined;
let devProbe: DevProbe | undefined;
let layoutVersionSeen = board.layoutVersion;
const editingState = {
  get activeWidgetId(): string | undefined {
    return editing?.activeWidgetId;
  },
};
const targeting = new GestureTargeting(board, editingState);
const widgetRow = createWidgetRow();
let editorVisible = false;
const inputWiring = createInputWiring({
  canvas,
  editorContainer,
  targeting,
  getFrameLoop: () => frameLoop,
});

function setCanvasAttribute(name: string, value: string): void {
  if (canvas.getAttribute(name) !== value) canvas.setAttribute(name, value);
}

function bodyRect(): Rect | undefined {
  const row = readCurrentWidgetRow();
  if (!row) return undefined;
  return rowScreenRect(row, codeFont.bodyTop);
}

function rowScreenRect(row: WidgetRow, bodyTop = 0): Rect {
  return {
    x: board.camera.offsetX + row.x * board.camera.scale,
    y: board.camera.offsetY + (row.y + bodyTop) * board.camera.scale,
    width: row.width * board.camera.scale,
    height: (row.height - bodyTop) * board.camera.scale,
  };
}

function firstFileId(): SourceFileId | undefined {
  return workspaceWiring?.firstFileId();
}

function readCurrentWidgetRow() {
  const widgetId = editing?.activeWidgetId ?? firstFileId();
  if (widgetId === undefined) return undefined;
  return board.readWidget(widgetId, widgetRow);
}

events.subscribe("FilesDiscovered", (event) => {
  renderer?.setMinimapFiles(event.files.map((file) => file.fileId));
});

function updateWidgetBodyRect(): void {
  const rect = bodyRect();
  if (!rect) return;
  setCanvasAttribute("data-widget-body-rect", JSON.stringify(rect));
  canvas.setAttribute("data-text-metrics-scale", String(board.camera.scale));
}

const inputStage = createInputStage({
  board,
  targeting,
  getEditing: () => editing,
  frame: {
    setGestureInProgress: (value) => frameLoop?.setGestureInProgress(value),
    invalidate: () => frameLoop?.invalidate(),
  },
  phase: {
    setGesturePhase: (phase) => renderer?.setGesturePhase(phase),
  },
  detail: {
    update: () => syncDetailLevel(board, renderer, canvas),
  },
  viewportWidth: () => canvas.clientWidth || window.innerWidth,
  viewportHeight: () => canvas.clientHeight || window.innerHeight,
  updateWidgetBodyRect,
  toggleMetricsOverlay: () => {
    metricsOverlay.toggle();
  },
});

function applyHarnessCamera(x: number, y: number, scale: number): void {
  board.setCamera(x, y, scale);
  updateWidgetBodyRect();
  syncDetailLevel(board, renderer, canvas);
  frameLoop?.invalidate();
}

function readHarnessCamera(): { x: number; y: number; scale: number } {
  return {
    x: board.camera.offsetX,
    y: board.camera.offsetY,
    scale: board.camera.scale,
  };
}

function exposeEditorPosition(): void {
  const position = editorHost?.getPosition();
  if (!position) return;
  canvas.setAttribute("data-editor-position", JSON.stringify(position));
}

function applyInput(): boolean {
  if (!frameLoop || !renderer) return false;
  const devicePixelRatio = window.devicePixelRatio || 1;
  inputStage.apply(performance.now(), devicePixelRatio);
  return false;
}

function restoreWorkspaceLayout(): boolean {
  if (!workspaceWiring || board.layoutVersion === layoutVersionSeen)
    return false;
  layoutVersionSeen = board.layoutVersion;
  setCanvasAttribute("data-widget-count", String(board.widgetCount));
  const paths = new Map<string, string>();
  for (let index = 0; index < board.widgetCount; index += 1) {
    const id = board.widgetIdAtFromTop(index);
    if (!id) continue;
    const path = workspaceWiring.pathOfFile(id);
    if (path) paths.set(id, path);
  }
  renderer?.setFilePaths(paths);
  const firstId = workspaceWiring.firstFileId();
  const firstPath = firstId ? workspaceWiring.pathOfFile(firstId) : undefined;
  if (!firstPath) return false;
  toolbar.setStatus(firstPath);
  setCanvasAttribute("data-editor-line-count", "");
  updateWidgetBodyRect();
  return true;
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
    const filePath = workspaceWiring.pathOfFile(id);
    if (!filePath) continue;
    const row = board.readWidget(id, widgetRow);
    rects.push({
      filePath,
      rect: rowScreenRect(row),
    });
  }
  return rects;
}

function reportRasterError(): boolean {
  const error = renderer?.rasterError();
  if (error) toolbar.setStatus(error);
  return false;
}

function applyEditingSwap(): boolean {
  if (!editing || !renderer) return false;
  const swap = editing.applyFrameSwap();
  if (swap.direction === undefined) return swap.needsAnotherTick;
  editorVisible = swap.direction === "enter";
  setCanvasAttribute("data-editing", String(editorVisible));
  if (editorVisible) {
    updateWidgetBodyRect();
    exposeEditorPosition();
  }
  if (swap.direction === "exit") applyInput();
  return swap.needsAnotherTick;
}

function findWidgetIdByPath(
  path: string,
  wiring: WorkspaceWiring,
): SourceFileId | undefined {
  return wiring.fileIdForPath(path);
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

async function installDevTestHook(): Promise<void> {
  const currentRenderer = renderer;
  const wiring = workspaceWiring;
  if (!currentRenderer || !wiring) return;
  const { installDevProbe } = await import("./dev-probe");
  devProbe = installDevProbe({
    canvas,
    metrics: textMetrics,
    source: () => currentRenderer.probeSource(),
    firstFileId,
    frameLog: () => frameLog.snapshot(),
    widgetRects,
    setCamera: applyHarnessCamera,
  });
}

function wireEditing(
  host: NonNullable<typeof editorHost>,
  workspace: WorkspaceService,
): void {
  const currentRenderer = renderer;
  if (!currentRenderer) return;
  editing = new EditingTransition({
    board,
    workspace,
    editor: host,
    residency,
    lineMetrics: textMetrics,
    gutter: textMetrics.lineNumberGutter,
    gpuView: currentRenderer,
    bodyTop: codeFont.bodyTop,
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
    editing.end();
    frameLoop?.invalidate();
  });
}

function recordFrameLog(): boolean {
  if (!renderer) return false;
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
  return false;
}

function createFrameStageSteps(): FrameStageSteps {
  return {
    applyInput,
    restoreWorkspaceLayout,
    syncWidgetTable: () => {
      renderer?.syncWidgetTable(board);
      return false;
    },
    cull: () => {
      if (!renderer) return false;
      residency.visibleRangesChanged(renderer.cull(board.camera));
      return false;
    },
    reportRasterError,
    applyEditingSwap,
    drain: () => {
      if (!renderer) return false;
      const drained = residency.drain(2, renderer);
      // Posting raster jobs and uploading returned tiles runs in this same
      // budgeted slot (design D7 "GpuUploader"), not from the raster
      // worker's message handler.
      const uploadedTiles = renderer.drainTiles(board.camera, 2);
      devProbe?.sync();
      return drained || uploadedTiles > 0;
    },
    draw: () => {
      const metrics = renderer?.draw(board.camera);
      if (metrics) {
        renderer?.frameTileMetrics(frameTileMetrics);
        frameLoop?.setFrameMetrics(metrics, frameTileMetrics);
        frameLoop?.setSampleState(
          board.detailLevel,
          metrics.visibleWidgetCount,
          residency.backlogDepth,
          board.textWanted(window.devicePixelRatio || 1),
        );
        frameLoop?.setBoardState(board.widgetCount, board.camera.scale);
      }
      return renderer?.isFading() ?? false;
    },
    ...(import.meta.env.DEV ? { frameLog: recordFrameLog } : {}),
  };
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
  if (import.meta.env.DEV) void installDevTestHook();
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
    pathOf: (fileId) => workspaceWiring?.pathOfFile(fileId),
    editing: {
      activeWidgetId: () => editing?.activeWidgetId,
      discard: () => {
        if (editing?.discard()) frameLoop?.invalidate();
      },
      focus: () => editorHost?.focus(),
    } satisfies SaveConflictEditing,
  });
  if (editorHost) wireEditing(editorHost, workspaceWiring.workspace);
  frameLoop = new FrameLoop(
    createFrameStages(createFrameStageSteps()),
    (sample) => {
      frameStats.record(sample);
    },
  );
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
  window.addEventListener("resize", () => frameLoop?.invalidate());
  frameLoop.invalidate();
}

async function installHarnessBridge(): Promise<void> {
  if (import.meta.env.VITE_PERF_HARNESS !== "1") return;
  const [
    { installPerfBridge },
    { createSettleState },
    { createSyntheticLoadStage },
    { createCameraRangeStage },
    gpuModule,
  ] = await Promise.all([
    import("../performance/install-bridge"),
    import("../performance/settle-state"),
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
  const settleState = createSettleState({
    renderer,
    frameLoop,
    syntheticLoad: stage,
    residency,
    textSwitchPending: () => board.textWanted(window.devicePixelRatio || 1),
  });
  installPerfBridge(
    frameStats,
    applyHarnessCamera,
    {
      camera: readHarnessCamera,
      cameraRange: cameraRangeStage.range,
      resetCameraRange: cameraRangeStage.reset,
      settleState,
      beginEditing: beginEditingForHarness,
    },
    (load) => {
      stage.setLoad(load);
    },
  );
}

void start();
