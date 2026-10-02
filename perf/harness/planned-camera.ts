import type { Scenario, ScenarioStep } from "../scenarios/schema";

export interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

// perf/ cannot import src/board/domain/camera.ts (it may only reach src/
// through src/performance/bridge.ts), so this mirrors Camera.pan and
// Camera.zoomToward's arithmetic instead of sharing it.
const CAMERA_MIN_SCALE = 0.05;
const CAMERA_MAX_SCALE = 4.0;

export function plannedCamera(
  initial: CameraState,
  steps: readonly ScenarioStep[],
): CameraState {
  return steps.reduce(applyStep, initial);
}

export interface ScaleRange {
  readonly minScale: number;
  readonly maxScale: number;
}

// A round trip (e.g. pinch out then back in) can end exactly where it
// started, so the final camera alone can't catch a product that never
// zoomed; this walks the same planned steps and tracks the scale extremes
// along the way, including the starting scale.
export function plannedScaleExtremes(
  initial: CameraState,
  steps: readonly ScenarioStep[],
): ScaleRange {
  let camera = initial;
  let minScale = camera.scale;
  let maxScale = camera.scale;
  for (const step of steps) {
    camera = applyStep(camera, step);
    minScale = Math.min(minScale, camera.scale);
    maxScale = Math.max(maxScale, camera.scale);
  }
  return { minScale, maxScale };
}

function applyStep(camera: CameraState, step: ScenarioStep): CameraState {
  if (step.kind === "pan") return applyPan(camera, step);
  if (step.kind === "pinch") return applyPinch(camera, step);
  return camera;
}

function applyPan(
  camera: CameraState,
  step: Extract<ScenarioStep, { kind: "pan" }>,
): CameraState {
  // GestureInput negates the wheel delta before accumulating a pan
  // (panX -= event.deltaX), and Camera.pan adds that pan directly to the
  // offset, so a pan step's screen delta subtracts from the camera offset.
  return { ...camera, x: camera.x - step.dx, y: camera.y - step.dy };
}

function applyPinch(
  camera: CameraState,
  step: Extract<ScenarioStep, { kind: "pinch" }>,
): CameraState {
  const nextScale = clampScale(camera.scale * step.scaleFactor);
  const boardX = (step.x - camera.x) / camera.scale;
  const boardY = (step.y - camera.y) / camera.scale;
  return {
    scale: nextScale,
    x: step.x - boardX * nextScale,
    y: step.y - boardY * nextScale,
  };
}

function clampScale(scale: number): number {
  return Math.min(CAMERA_MAX_SCALE, Math.max(CAMERA_MIN_SCALE, scale));
}

const CAMERA_SCALE_TOLERANCE = 0.02;
const CAMERA_POSITION_TOLERANCE = 0.02;
const CAMERA_POSITION_TOLERANCE_PX = 2;

export function cameraWithinTolerance(
  initial: CameraState,
  planned: CameraState,
  actual: CameraState,
): boolean {
  const scaleOk = withinRelativeTolerance(actual.scale, planned.scale);
  const displacement = Math.hypot(planned.x - initial.x, planned.y - initial.y);
  const positionTolerance = Math.max(
    displacement * CAMERA_POSITION_TOLERANCE,
    CAMERA_POSITION_TOLERANCE_PX,
  );
  const positionError = Math.hypot(actual.x - planned.x, actual.y - planned.y);
  return scaleOk && positionError <= positionTolerance;
}

export function cameraRangeWithinTolerance(
  planned: ScaleRange,
  recorded: ScaleRange,
): boolean {
  return (
    withinRelativeTolerance(recorded.minScale, planned.minScale) &&
    withinRelativeTolerance(recorded.maxScale, planned.maxScale)
  );
}

function withinRelativeTolerance(actual: number, planned: number): boolean {
  return Math.abs(actual - planned) <= planned * CAMERA_SCALE_TOLERANCE;
}

export function cameraForScenario(scenario: Scenario): CameraState | undefined {
  const initial = scenario.setup.camera;
  if (!initial) return undefined;
  return plannedCamera(initial, scenario.steps);
}
