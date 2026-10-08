import { describe, expect, it } from "vitest";

import { createWidgetTileFrameState } from "./frame-state";
import { CONTENT_KIND, HEADER_KIND, LABEL_KIND } from "./tile-records";
import {
  gestureStepRasterScale,
  isBetterScale,
  requestScale,
  revealPrefetchScale,
} from "./text-tile-raster-scale-rule";

describe("Text Tile Raster Scale rule", () => {
  it("uses the gesture step for every visible Text Tile kind", () => {
    const frame = createWidgetTileFrameState();
    frame.zoom = 1.7;
    frame.devicePixelRatio = 2;
    frame.zoomGestureActive = true;

    const expected = gestureStepRasterScale(1.7, 2);
    expect(requestScale(CONTENT_KIND, frame)).toBe(expected);
    expect(requestScale(HEADER_KIND, frame)).toBe(expected);
    expect(requestScale(LABEL_KIND, frame)).toBe(expected);
  });

  it("converts explicit reveal zoom and otherwise uses the coarse scale", () => {
    const frame = createWidgetTileFrameState();
    frame.zoom = 1.7;
    frame.devicePixelRatio = 2;
    frame.zoomGestureActive = true;

    expect(revealPrefetchScale(frame, 3.25)).toBe(6.5);
    expect(revealPrefetchScale(frame, 0)).toBe(2);
  });

  it("chooses the closest gesture target, then the larger scale", () => {
    const frame = createWidgetTileFrameState();
    frame.zoomGestureActive = true;
    frame.gestureTargetScale = 2.5;

    expect(isBetterScale(HEADER_KIND, 2, 1, frame)).toBe(true);
    expect(isBetterScale(LABEL_KIND, 2, 4, frame)).toBe(true);
    expect(isBetterScale(LABEL_KIND, 2, 3.125, frame)).toBe(false);
    expect(isBetterScale(CONTENT_KIND, 4, 1, frame)).toBe(true);
  });

  it("keeps the at-rest record first when the gesture is inactive", () => {
    const frame = createWidgetTileFrameState();
    frame.atRestScale = 2;

    expect(isBetterScale(HEADER_KIND, 2, 4, frame)).toBe(true);
    expect(isBetterScale(LABEL_KIND, 4, 2, frame)).toBe(false);
  });
});
