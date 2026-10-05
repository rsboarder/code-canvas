import type { SettleState } from "./bridge";

interface TileDemand {
  capacity: number;
  requested: number;
  pinned: number;
  inFlight: number;
  posted: number;
  stale: number;
  uploadFailed: number;
  visibleExact: boolean;
  clockRunning: boolean;
  gestureActive: boolean;
  minimapActive: boolean;
}

interface SettleStateDependencies {
  readonly renderer:
    | {
        tileDemand(out: TileDemand): void;
        settled(): boolean;
      }
    | undefined;
  readonly frameLoop: { readonly idle: boolean } | undefined;
  readonly syntheticLoad: { isActive(): boolean };
  readonly residency: {
    readonly backlogDepth: number;
    readonly tokenizationPendingCount: number;
  };
  readonly textSwitchPending: () => boolean;
}

export function createSettleState(
  dependencies: SettleStateDependencies,
): () => SettleState {
  const demand: TileDemand = {
    capacity: 0,
    requested: 0,
    pinned: 0,
    inFlight: 0,
    posted: 0,
    stale: 0,
    uploadFailed: 0,
    visibleExact: false,
    clockRunning: false,
    gestureActive: false,
    minimapActive: false,
  };
  return () => {
    if (dependencies.renderer) dependencies.renderer.tileDemand(demand);
    else resetTileDemand(demand);
    return {
      frameLoopIdle: dependencies.frameLoop?.idle ?? false,
      syntheticLoadActive: dependencies.syntheticLoad.isActive(),
      tilesSettled: dependencies.renderer?.settled() ?? false,
      residencyBacklog: dependencies.residency.backlogDepth,
      tokenizationPending: dependencies.residency.tokenizationPendingCount,
      textSwitchPending: dependencies.textSwitchPending(),
      tilePoolCapacity: demand.capacity,
      tileRequests: demand.requested,
      tilesPinned: demand.pinned,
      tilesInFlight: demand.inFlight,
      tilesPosted: demand.posted,
      tilesStale: demand.stale,
      tilesUploadFailed: demand.uploadFailed,
      tilesVisibleExact: demand.visibleExact,
      tilesClockRunning: demand.clockRunning,
      tilesGestureActive: demand.gestureActive,
      tilesMinimapActive: demand.minimapActive,
    };
  };
}

function resetTileDemand(demand: TileDemand): void {
  demand.capacity = 0;
  demand.requested = 0;
  demand.pinned = 0;
  demand.inFlight = 0;
  demand.posted = 0;
  demand.stale = 0;
  demand.uploadFailed = 0;
  demand.visibleExact = false;
  demand.clockRunning = false;
  demand.gestureActive = false;
  demand.minimapActive = false;
}
