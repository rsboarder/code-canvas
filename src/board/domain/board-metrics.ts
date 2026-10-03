export interface BoardMetrics {
  readonly baseLineHeight: number;
  readonly headerHeight: number;
  readonly minimumWidth: number;
  readonly minimumBodyLines: number;
  readonly columnWidth: number;
  readonly gridGap: number;
  readonly maximumHeight: number;
  readonly edgeGrabScreenPx: number;
}

export function minimumHeight(metrics: BoardMetrics): number {
  return (
    metrics.headerHeight + metrics.minimumBodyLines * metrics.baseLineHeight
  );
}
