import type { FrameStatsSnapshot } from "./frame-stats";
import type { Statistic } from "./frame-statistics";

export {
  countLongIntervals,
  nearestRank,
  UNAVAILABLE,
} from "./frame-statistics";
export type { Statistic } from "./frame-statistics";
// perf/ may only import src/ through this file; re-exporting the pinch gain
// constants keeps the driver's synthetic pinch deltas numerically consistent
// with the product's zoom handler without perf/ reaching into src/shared/.
export {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../shared/pinch";

export interface PerfFile {
  readonly path: string;
  readonly text: string;
}

export interface SettleState {
  readonly frameLoopIdle: boolean;
  readonly syntheticLoadActive: boolean;
  readonly tilesSettled: boolean;
  readonly residencyBacklog: number;
  readonly tokenizationPending: number;
  readonly textSwitchPending: boolean;
  readonly tilePoolCapacity: number;
  readonly tileRequests: number;
  readonly tilesPinned: number;
  readonly tilesInFlight: number;
  readonly tilesPosted: number;
  readonly tilesStale: number;
  readonly tilesUploadFailed: number;
  readonly tilesVisibleExact: boolean;
  readonly tilesClockRunning: boolean;
  readonly tilesGestureActive: boolean;
  readonly tilesMinimapActive: boolean;
}

export interface PerfBridge {
  snapshot(): FrameStatsSnapshot;
  settleState(): SettleState;
  reset(): void;
  nearestRank(values: readonly number[], percentile: number): Statistic;
  countLongIntervals(
    values: readonly number[],
    thresholdMs?: number,
  ): Statistic;
  openFolder(files: readonly PerfFile[]): Promise<void>;
  setCamera(x: number, y: number, scale: number): void;
  camera(): { x: number; y: number; scale: number };
  cameraRange(): { minScale: number; maxScale: number };
  setSyntheticLoad(load: {
    readonly cpuMs: number;
    readonly gpuIterations: number;
  }): void;
  // Resolves once the Editing Session of the widget with this path is visible.
  beginEditing(path: string): Promise<void>;
}

declare global {
  interface Window {
    __perf?: PerfBridge;
  }
}
