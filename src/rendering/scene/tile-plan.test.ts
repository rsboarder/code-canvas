import { describe, expect, it } from "vitest";

import {
  computeTilePoolCapacity,
  tilePoolGrowthTarget,
  TILE_DEVICE_SIZE,
} from "./tile-plan";

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
