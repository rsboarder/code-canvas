import { describe, expect, it } from "vitest";

import {
  UNAVAILABLE,
  countLongIntervals,
  nearestRank,
} from "./frame-statistics";

describe("frame statistics", () => {
  it("uses nearest-rank percentiles", () => {
    const values = [8, 2, 10, 4, 6];

    expect(nearestRank(values, 0.5)).toBe(6);
    expect(nearestRank(values, 0.95)).toBe(10);
    expect(nearestRank(values, 0.99)).toBe(10);
  });

  it("marks empty samples unavailable", () => {
    expect(nearestRank([], 0.5)).toBe(UNAVAILABLE);
    expect(countLongIntervals([])).toBe(UNAVAILABLE);
  });

  it("counts only intervals strictly longer than the threshold", () => {
    expect(countLongIntervals([12.5, 12.51, 20])).toBe(2);
    expect(countLongIntervals([1, 2], 2)).toBe(0);
  });
});
