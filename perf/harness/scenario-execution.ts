import type { CDPSession, Page } from "@playwright/test";

import { runEvents, planEvents } from "./driver";
import { bridgeMetricsFromSnapshot, type BridgeMetrics } from "./metrics";
import {
  SETTLE_TIMEOUT_MS,
  unsettledDetail,
  waitForSettledApplication,
} from "./settle";
import {
  cameraForScenario,
  cameraRangeWithinTolerance,
  cameraWithinTolerance,
  plannedScaleExtremes,
  type CameraState,
  type ScaleRange,
} from "./planned-camera";
import type {
  CameraCheck,
  CameraRangeCheck,
  GestureTiming,
  HarnessMode,
  ScenarioRunMetrics,
} from "./report";
import {
  classifyTrace,
  recordTrace,
  type InvalidMeasurement,
  type TraceClassification,
  type TraceEvents,
  type TraceMetrics,
} from "./trace";
import type { Scenario } from "../scenarios/schema";

// A scenario replay that takes much longer than planned is not honestly
// measuring the budgeted interaction; 1.5x leaves room for scheduling noise
// without hiding a driver that serializes its gesture.
const GESTURE_WALL_TIME_RATIO_LIMIT = 1.5;

interface ScenarioExecution {
  readonly valid: true;
  readonly metrics: ScenarioRunMetrics;
  readonly trace: TraceEvents;
}

export async function runScenario(
  page: Page,
  cdp: CDPSession,
  scenario: Scenario,
  mode: HarnessMode,
): Promise<ScenarioExecution | InvalidMeasurement> {
  const events = planEvents(scenario, 120);
  const bridgeAvailable = await page.evaluate(
    () => typeof window.__perf?.snapshot === "function",
  );
  if (!bridgeAvailable) return { valid: false, reason: "app-bridge-missing" };
  await page.evaluate(() => window.__perf?.reset());

  let gestureWallTimeMs = 0;
  let result: TraceEvents;
  try {
    result = await recordTrace(cdp, async () => {
      gestureWallTimeMs = await runEvents(cdp, events);
    });
  } catch (error: unknown) {
    return {
      valid: false,
      reason: "gesture-dispatch-failed",
      detail: `${scenario.name}: ${errorMessage(error)}`,
    };
  }

  const bridgeMetrics = await readBridgeMetrics(page);

  const gesture = gestureTiming(gestureWallTimeMs, scenario.durationMs);
  if (gesture.ratio > GESTURE_WALL_TIME_RATIO_LIMIT)
    return {
      valid: false,
      reason: "gesture-wall-time-exceeded",
      detail:
        `${scenario.name}: gesture wall time ${gesture.wallTimeMs.toFixed(1)} ms ` +
        `exceeds ${String(GESTURE_WALL_TIME_RATIO_LIMIT)}x the planned ${String(scenario.durationMs)} ms`,
    };

  const settledBridgeMetrics = await readSettledBridgeMetrics(page, scenario);
  if ("valid" in settledBridgeMetrics) return settledBridgeMetrics;
  const metrics =
    settledBridgeMetrics.timeToSharpMs === undefined
      ? bridgeMetrics
      : {
          ...bridgeMetrics,
          timeToSharpMs: settledBridgeMetrics.timeToSharpMs,
        };

  const { camera, cameraRange } = await evaluateCameraChecks(page, scenario);
  const cameraError = cameraFailure(scenario, camera, cameraRange);
  if (cameraError) return cameraError;

  const classified = await classifyTrace(result, {
    applicationMarkers: ["127.0.0.1", "localhost"],
    bridgeMetrics: metrics,
  });
  if (mode === "stages")
    return stageClassification(classified, result, metrics, {
      gesture,
      camera,
      cameraRange,
    });
  if (!classified.valid) return classified;
  return {
    valid: true,
    metrics: {
      ...scenarioRunMetricsFromTrace(classified, metrics),
      gesture,
      camera,
      cameraRange,
    },
    trace: result,
  };
}

async function readSettledBridgeMetrics(
  page: Page,
  scenario: Scenario,
): Promise<BridgeMetrics | InvalidMeasurement> {
  const settled = await waitForSettledApplication(page, SETTLE_TIMEOUT_MS);
  if (!settled.settled)
    return {
      valid: false,
      reason: "app-not-settled",
      detail: unsettledDetail(scenario.name, "after the gesture", settled),
    };
  return readBridgeMetrics(page);
}

function cameraFailure(
  scenario: Scenario,
  camera: CameraCheck,
  cameraRange: CameraRangeCheck,
): InvalidMeasurement | undefined {
  if (camera.checked && !camera.withinTolerance)
    return {
      valid: false,
      reason: "camera-mismatch",
      detail:
        `${scenario.name}: final camera ${JSON.stringify(camera.actual)} ` +
        `does not match planned ${JSON.stringify(camera.planned)}`,
    };
  if (cameraRange.checked && !cameraRange.withinTolerance)
    return {
      valid: false,
      reason: "camera-range-mismatch",
      detail:
        `${scenario.name}: recorded scale range ${JSON.stringify(cameraRange.recorded)} ` +
        `does not match planned ${JSON.stringify(cameraRange.planned)}`,
    };
  return undefined;
}

export function scenarioRunMetricsWithBridge(
  metrics: ScenarioRunMetrics,
  bridge: BridgeMetrics,
): ScenarioRunMetrics {
  return {
    ...metrics,
    tileMemoryBytes: bridge.tileMemoryBytes ?? "unavailable",
    missingTileFrameCount: bridge.missingTileFrameCount ?? 0,
    timeToSharpMs: bridge.timeToSharpMs ?? "unavailable",
    textSwitchLagMs: bridge.textSwitchLagMs ?? "unavailable",
    residencyBacklog: bridge.residencyBacklog,
  };
}

function gestureTiming(
  wallTimeMs: number,
  plannedDurationMs: number,
): GestureTiming {
  return {
    wallTimeMs,
    plannedDurationMs,
    ratio: wallTimeMs / plannedDurationMs,
  };
}

interface CameraChecks {
  readonly camera: CameraCheck;
  readonly cameraRange: CameraRangeCheck;
}

async function evaluateCameraChecks(
  page: Page,
  scenario: Scenario,
): Promise<CameraChecks> {
  const initial = scenario.setup.camera;
  const planned = cameraForScenario(scenario);
  if (!initial || !planned)
    return { camera: { checked: false }, cameraRange: { checked: false } };

  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );

  const actual = (await page.evaluate(() => window.__perf?.camera())) as
    CameraState | undefined;
  const camera: CameraCheck = actual
    ? {
        checked: true,
        planned,
        actual,
        withinTolerance: cameraWithinTolerance(initial, planned, actual),
      }
    : { checked: true, planned, withinTolerance: false };

  const plannedRange = plannedScaleExtremes(initial, scenario.steps);
  const recorded = (await page.evaluate(() => window.__perf?.cameraRange())) as
    ScaleRange | undefined;
  const cameraRange: CameraRangeCheck = recorded
    ? {
        checked: true,
        planned: plannedRange,
        recorded,
        withinTolerance: cameraRangeWithinTolerance(plannedRange, recorded),
      }
    : { checked: true, planned: plannedRange, withinTolerance: false };

  return { camera, cameraRange };
}

interface ScenarioChecks {
  readonly gesture: GestureTiming;
  readonly camera: CameraCheck;
  readonly cameraRange: CameraRangeCheck;
}

function stageClassification(
  classified: TraceClassification,
  trace: TraceEvents,
  bridge: BridgeMetrics,
  checks: ScenarioChecks,
): ScenarioExecution {
  const { gesture, camera, cameraRange } = checks;
  if (classified.valid)
    return {
      valid: true,
      metrics: {
        ...scenarioRunMetricsFromTrace(classified, bridge, false),
        gesture,
        camera,
        cameraRange,
      },
      trace,
    };
  const tasks = trace.filter(
    (event) => event.name === "RunTask" && typeof event.dur === "number",
  );
  const longest = tasks.reduce(
    (max, event) => Math.max(max, (event.dur ?? 0) / 1_000),
    0,
  );
  return {
    valid: true,
    metrics: {
      ...scenarioRunMetricsWithBridge(
        {
          applicationTaskMs: longest,
          p99: "unavailable",
          droppedFrames: 0,
          partiallyPresentedFrames: 0,
          longIntervals: 0,
          stages: bridge.stages,
        },
        bridge,
      ),
      gesture,
      camera,
      cameraRange,
    },
    trace,
  };
}

async function readBridgeMetrics(page: Page): Promise<BridgeMetrics> {
  const snapshot = await page.evaluate(() => window.__perf?.snapshot());
  return bridgeMetricsFromSnapshot(snapshot);
}

export function scenarioRunMetricsFromTrace(
  metrics: TraceMetrics,
  bridge: BridgeMetrics,
  includeFrameCounts = true,
): ScenarioRunMetrics {
  const scenarioMetrics = scenarioRunMetricsWithBridge(
    {
      applicationTaskMs: metrics.longestApplicationTaskMs,
      p99: metrics.intervalsMs.p99,
      droppedFrames: metrics.frames.dropped,
      partiallyPresentedFrames: metrics.frames.partiallyPresented,
      longIntervals:
        typeof metrics.intervalsOver12_5Ms === "number"
          ? metrics.intervalsOver12_5Ms
          : 0,
      stages: metrics.stages,
    },
    bridge,
  );
  if (!includeFrameCounts) return scenarioMetrics;
  return {
    ...scenarioMetrics,
    frames: {
      trace: metrics.traceFrames,
      window: metrics.frames,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
