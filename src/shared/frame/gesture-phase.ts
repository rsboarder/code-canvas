export interface GesturePhase {
  gestureInProgress: boolean;
  zoomGestureActive: boolean;
  zoomFocusX: number;
  zoomFocusY: number;
  zoomingOut: boolean;
  gestureEnded: boolean;
  endedGestureWasZoom: boolean;
  detailIsMinimap: boolean;
  zoomingIn: boolean;
  textThresholdZoom: number;
  cameraScale: number;
}
