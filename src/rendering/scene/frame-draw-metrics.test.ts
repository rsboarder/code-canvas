import { describe, expect, it } from "vitest";

import {
  recordDrawMetrics,
  resetFrameDrawMetrics,
  type FrameDrawMetrics,
} from "./frame-draw-metrics";

function metrics(): FrameDrawMetrics {
  return {
    tileMemoryBytes: 0,
    missingTile: false,
    drawnTileCount: 0,
    drawnLabelTileCount: 0,
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
    value.drawnTileCount = 4;
    value.drawnLabelTileCount = 2;
    value.drawnFallbackTileCount = 2;
    value.drawnUnhighlightedTileCount = 3;
    value.lowestEpochDrawn = 7;
    value.lowestContentVersion = 5;

    resetFrameDrawMetrics(value);

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
});
