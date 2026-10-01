export type DetailLevelName = "text" | "minimap";

export interface FrameStageTiming {
  readonly name: string;
  durationMs: number;
}

export interface FrameSample {
  frameStartTime: number;
  readonly stageTimings: readonly FrameStageTiming[];
  detailLevel?: DetailLevelName;
  visibleWidgetCount?: number;
  residencyBacklogDepth?: number;
}

export type FrameSampleSink = (sample: FrameSample) => void;
