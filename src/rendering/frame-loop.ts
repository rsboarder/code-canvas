import type { FrameSampleSink, FrameStageTiming } from "../shared/frame";

export interface FrameStage {
  readonly name: string;
  run(): void;
}

export class FrameLoop {
  private frameRequested = false;
  private dirty = true;
  private gesture = false;
  private readonly stageTimings: FrameStageTiming[];
  private readonly sample = {
    frameStartTime: 0,
    stageTimings: [] as FrameStageTiming[],
  };
  private readonly onAnimationFrame = (): void => {
    this.frameRequested = false;
    if (!this.dirty && !this.gesture) return;
    this.dirty = false;
    this.sample.frameStartTime = performance.now();
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
