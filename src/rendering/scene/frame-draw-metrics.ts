export interface FrameDrawMetrics {
  tileMemoryBytes: number;
  missingTile: boolean;
  visibleWidgetCount: number;
  drawnTileCount: number;
  drawnLabelTileCount: number;
  drawnMinimapCount: number;
  drawnFallbackTileCount: number;
  drawnUnhighlightedTileCount: number;
  lowestEpochDrawn: number;
  lowestContentVersion: number;
  timeToSharpMs: number;
}

interface DrawnTileMetrics {
  readonly content: boolean;
  readonly fallback: boolean;
  readonly highlighted: boolean;
  readonly epoch: number;
  readonly contentVersion: number;
}

export function resetFrameDrawMetrics(metrics: FrameDrawMetrics): void {
  metrics.visibleWidgetCount = 0;
  metrics.drawnTileCount = 0;
  metrics.drawnLabelTileCount = 0;
  metrics.drawnMinimapCount = 0;
  metrics.drawnFallbackTileCount = 0;
  metrics.drawnUnhighlightedTileCount = 0;
  metrics.lowestEpochDrawn = -1;
  metrics.lowestContentVersion = -1;
}

export function recordDrawMetrics(
  metrics: FrameDrawMetrics,
  tile: DrawnTileMetrics,
): void {
  metrics.drawnTileCount += 1;
  if (!tile.content) metrics.drawnLabelTileCount += 1;
  if (tile.fallback) metrics.drawnFallbackTileCount += 1;
  if (tile.content && !tile.highlighted) {
    metrics.drawnUnhighlightedTileCount += 1;
  }
  if (metrics.lowestEpochDrawn < 0 || tile.epoch < metrics.lowestEpochDrawn) {
    metrics.lowestEpochDrawn = tile.epoch;
  }
  if (
    metrics.lowestContentVersion < 0 ||
    (tile.contentVersion >= 0 &&
      tile.contentVersion < metrics.lowestContentVersion)
  ) {
    metrics.lowestContentVersion = tile.contentVersion;
  }
}
