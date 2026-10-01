import type { FrameStatsSnapshot } from "./frame-stats";
import type { Statistic } from "./frame-statistics";

export {
  countLongIntervals,
  nearestRank,
  UNAVAILABLE,
} from "./frame-statistics";
export type { Statistic } from "./frame-statistics";

export interface PerfFile {
  readonly path: string;
  readonly text: string;
}

export interface PerfBridge {
  snapshot(): FrameStatsSnapshot;
  reset(): void;
  nearestRank(values: readonly number[], percentile: number): Statistic;
  countLongIntervals(
    values: readonly number[],
    thresholdMs?: number,
  ): Statistic;
  openFolder(files: readonly PerfFile[]): Promise<void>;
  setCamera(x: number, y: number, scale: number): void;
  setSyntheticLoad(load: {
    readonly cpuMs: number;
    readonly gpuIterations: number;
  }): void;
}

declare global {
  interface Window {
    __perf?: PerfBridge;
  }
}
