interface CameraRange {
  readonly minScale: number;
  readonly maxScale: number;
}

interface CameraRangeStage {
  readonly name: "camera-range";
  readonly run: () => boolean;
  readonly reset: () => void;
  readonly range: () => CameraRange;
}

// Tracks the camera's min and max scale since the last reset so the
// performance harness can catch a pinch replay that rides out to a peak
// zoom and back without ever changing the final camera (the final-camera
// check alone can't see a round trip).
export function createCameraRangeStage(
  readScale: () => number,
): CameraRangeStage {
  let minScale = readScale();
  let maxScale = minScale;
  return {
    name: "camera-range",
    run: () => {
      const scale = readScale();
      minScale = Math.min(minScale, scale);
      maxScale = Math.max(maxScale, scale);
      return false;
    },
    reset: () => {
      minScale = readScale();
      maxScale = minScale;
    },
    range: () => ({ minScale, maxScale }),
  };
}
