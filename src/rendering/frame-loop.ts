import type { FrameSampleSink, FrameStageTiming } from "../shared/frame";

export interface FrameStage {
  readonly name: string;
  run(): void;
}

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
  private readonly stageTimings: FrameStageTiming[];
  private readonly sample: {
    frameStartTime: number;
    stageTimings: FrameStageTiming[];
  } & FrameMetrics = {
    frameStartTime: 0,
    stageTimings: [] as FrameStageTiming[],
    tileMemoryBytes: Number.NaN,
    missingTile: false,
    timeToSharpMs: Number.NaN,
  };
  private readonly onAnimationFrame = (): void => {
    this.frameRequested = false;
    if (!this.dirty && !this.gesture) return;
    this.dirty = false;
    this.sample.frameStartTime = performance.now();
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
    this.sampleSink?.(this.sample);
    if (this.gesture) this.schedule();
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

  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  setGestureInProgress(value: boolean): void {
    this.gesture = value;
    if (value) this.schedule();
  }

  private schedule(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(this.onAnimationFrame);
  }
}
