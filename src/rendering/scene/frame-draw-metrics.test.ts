import { describe, expect, it } from "vitest";

import {
  recordDrawMetrics,
  resetFrameDrawMetrics,
  type FrameDrawMetrics,
} from "./frame-draw-metrics";

function metrics(): FrameDrawMetrics {
  return {
    textWeight: 1,
    tileMemoryBytes: 0,
    missingTile: false,
    visibleWidgetCount: 0,
    drawnTileCount: 0,
    drawnLabelTileCount: 0,
    drawnMinimapCount: 0,
    drawnFallbackTileCount: 0,
    drawnUnhighlightedTileCount: 0,
    lowestEpochDrawn: -1,
    lowestContentVersion: -1,
    timeToSharpMs: Number.NaN,
  };
}

describe("frame draw metrics", () => {
  it("resets the per-frame draw counts and lowest values", () => {
    const value = metrics();
    value.visibleWidgetCount = 3;
    value.drawnTileCount = 4;
    value.drawnLabelTileCount = 2;
    value.drawnMinimapCount = 5;
    value.drawnFallbackTileCount = 2;
    value.drawnUnhighlightedTileCount = 3;
    value.lowestEpochDrawn = 7;
    value.lowestContentVersion = 5;

    resetFrameDrawMetrics(value);

    expect(value.visibleWidgetCount).toBe(0);
    expect(value.drawnTileCount).toBe(0);
    expect(value.drawnLabelTileCount).toBe(0);
    expect(value.drawnFallbackTileCount).toBe(0);
    expect(value.drawnUnhighlightedTileCount).toBe(0);
    expect(value.lowestEpochDrawn).toBe(-1);
    expect(value.lowestContentVersion).toBe(-1);
  });

  it("counts only drawn unhighlighted content tiles", () => {
    const value = metrics();

    recordDrawMetrics(value, {
      content: true,
      fallback: true,
      highlighted: false,
      epoch: 2,
      contentVersion: 3,
    });
    recordDrawMetrics(value, {
      content: true,
      fallback: false,
      highlighted: true,
      epoch: 2,
      contentVersion: 3,
    });
    recordDrawMetrics(value, {
      content: false,
      fallback: false,
      highlighted: false,
      epoch: 2,
      contentVersion: 3,
    });

    expect(value.drawnTileCount).toBe(3);
    expect(value.drawnLabelTileCount).toBe(1);
    expect(value.drawnFallbackTileCount).toBe(1);
    expect(value.drawnUnhighlightedTileCount).toBe(1);
    expect(value.lowestEpochDrawn).toBe(2);
    expect(value.lowestContentVersion).toBe(3);
  });

  it("resets drawn minimap count", () => {
    const value = metrics();
    value.drawnMinimapCount = 5;

    resetFrameDrawMetrics(value);

    expect(value.drawnMinimapCount).toBe(0);
  });
});

describe("frame draw metrics aggregation", () => {
  it("uses the worst values from every drawn widget", () => {
    const value = metrics();

    recordDrawMetrics(value, {
      content: true,
      fallback: false,
      highlighted: true,
      epoch: 8,
      contentVersion: 9,
    });
    recordDrawMetrics(value, {
      content: true,
      fallback: true,
      highlighted: false,
      epoch: 3,
      contentVersion: 4,
    });

    expect(value.lowestEpochDrawn).toBe(3);
    expect(value.lowestContentVersion).toBe(4);
    expect(value.drawnUnhighlightedTileCount).toBe(1);
  });
});
