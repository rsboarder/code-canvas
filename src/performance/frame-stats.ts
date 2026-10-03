import type { FrameSample } from "../shared/frame";
import {
  UNAVAILABLE,
  countLongIntervals,
  nearestRank,
  type Statistic,
} from "./frame-statistics";

type DetailLevelName = NonNullable<FrameSample["detailLevel"]>;

const DEFAULT_CAPACITY = 240;

export interface FrameStageStats {
  readonly p50: Statistic;
  readonly p95: Statistic;
  readonly p99: Statistic;
  readonly max: Statistic;
}

export interface FrameStatsSnapshot extends FrameStageStats {
  readonly longIntervalCount: Statistic;
  readonly frameCount: number;
  readonly stages: Readonly<Record<string, FrameStageStats>>;
  // Text Tiles metrics (design D6 "Tile pool", "Zoom"): the latest reported
  // tile pool memory footprint and settle duration, and how many sampled
  // frames had a visible tile area with nothing resident at any scale.
  readonly tileMemoryBytes: Statistic;
  readonly missingTileFrameCount: number;
  readonly timeToSharpMs: Statistic;
  readonly textSwitchLagMs: Statistic;
  readonly residencyBacklog: Statistic;
}

interface FrameOverlayMetrics {
  readonly framesPerSecond: number;
  readonly p99IntervalMs: Statistic;
  readonly visibleWidgetCount: Statistic;
  readonly detailLevel: DetailLevelName | typeof UNAVAILABLE;
}

interface StageSamples {
  readonly values: Float64Array;
  readonly present: Uint8Array;
}

export class FrameStats {
  private readonly intervals: Float64Array;
  private readonly intervalPresent: Uint8Array;
  private readonly sampleStartTimes: Float64Array;
  private readonly stageSamples = new Map<string, StageSamples>();
  private readonly stageNames: string[] = [];
  private writeIndex = 0;
  private sampleCount = 0;
  private totalSampleCount = 0;
  private previousFrameStart: number | undefined;
  private latestTileMemoryBytes: number | undefined;
  private missingTileFrameCount = 0;
  private latestTimeToSharpMs: number | undefined;
  private textSwitchPendingStart: number | undefined;
  private previousDetailLevel: FrameSample["detailLevel"];
  private largestTextSwitchLagMs: number | undefined;
  private largestResidencyBacklog: number | undefined;
  private latestDetailLevel: DetailLevelName | undefined;
  private latestVisibleWidgetCount: number | undefined;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("FrameStats capacity must be a positive integer");
    }
    this.intervals = new Float64Array(capacity);
    this.intervalPresent = new Uint8Array(capacity);
    this.sampleStartTimes = new Float64Array(capacity);
  }

  record(sample: FrameSample): void {
    const previous = this.previousFrameStart;
    this.intervalPresent[this.writeIndex] = 0;
    this.sampleStartTimes[this.writeIndex] = sample.frameStartTime;
    if (previous !== undefined && sample.afterIdle !== true) {
      this.intervals[this.writeIndex] = sample.frameStartTime - previous;
      this.intervalPresent[this.writeIndex] = 1;
    }
    this.previousFrameStart = sample.frameStartTime;
    this.clearStageSlots();
    for (const timing of sample.stageTimings) {
      const stage = this.getOrCreateStage(timing.name);
      stage.values[this.writeIndex] = timing.durationMs;
      stage.present[this.writeIndex] = 1;
    }
    if (
      sample.tileMemoryBytes !== undefined &&
      !Number.isNaN(sample.tileMemoryBytes)
    ) {
      this.latestTileMemoryBytes = sample.tileMemoryBytes;
    }
    if (sample.missingTile) this.missingTileFrameCount += 1;
    if (
      sample.timeToSharpMs !== undefined &&
      !Number.isNaN(sample.timeToSharpMs)
    ) {
      this.latestTimeToSharpMs = sample.timeToSharpMs;
    }
    this.recordTextSwitch(sample);
    this.recordLatestViewState(sample);
    if (
      sample.residencyBacklogDepth !== undefined &&
      Number.isFinite(sample.residencyBacklogDepth) &&
      (this.largestResidencyBacklog === undefined ||
        sample.residencyBacklogDepth > this.largestResidencyBacklog)
    ) {
      this.largestResidencyBacklog = sample.residencyBacklogDepth;
    }
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.sampleCount = Math.min(this.sampleCount + 1, this.capacity);
    this.totalSampleCount += 1;
  }

  push(sample: FrameSample): void {
    this.record(sample);
  }

  reset(): void {
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.totalSampleCount = 0;
    this.previousFrameStart = undefined;
    this.latestTileMemoryBytes = undefined;
    this.missingTileFrameCount = 0;
    this.latestTimeToSharpMs = undefined;
    this.textSwitchPendingStart = undefined;
    this.previousDetailLevel = undefined;
    this.largestTextSwitchLagMs = undefined;
    this.largestResidencyBacklog = undefined;
    this.latestDetailLevel = undefined;
    this.latestVisibleWidgetCount = undefined;
  }

  snapshot(): FrameStatsSnapshot {
    const intervals = this.collectIntervals();
    const stages: Record<string, FrameStageStats> = {};
    for (const name of this.stageNames) {
      const values = this.collectStage(name);
      if (values.length > 0) stages[name] = summarize(values);
    }
    return {
      ...summarize(intervals),
      longIntervalCount: countLongIntervals(intervals),
      frameCount: this.totalSampleCount,
      stages,
      tileMemoryBytes: this.latestTileMemoryBytes ?? UNAVAILABLE,
      missingTileFrameCount: this.missingTileFrameCount,
      timeToSharpMs: this.latestTimeToSharpMs ?? UNAVAILABLE,
      textSwitchLagMs: this.largestTextSwitchLagMs ?? UNAVAILABLE,
      residencyBacklog: this.largestResidencyBacklog ?? UNAVAILABLE,
    };
  }

  overlayMetrics(now: number): FrameOverlayMetrics {
    let framesPerSecond = 0;
    const earliest = now - 1000;
    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      const index =
        (this.writeIndex - this.sampleCount + offset + this.capacity) %
        this.capacity;
      const startTime = this.sampleStartTimes[index];
      if (
        startTime !== undefined &&
        startTime >= earliest &&
        startTime <= now
      ) {
        framesPerSecond += 1;
      }
    }
    return {
      framesPerSecond,
      p99IntervalMs: this.snapshot().p99,
      visibleWidgetCount: this.latestVisibleWidgetCount ?? UNAVAILABLE,
      detailLevel: this.latestDetailLevel ?? UNAVAILABLE,
    };
  }

  private clearStageSlots(): void {
    for (const stage of this.stageSamples.values()) {
      stage.present[this.writeIndex] = 0;
    }
  }

  private recordLatestViewState(sample: FrameSample): void {
    if (sample.detailLevel !== undefined) {
      this.latestDetailLevel = sample.detailLevel;
    }
    if (
      sample.visibleWidgetCount !== undefined &&
      !Number.isNaN(sample.visibleWidgetCount)
    ) {
      this.latestVisibleWidgetCount = sample.visibleWidgetCount;
    }
  }

  private recordTextSwitch(sample: FrameSample): void {
    if (
      sample.textSwitchPending === true &&
      this.textSwitchPendingStart === undefined
    ) {
      this.textSwitchPendingStart = sample.frameStartTime;
    }
    if (
      sample.detailLevel === "text" &&
      this.textSwitchPendingStart !== undefined
    ) {
      const lag = sample.frameStartTime - this.textSwitchPendingStart;
      if (
        this.largestTextSwitchLagMs === undefined ||
        lag > this.largestTextSwitchLagMs
      ) {
        this.largestTextSwitchLagMs = lag;
      }
      this.textSwitchPendingStart = undefined;
    } else if (
      sample.detailLevel === "text" &&
      this.previousDetailLevel === "minimap"
    ) {
      this.largestTextSwitchLagMs ??= 0;
    } else if (
      sample.detailLevel === "minimap" &&
      sample.textSwitchPending === false &&
      this.textSwitchPendingStart !== undefined
    ) {
      this.textSwitchPendingStart = undefined;
    }
    if (sample.detailLevel !== undefined) {
      this.previousDetailLevel = sample.detailLevel;
    }
  }

  private getOrCreateStage(name: string): StageSamples {
    const existing = this.stageSamples.get(name);
    if (existing) return existing;
    const created = {
      values: new Float64Array(this.capacity),
      present: new Uint8Array(this.capacity),
    };
    this.stageSamples.set(name, created);
    this.stageNames.push(name);
    return created;
  }

  private collectIntervals(): number[] {
    const values: number[] = [];
    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      const index =
        (this.writeIndex - this.sampleCount + offset + this.capacity) %
        this.capacity;
      if (this.intervalPresent[index] === 1) {
        values.push(this.intervals[index] ?? 0);
      }
    }
    return values;
  }

  private collectStage(name: string): number[] {
    const stage = this.stageSamples.get(name);
    if (!stage) return [];
    const values: number[] = [];
    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      const index =
        (this.writeIndex - this.sampleCount + offset + this.capacity) %
        this.capacity;
      if (stage.present[index] === 1) {
        const value = stage.values[index];
        if (value !== undefined) values.push(value);
      }
    }
    return values;
  }
}

function summarize(values: readonly number[]): FrameStageStats {
  if (values.length === 0) {
    return {
      p50: UNAVAILABLE,
      p95: UNAVAILABLE,
      p99: UNAVAILABLE,
      max: UNAVAILABLE,
    };
  }
  return {
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    max: Math.max(...values),
  };
}
