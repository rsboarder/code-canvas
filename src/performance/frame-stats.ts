import type { FrameSample } from "../shared/frame";
import {
  UNAVAILABLE,
  countLongIntervals,
  nearestRank,
  type Statistic,
} from "./frame-statistics";

type DetailLevelName = NonNullable<FrameSample["detailLevel"]>;

const DEFAULT_CAPACITY = 240;
const OVERLAY_WINDOW_MS = 2000;
const JOB_RATE_WINDOW_MS = 1000;

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
  readonly p50IntervalMs: Statistic;
  readonly p99IntervalMs: Statistic;
  readonly droppedFrames: Statistic;
  readonly worstTickMs: Statistic;
  readonly visibleWidgetCount: Statistic;
  readonly totalWidgetCount: Statistic;
  readonly detailLevel: DetailLevelName | typeof UNAVAILABLE;
  readonly textWeight: Statistic;
  readonly stages: Readonly<Record<string, FrameStageStats>>;
  readonly tilePoolSlotsInUse: Statistic;
  readonly tilePoolCapacity: Statistic;
  readonly tileMemoryBytes: Statistic;
  readonly rasterJobsInFlight: Statistic;
  readonly rasterJobsPostedPerSecond: Statistic;
  readonly drawnTileCount: Statistic;
  readonly drawnFallbackTileCount: Statistic;
  readonly timeToSharpMs: Statistic;
  readonly residencyBacklog: Statistic;
  readonly cameraZoom: Statistic;
}

interface StageSamples {
  readonly values: Float64Array;
  readonly present: Uint8Array;
}

export class FrameStats {
  private readonly intervals: Float64Array;
  private readonly intervalPresent: Uint8Array;
  private readonly sampleStartTimes: Float64Array;
  private readonly tickDurations: Float64Array;
  private readonly textWeights: Float64Array;
  private readonly totalWidgetCounts: Float64Array;
  private readonly cameraZooms: Float64Array;
  private readonly tilePoolSlotsInUse: Float64Array;
  private readonly tilePoolCapacities: Float64Array;
  private readonly rasterJobsInFlight: Float64Array;
  private readonly rasterJobsPostedTotals: Float64Array;
  private readonly drawnTileCounts: Float64Array;
  private readonly drawnFallbackTileCounts: Float64Array;
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
  private latestResidencyBacklog: number | undefined;
  private latestDetailLevel: DetailLevelName | undefined;
  private latestVisibleWidgetCount: number | undefined;
  private latestTextWeight: number | undefined;
  private latestTotalWidgetCount: number | undefined;
  private latestCameraZoom: number | undefined;
  private latestTilePoolSlotsInUse: number | undefined;
  private latestTilePoolCapacity: number | undefined;
  private latestRasterJobsInFlight: number | undefined;
  private latestDrawnTileCount: number | undefined;
  private latestDrawnFallbackTileCount: number | undefined;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("FrameStats capacity must be a positive integer");
    }
    this.intervals = new Float64Array(capacity);
    this.intervalPresent = new Uint8Array(capacity);
    this.sampleStartTimes = new Float64Array(capacity);
    this.tickDurations = new Float64Array(capacity);
    this.textWeights = new Float64Array(capacity);
    this.totalWidgetCounts = new Float64Array(capacity);
    this.cameraZooms = new Float64Array(capacity);
    this.tilePoolSlotsInUse = new Float64Array(capacity);
    this.tilePoolCapacities = new Float64Array(capacity);
    this.rasterJobsInFlight = new Float64Array(capacity);
    this.rasterJobsPostedTotals = new Float64Array(capacity);
    this.drawnTileCounts = new Float64Array(capacity);
    this.drawnFallbackTileCounts = new Float64Array(capacity);
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
    this.resetMetricSlots();
    this.tickDurations[this.writeIndex] = stageDuration(sample.stageTimings);
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
    if (
      sample.residencyBacklogDepth !== undefined &&
      Number.isFinite(sample.residencyBacklogDepth)
    ) {
      this.latestResidencyBacklog = sample.residencyBacklogDepth;
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
    this.latestResidencyBacklog = undefined;
    this.latestDetailLevel = undefined;
    this.latestVisibleWidgetCount = undefined;
    this.latestTextWeight = undefined;
    this.latestTotalWidgetCount = undefined;
    this.latestCameraZoom = undefined;
    this.latestTilePoolSlotsInUse = undefined;
    this.latestTilePoolCapacity = undefined;
    this.latestRasterJobsInFlight = undefined;
    this.latestDrawnTileCount = undefined;
    this.latestDrawnFallbackTileCount = undefined;
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
    const intervals = this.collectRecentIntervals(now);
    const frameStats = summarize(intervals);
    const stages = this.recentStageStats(now);
    return {
      framesPerSecond: this.countRecentFrames(now),
      p50IntervalMs: frameStats.p50,
      p99IntervalMs: frameStats.p99,
      droppedFrames: countLongIntervals(intervals),
      worstTickMs: this.maxRecentMetric(this.tickDurations, now),
      ...this.latestViewMetrics(),
      stages,
      ...this.latestTileMetrics(),
      rasterJobsInFlight: this.latestRasterJobsInFlight ?? UNAVAILABLE,
      rasterJobsPostedPerSecond: this.jobsPostedPerSecond(now),
      ...this.latestDrawMetrics(),
    };
  }

  private latestViewMetrics(): Pick<
    FrameOverlayMetrics,
    "visibleWidgetCount" | "totalWidgetCount" | "detailLevel" | "textWeight"
  > {
    return {
      visibleWidgetCount: this.latestVisibleWidgetCount ?? UNAVAILABLE,
      totalWidgetCount: this.latestTotalWidgetCount ?? UNAVAILABLE,
      detailLevel: this.latestDetailLevel ?? UNAVAILABLE,
      textWeight: this.latestTextWeight ?? UNAVAILABLE,
    };
  }

  private latestTileMetrics(): Pick<
    FrameOverlayMetrics,
    "tilePoolSlotsInUse" | "tilePoolCapacity" | "tileMemoryBytes"
  > {
    return {
      tilePoolSlotsInUse: this.latestTilePoolSlotsInUse ?? UNAVAILABLE,
      tilePoolCapacity: this.latestTilePoolCapacity ?? UNAVAILABLE,
      tileMemoryBytes: this.latestTileMemoryBytes ?? UNAVAILABLE,
    };
  }

  private latestDrawMetrics(): Pick<
    FrameOverlayMetrics,
    | "drawnTileCount"
    | "drawnFallbackTileCount"
    | "timeToSharpMs"
    | "residencyBacklog"
    | "cameraZoom"
  > {
    return {
      drawnTileCount: this.latestDrawnTileCount ?? UNAVAILABLE,
      drawnFallbackTileCount: this.latestDrawnFallbackTileCount ?? UNAVAILABLE,
      timeToSharpMs: this.latestTimeToSharpMs ?? UNAVAILABLE,
      residencyBacklog: this.latestResidencyBacklog ?? UNAVAILABLE,
      cameraZoom: this.latestCameraZoom ?? UNAVAILABLE,
    };
  }

  private recentStageStats(
    now: number,
  ): Readonly<Record<string, FrameStageStats>> {
    const stages: Record<string, FrameStageStats> = {};
    for (const name of this.stageNames) {
      const values = this.collectRecentStage(name, now);
      if (values.length > 0) stages[name] = summarize(values);
    }
    return stages;
  }

  private resetMetricSlots(): void {
    this.tickDurations[this.writeIndex] = Number.NaN;
    this.textWeights[this.writeIndex] = Number.NaN;
    this.totalWidgetCounts[this.writeIndex] = Number.NaN;
    this.cameraZooms[this.writeIndex] = Number.NaN;
    this.tilePoolSlotsInUse[this.writeIndex] = Number.NaN;
    this.tilePoolCapacities[this.writeIndex] = Number.NaN;
    this.rasterJobsInFlight[this.writeIndex] = Number.NaN;
    this.rasterJobsPostedTotals[this.writeIndex] = Number.NaN;
    this.drawnTileCounts[this.writeIndex] = Number.NaN;
    this.drawnFallbackTileCounts[this.writeIndex] = Number.NaN;
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
    const textWeight = this.recordMetric(sample.textWeight, this.textWeights);
    if (textWeight !== undefined) this.latestTextWeight = textWeight;
    const totalWidgetCount = this.recordMetric(
      sample.totalWidgetCount,
      this.totalWidgetCounts,
    );
    if (totalWidgetCount !== undefined)
      this.latestTotalWidgetCount = totalWidgetCount;
    const cameraZoom = this.recordMetric(sample.cameraZoom, this.cameraZooms);
    if (cameraZoom !== undefined) this.latestCameraZoom = cameraZoom;
    const slotsInUse = this.recordMetric(
      sample.tilePoolSlotsInUse,
      this.tilePoolSlotsInUse,
    );
    if (slotsInUse !== undefined) this.latestTilePoolSlotsInUse = slotsInUse;
    const poolCapacity = this.recordMetric(
      sample.tilePoolCapacity,
      this.tilePoolCapacities,
    );
    if (poolCapacity !== undefined) this.latestTilePoolCapacity = poolCapacity;
    const jobsInFlight = this.recordMetric(
      sample.rasterJobsInFlight,
      this.rasterJobsInFlight,
    );
    if (jobsInFlight !== undefined)
      this.latestRasterJobsInFlight = jobsInFlight;
    this.recordMetric(
      sample.rasterJobsPostedTotal,
      this.rasterJobsPostedTotals,
    );
    const drawnTiles = this.recordMetric(
      sample.drawnTileCount,
      this.drawnTileCounts,
    );
    if (drawnTiles !== undefined) this.latestDrawnTileCount = drawnTiles;
    const drawnFallbackTiles = this.recordMetric(
      sample.drawnFallbackTileCount,
      this.drawnFallbackTileCounts,
    );
    if (drawnFallbackTiles !== undefined)
      this.latestDrawnFallbackTileCount = drawnFallbackTiles;
  }

  private recordMetric(
    value: number | undefined,
    target: Float64Array,
  ): number | undefined {
    const finite = finiteMetric(value);
    target[this.writeIndex] = finite ?? Number.NaN;
    return finite;
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

  private collectRecentIntervals(now: number): number[] {
    const values: number[] = [];
    this.forEachRecentIndex(now, (index) => {
      if (this.intervalPresent[index] === 1)
        values.push(this.intervals[index] ?? 0);
    });
    return values;
  }

  private collectRecentStage(name: string, now: number): number[] {
    const stage = this.stageSamples.get(name);
    if (!stage) return [];
    const values: number[] = [];
    this.forEachRecentIndex(now, (index) => {
      if (stage.present[index] === 1) values.push(stage.values[index] ?? 0);
    });
    return values;
  }

  private maxRecentMetric(values: Float64Array, now: number): Statistic {
    let maximum: number | undefined;
    this.forEachRecentIndex(now, (index) => {
      const value = values[index] ?? Number.NaN;
      if (Number.isFinite(value) && (maximum === undefined || value > maximum))
        maximum = value;
    });
    return maximum ?? UNAVAILABLE;
  }

  private jobsPostedPerSecond(now: number): Statistic {
    let firstTime: number | undefined;
    let firstValue: number | undefined;
    let latestTime: number | undefined;
    let latestValue: number | undefined;
    const earliest = now - JOB_RATE_WINDOW_MS;
    this.forEachIndex((index) => {
      const time = this.sampleStartTimes[index] ?? Number.NaN;
      const value = this.rasterJobsPostedTotals[index];
      if (
        time < earliest ||
        time > now ||
        !Number.isFinite(value) ||
        !Number.isFinite(time)
      )
        return;
      firstTime ??= time;
      firstValue ??= value;
      latestTime = time;
      latestValue = value;
    });
    if (
      firstTime === undefined ||
      firstValue === undefined ||
      latestTime === undefined ||
      latestValue === undefined ||
      latestTime <= firstTime
    )
      return UNAVAILABLE;
    return (
      (Math.max(0, latestValue - firstValue) * 1000) / (latestTime - firstTime)
    );
  }

  private countRecentFrames(now: number): number {
    let count = 0;
    this.forEachRecentIndex(
      now,
      () => {
        count += 1;
      },
      1000,
    );
    return count;
  }

  private forEachRecentIndex(
    now: number,
    visit: (index: number) => void,
    windowMs = OVERLAY_WINDOW_MS,
  ): void {
    const earliest = now - windowMs;
    this.forEachIndex((index) => {
      const startTime = this.sampleStartTimes[index] ?? Number.NaN;
      if (startTime >= earliest && startTime <= now) visit(index);
    });
  }

  private forEachIndex(visit: (index: number) => void): void {
    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      const index =
        (this.writeIndex - this.sampleCount + offset + this.capacity) %
        this.capacity;
      visit(index);
    }
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

function finiteMetric(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function stageDuration(timings: readonly { durationMs: number }[]): number {
  let total = 0;
  for (const timing of timings) total += timing.durationMs;
  return total;
}
