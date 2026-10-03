import { describe, expect, it } from "vitest";

import {
  computeTilePoolCapacity,
  planVisibleTiles,
  rasterScaleFor,
  tilePoolGrowthTarget,
  tileContentSize,
  TILE_DEVICE_SIZE,
} from "./tile-plan";

const DPR = 2;

describe("tile planning: margin ring", () => {
  it.each([1, 0.5, 2, 4])(
    "covers the visible content plus a margin ring at zoom %s, DPR 2",
    (zoom) => {
      const size = tileContentSize(rasterScaleFor(zoom, DPR));
      const tiles = planVisibleTiles({
        contentWidth: size * 10,
        contentHeight: size * 10,
        visibleLeft: size * 3,
        visibleTop: size * 3,
        visibleRight: size * 5,
        visibleBottom: size * 5,
        contentScroll: 0,
        zoom,
        devicePixelRatio: DPR,
      });
      const columns = new Set(tiles.map((tile) => tile.column));
      const rows = new Set(tiles.map((tile) => tile.row));
      // Visible columns/rows 3..5 plus a one-tile margin ring on each side.
      expect([...columns].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
      expect([...rows].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
      expect(tiles).toHaveLength(25);
    },
  );

  it("clamps the margin ring at the content origin", () => {
    const size = tileContentSize(rasterScaleFor(1, DPR));
    const tiles = planVisibleTiles({
      contentWidth: size * 10,
      contentHeight: size * 10,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: size * 0.5,
      visibleBottom: size * 0.5,
      contentScroll: 0,
      zoom: 1,
      devicePixelRatio: DPR,
    });
    const columns = [...new Set(tiles.map((tile) => tile.column))].sort(
      (a, b) => a - b,
    );
    // A one-tile margin ring would reach column -1 on the left; it clamps
    // to the content origin instead of producing a negative tile index.
    expect(columns).toEqual([0, 1]);
  });
});

describe("tile planning: edges", () => {
  it("includes a trailing partial tile at the content edge", () => {
    const size = tileContentSize(rasterScaleFor(1, DPR));
    const contentWidth = size * 2.4;
    const tiles = planVisibleTiles({
      contentWidth,
      contentHeight: size,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: contentWidth,
      visibleBottom: size,
      contentScroll: 0,
      zoom: 1,
      devicePixelRatio: DPR,
    });
    const maxColumn = Math.max(...tiles.map((tile) => tile.column));
    // Content spans [0, 2.4*size): a 3rd (partial) column is still planned.
    expect(maxColumn).toBe(2);
  });

  it("returns nothing for a widget with no content", () => {
    const tiles = planVisibleTiles({
      contentWidth: 0,
      contentHeight: 0,
      visibleLeft: 0,
      visibleTop: 0,
      visibleRight: 0,
      visibleBottom: 0,
      contentScroll: 0,
      zoom: 1,
      devicePixelRatio: DPR,
    });
    expect(tiles).toEqual([]);
  });
});

describe("tile pool capacity", () => {
  it("sizes the pool from the reference viewport (1512x982 CSS px at DPR 2)", () => {
    // columns = ceil(1512*2/512) + 2 = 6 + 2 = 8
    // rows    = ceil(982*2/512)  + 2 = 4 + 2 = 6
    // capacity = 8 * 6 * 2 (old-scale tiles kept while a zoom settles) = 96
    expect(computeTilePoolCapacity(1512, 982, 2)).toBe(96);
    expect(96 * TILE_DEVICE_SIZE * TILE_DEVICE_SIZE * 4).toBe(100_663_296);
  });

  it("grows with viewport area and shrinks with a smaller DPR", () => {
    const large = computeTilePoolCapacity(1920, 1080, 2);
    const small = computeTilePoolCapacity(800, 600, 1);
    expect(large).toBeGreaterThan(small);
  });

  it("does not grow when demand fits the current capacity", () => {
    expect(tilePoolGrowthTarget(96, 96, 8, 256)).toBe(96);
    expect(tilePoolGrowthTarget(95, 96, 8, 256)).toBe(96);
  });

  it("rounds growth up to whole columns with 1.25 headroom", () => {
    expect(tilePoolGrowthTarget(100, 64, 1, 256)).toBe(125);
    expect(tilePoolGrowthTarget(101, 64, 8, 256)).toBe(128);
  });

  it("caps growth at the largest whole-column capacity", () => {
    expect(tilePoolGrowthTarget(100, 64, 8, 110)).toBe(104);
  });

  it("never returns a target below the current capacity", () => {
    expect(tilePoolGrowthTarget(17, 16, 8, 9)).toBe(16);
  });
});
