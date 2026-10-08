export type DetailLevelName = "text" | "minimap";

export interface FrameStage {
  readonly name: string;
  run(): boolean;
}

export interface FrameStageTiming {
  readonly name: string;
  durationMs: number;
}

export interface FrameSample {
  frameStartTime: number;
  afterIdle?: boolean;
  readonly stageTimings: readonly FrameStageTiming[];
  detailLevel?: DetailLevelName;
  textSwitchPending?: boolean;
  visibleWidgetCount?: number;
  totalWidgetCount?: number;
  cameraZoom?: number;
  residencyBacklogDepth?: number;
  // Text Tiles metrics (design D6 "Tile pool", "Zoom"): the tile pool's
  // current GPU memory footprint, whether a visible tile area has no
  // resident tile at any scale this frame, and — only on the frame a zoom
  // settle finishes — the gesture-end-to-sharp duration.
  tileMemoryBytes?: number;
  missingTile?: boolean;
  timeToSharpMs?: number;
  textWeight?: number;
  drawnTileCount?: number;
  drawnFallbackTileCount?: number;
  tilePoolSlotsInUse?: number;
  tilePoolCapacity?: number;
  rasterJobsInFlight?: number;
  rasterJobsPostedTotal?: number;
}

export type FrameSampleSink = (sample: FrameSample) => void;
