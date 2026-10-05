export interface WidgetTileFrameState {
  epoch: number;
  zoomGestureActive: boolean;
  atRestScale: number;
  contentWidth: number;
  contentHeight: number;
  headerHeight: number;
  contentScroll: number;
  visibleLeft: number;
  visibleTop: number;
  visibleRight: number;
  visibleBottom: number;
  visibleFirstColumn: number;
  visibleLastColumn: number;
  visibleFirstRow: number;
  visibleLastRow: number;
  labelIdentity: string | undefined;
  gestureTargetScale: number;
  recordCount: number;
}

export function createWidgetTileFrameState(): WidgetTileFrameState {
  return {
    epoch: 0,
    zoomGestureActive: false,
    atRestScale: 1,
    contentWidth: 0,
    contentHeight: 0,
    headerHeight: 0,
    contentScroll: 0,
    visibleLeft: 0,
    visibleTop: 0,
    visibleRight: 0,
    visibleBottom: 0,
    visibleFirstColumn: 0,
    visibleLastColumn: -1,
    visibleFirstRow: 0,
    visibleLastRow: -1,
    labelIdentity: undefined,
    gestureTargetScale: 1,
    recordCount: 0,
  };
}
