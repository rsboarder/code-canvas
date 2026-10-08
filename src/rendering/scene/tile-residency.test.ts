import { afterEach, describe, expect, it, vi } from "vitest";

import { Camera } from "../../board/index";
import type { BoardReadModel, WidgetRow } from "../../board/index";
import type { GesturePhase } from "../../shared/frame";
import { encodeRasterCells } from "../text/raster-job";
import type { RasterResult, RasterWorkerResponse } from "../text/raster-job";
import { TileResidency, type TileDemand } from "./tile-residency";
import type { TileContentSource } from "./tile-kind-jobs";
import { VisibleBodyProjection } from "../visible-body-projection";
import { WidgetTable, type WidgetTableBoard } from "./widget-table";

const FILE_ID = "file-a";
const FILE_PATH = "src/a.ts";
const BODY_TOP = 32;
const VIEWPORT = { width: 512, height: 512, devicePixelRatio: 1 };
const CAMERA = new Camera({ x: 0, y: 0 }, 1);

type WidgetId = NonNullable<ReturnType<BoardReadModel["widgetIdAtFromTop"]>>;

interface PostedJob {
  readonly tileKey: string;
  readonly contentVersion: number;
  readonly rasterScale: number;
}

class FakeWorker {
  static readonly instances: FakeWorker[] = [];

  readonly jobs: PostedJob[] = [];

  terminated: boolean;

  onmessage: ((event: MessageEvent<RasterWorkerResponse>) => void) | null =
    null;

  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message: { job: PostedJob }): void {
    this.jobs.push({ ...message.job });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(result: RasterResult): void {
    this.onmessage?.({
      data: { type: "rasterResult", result },
    } as MessageEvent<RasterWorkerResponse>);
  }

  emitWorkerError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  static emitPostedResults(): void {
    for (const worker of FakeWorker.instances) {
      if (worker.terminated) continue;
      for (const job of worker.jobs) worker.emit(resultFor(job));
    }
  }

  static postedContentJobs(): PostedJob[] {
    return FakeWorker.instances.flatMap((worker) =>
      worker.jobs.filter((job) => job.tileKey.startsWith("content:")),
    );
  }
}

class FakeBoard implements WidgetTableBoard {
  layoutVersion: number;
  readonly dirtyIds: WidgetId[];
  readonly widgetCount = 1;

  constructor() {
    this.layoutVersion = 1;
    this.dirtyIds = [];
  }

  widgetIdAtFromTop(index: number): WidgetId | undefined {
    return index === 0 ? (FILE_ID as WidgetId) : undefined;
  }

  readWidget(id: WidgetId, out: WidgetRow): WidgetRow {
    if (id !== FILE_ID) throw new RangeError("Unknown widget id.");
    Object.assign(out, {
      x: 0,
      y: 0,
      width: 512,
      height: 512,
      contentScroll: 0,
      maxContentScroll: 0,
      lineCount: 20,
      stackIndex: 0,
    });
    return out;
  }

  drainDirtyWidgets(out: WidgetId[]): number {
    out.length = 0;
    out.push(...this.dirtyIds);
    this.dirtyIds.length = 0;
    return out.length;
  }
}

const SOURCE: TileContentSource = {
  fileId: FILE_ID,
  filePath: FILE_PATH,
  hasText: true,
  contentVersion: 1,
  highlighted: true,
  contentWidth: 512,
  contentHeight: 480,
  palette: ["#fff"],
  baseline: 14,
  lineHeight: 18,
  backgroundColor: "#000",
  headerBackgroundColor: "#111",
  cellsFor: () => encodeRasterCells([]),
  headerCellsFor: () => encodeRasterCells([]),
};

const glEnumValues = new Map<string, number>();
let nextGlEnumValue = 1;

function glEnumValue(name: string): number {
  const existing = glEnumValues.get(name);
  if (existing !== undefined) return existing;
  const value = nextGlEnumValue++;
  glEnumValues.set(name, value);
  return value;
}

const NO_OP_GL = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === "getParameter") {
        return (parameter: number) =>
          parameter === glEnumValue("MAX_TEXTURE_SIZE") ? 16384 : 0;
      }
      if (typeof property === "string" && property.toUpperCase() === property) {
        return glEnumValue(property);
      }
      return () => ({});
    },
  },
) as WebGL2RenderingContext;

const LABEL_SOURCE = {
  identity: FILE_PATH,
  x: 0,
  y: 0,
  width: 120,
  height: 20,
  jobFor: () => ({
    cells: [],
    font: "16px Menlo",
    baseline: 14,
    lineHeight: 18,
    originY: 0,
    backgroundColor: "transparent",
    palette: ["#fff"],
    outlineColor: "#000",
    outlineWidth: 1,
  }),
};

const residencies: TileResidency[] = [];

afterEach(() => {
  for (const residency of residencies) residency.dispose();
  residencies.length = 0;
  FakeWorker.instances.length = 0;
  vi.unstubAllGlobals();
});

function resultFor(job: PostedJob): RasterResult {
  return {
    tileKey: job.tileKey,
    contentVersion: job.contentVersion,
    rasterScale: job.rasterScale,
    bitmap: {
      width: 512,
      height: 512,
      close: () => undefined,
    },
  };
}

function createResidency(
  minimapActive = false,
  textWanted = true,
): TileResidency {
  vi.stubGlobal("Worker", FakeWorker);
  const table = new WidgetTable();
  table.sync(new FakeBoard());
  const residency = new TileResidency(NO_OP_GL, {
    metrics: { narrowAdvance: 8 },
    font: { family: "Menlo", size: 16 },
    viewport: VIEWPORT,
    table,
    tableTexture: {},
    visibleBodies: new VisibleBodyProjection(table),
    titleSourceFor: () => SOURCE,
    labelSourceFor: () => LABEL_SOURCE,
  });
  residency.setFilePaths(new Map([[FILE_ID, FILE_PATH]]));
  residency.setContentSource(FILE_ID, SOURCE);
  residency.setDetailLevel(minimapActive, textWanted);
  residencies.push(residency);
  return residency;
}

function drain(residency: TileResidency, camera: Camera = CAMERA): number {
  return residency.drainTiles(
    camera,
    VIEWPORT,
    BODY_TOP,
    Number.POSITIVE_INFINITY,
  );
}

function demandFor(residency: TileResidency): TileDemand {
  const demand: TileDemand = {
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
  residency.tileDemand(demand);
  return demand;
}

function phase(overrides: Partial<GesturePhase>): GesturePhase {
  return {
    gestureInProgress: true,
    zoomGestureActive: true,
    zoomFocusX: 256,
    zoomFocusY: 256,
    zoomingOut: false,
    gestureEnded: false,
    endedGestureWasZoom: false,
    detailIsMinimap: true,
    zoomingIn: true,
    textThresholdZoom: 1,
    cameraScale: 1,
    ...overrides,
  };
}

describe("TileResidency", () => {
  it(
    "defers the switch to Text until visible content tiles upload",
    deferredSwitch,
  );
  it(
    "reports exit coverage only after the visible body is ready or a raster error occurs",
    exitCoverage,
  );
  it(
    "is unsettled during a zoom or in-flight work and settles at exact Text",
    settledState,
  );
  it(
    "prefetches content when zooming into Minimap but not when zooming out",
    zoomPrefetch,
  );
  it(
    "keeps registrations and content sources across context loss",
    contextLoss,
  );
});

function deferredSwitch(): void {
  const residency = createResidency(false, true);

  drain(residency);
  expect(residency.textReady()).toBe(false);
  expect(demandFor(residency).posted).toBeGreaterThan(0);

  FakeWorker.emitPostedResults();
  expect(residency.textReady()).toBe(false);
  drain(residency);

  expect(residency.textReady()).toBe(true);
}

function exitCoverage(): void {
  const residency = createResidency(false, true);

  drain(residency);
  expect(residency.exitViewCovered(FILE_ID, SOURCE.contentVersion)).toBe(false);
  expect(residency.exitViewCovered("unknown.ts", SOURCE.contentVersion)).toBe(
    false,
  );

  FakeWorker.emitPostedResults();
  drain(residency);
  expect(residency.exitViewCovered(FILE_ID, SOURCE.contentVersion)).toBe(true);

  const failedResidency = createResidency(false, true);
  drain(failedResidency);
  expect(failedResidency.exitViewCovered(FILE_ID, SOURCE.contentVersion)).toBe(
    false,
  );
  const failedWorker = FakeWorker.instances
    .slice(-2)
    .find((worker) => !worker.terminated);
  if (!failedWorker) throw new Error("Expected a live raster worker.");
  failedWorker.emitWorkerError("raster failed");
  expect(failedResidency.exitViewCovered(FILE_ID, SOURCE.contentVersion)).toBe(
    true,
  );
}

function settledState(): void {
  const activeResidency = createResidency(false, true);
  activeResidency.setGesturePhase(phase({}));
  expect(activeResidency.settled()).toBe(false);
  activeResidency.setGesturePhase(
    phase({
      zoomGestureActive: false,
      gestureEnded: true,
      endedGestureWasZoom: false,
    }),
  );
  expect(activeResidency.settled()).toBe(false);

  const residency = createResidency(false, true);
  drain(residency);
  expect(demandFor(residency).inFlight).toBeGreaterThan(0);
  expect(residency.settled()).toBe(false);

  FakeWorker.emitPostedResults();
  drain(residency);
  expect(demandFor(residency).visibleExact).toBe(true);
  expect(residency.settled()).toBe(true);
}

function zoomPrefetch(): void {
  const zoomInResidency = createResidency(true, false);
  zoomInResidency.setGesturePhase(
    phase({ textThresholdZoom: 1, cameraScale: 1 }),
  );
  drain(zoomInResidency);
  expect(demandFor(zoomInResidency).posted).toBeGreaterThan(0);
  const contentJobsAfterZoomIn = FakeWorker.postedContentJobs().length;
  expect(contentJobsAfterZoomIn).toBeGreaterThan(0);

  const zoomOutResidency = createResidency(true, false);
  zoomOutResidency.setGesturePhase(
    phase({ zoomingIn: false, zoomingOut: true }),
  );
  drain(zoomOutResidency);
  expect(FakeWorker.postedContentJobs()).toHaveLength(contentJobsAfterZoomIn);
}

function contextLoss(): void {
  const residency = createResidency(false, true);
  drain(residency);
  FakeWorker.emitPostedResults();
  drain(residency);
  expect(residency.textReady()).toBe(true);

  residency.restore(NO_OP_GL, {});

  expect(residency.isRegistered(FILE_ID)).toBe(true);
  expect(residency.textReady()).toBe(false);
  drain(residency);
  FakeWorker.emitPostedResults();
  drain(residency);
  expect(residency.textReady()).toBe(true);
}
