import type { WidgetTileFrameState } from "./frame-state";

export function coarseRasterScale(
  zoom: number,
  devicePixelRatio: number,
): number {
  return 2 ** Math.floor(Math.log2(zoom)) * devicePixelRatio;
}

export function gestureStepRasterScale(
  zoom: number,
  devicePixelRatio: number,
): number {
  const step = Math.floor(2 * Math.log2(zoom) + 0.5 + Number.EPSILON);
  return 2 ** (step / 2) * devicePixelRatio;
}

export function requestScale(
  _kind: number,
  frameState: WidgetTileFrameState,
): number {
  return frameState.zoomGestureActive
    ? gestureStepRasterScale(frameState.zoom, frameState.devicePixelRatio)
    : frameState.zoom * frameState.devicePixelRatio;
}

export function revealPrefetchScale(
  frameState: WidgetTileFrameState,
  explicitZoom: number,
): number {
  if (explicitZoom > 0) return explicitZoom * frameState.devicePixelRatio;
  if (!frameState.zoomGestureActive)
    return frameState.zoom * frameState.devicePixelRatio;
  return coarseRasterScale(frameState.zoom, frameState.devicePixelRatio);
}

export function isBetterScale(
  _kind: number,
  firstScale: number,
  secondScale: number,
  frameState: WidgetTileFrameState,
): boolean {
  if (frameState.zoomGestureActive) {
    const firstMismatch = rasterScaleMismatch(
      firstScale,
      frameState.gestureTargetScale,
    );
    const secondMismatch = rasterScaleMismatch(
      secondScale,
      frameState.gestureTargetScale,
    );
    if (firstMismatch !== secondMismatch) return firstMismatch < secondMismatch;
  } else {
    const firstAtRest = firstScale === frameState.atRestScale;
    const secondAtRest = secondScale === frameState.atRestScale;
    if (firstAtRest !== secondAtRest) return firstAtRest;
  }
  return firstScale > secondScale;
}

export function rasterScaleMismatch(scale: number, target: number): number {
  return Math.max(scale / target, target / scale);
}
