import type {
  FrameSample,
  FrameSampleSink,
  FrameStage,
  FrameStageTiming,
} from "../shared/frame";

// Fields a stage can attach to this tick's Frame Sample before it is sent
// (the `draw` stage reports the tile pool's metrics this way, since only it
// knows them — design D6 "Tile pool").
export interface FrameMetrics {
  tileMemoryBytes: number;
  missingTile: boolean;
  timeToSharpMs: number;
}

export class FrameLoop {
  private frameRequested = false;
  private dirty = true;
  private gesture = false;
  private afterIdle = false;
  private readonly stageTimings: FrameStageTiming[];
  private readonly sample: {
    frameStartTime: number;
    afterIdle: boolean;
    stageTimings: FrameStageTiming[];
    detailLevel: FrameSample["detailLevel"];
    textSwitchPending: boolean;
    visibleWidgetCount: FrameSample["visibleWidgetCount"];
    residencyBacklogDepth: FrameSample["residencyBacklogDepth"];
  } & FrameMetrics = {
    frameStartTime: 0,
    afterIdle: false,
    stageTimings: [] as FrameStageTiming[],
    detailLevel: undefined,
    textSwitchPending: false,
    visibleWidgetCount: Number.NaN,
    residencyBacklogDepth: Number.NaN,
    tileMemoryBytes: Number.NaN,
    missingTile: false,
    timeToSharpMs: Number.NaN,
  };
  private readonly onAnimationFrame = (): void => {
    this.frameRequested = false;
    if (!this.dirty && !this.gesture) return;
    this.dirty = false;
    this.sample.frameStartTime = performance.now();
    this.sample.afterIdle = this.afterIdle;
    this.afterIdle = false;
    this.sample.detailLevel = undefined;
    this.sample.textSwitchPending = false;
    this.sample.visibleWidgetCount = Number.NaN;
    this.sample.residencyBacklogDepth = Number.NaN;
    this.sample.tileMemoryBytes = Number.NaN;
    this.sample.missingTile = false;
    this.sample.timeToSharpMs = Number.NaN;
    for (let index = 0; index < this.stages.length; index += 1) {
      const stage = this.stages[index];
      const timing = this.stageTimings[index];
      if (!stage || !timing) continue;
      const startedAt = performance.now();
      stage.run();
      timing.durationMs = performance.now() - startedAt;
    }
    this.sampleSink?.(this.sample as FrameSample);
    if (this.gesture) this.schedule();
    if (this.idle) this.afterIdle = true;
  };

  constructor(
    private readonly stages: FrameStage[],
    private readonly sampleSink?: FrameSampleSink,
  ) {
    this.stageTimings = stages.map((stage) => ({
      name: stage.name,
      durationMs: 0,
    }));
    this.sample.stageTimings = this.stageTimings;
  }

  addStage(stage: FrameStage): void {
    this.stages.push(stage);
    this.stageTimings.push({ name: stage.name, durationMs: 0 });
  }

  // Called by a stage's own `run()`, synchronously within the current tick,
  // before `sampleSink` fires at the end of `onAnimationFrame`.
  setFrameMetrics(metrics: FrameMetrics): void {
    this.sample.tileMemoryBytes = metrics.tileMemoryBytes;
    this.sample.missingTile = metrics.missingTile;
    this.sample.timeToSharpMs = metrics.timeToSharpMs;
  }

  setSampleState(
    detailLevel: FrameSample["detailLevel"],
    visibleWidgetCount: number,
    residencyBacklogDepth: number,
    textSwitchPending = false,
  ): void {
    this.sample.detailLevel = detailLevel;
    this.sample.textSwitchPending = textSwitchPending;
    this.sample.visibleWidgetCount = visibleWidgetCount;
    this.sample.residencyBacklogDepth = residencyBacklogDepth;
  }

  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  setGestureInProgress(value: boolean): void {
    this.gesture = value;
    if (value) this.schedule();
  }

  get idle(): boolean {
    return !this.frameRequested && !this.gesture;
  }

  private schedule(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(this.onAnimationFrame);
  }
}
