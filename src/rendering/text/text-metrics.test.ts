import { describe, expect, it } from "vitest";

import {
  calculateBaseline,
  createAdvanceCache,
  roundMetric,
} from "./text-metrics";

describe("Text Metrics", () => {
  it("uses CSS half-leading for the baseline", () => {
    expect(calculateBaseline(20, 12, 3)).toBe(14);
    expect(calculateBaseline(20, 11.5, 3.5)).toBe(13.5);
  });

  it("rounds all measurements to one shared precision", () => {
    expect(roundMetric(9.6326)).toBe(9.633);
    expect(roundMetric(15.0004)).toBe(15);
  });

  it("measures each cluster once and caches the rounded result", () => {
    const calls: string[] = [];
    const advanceFor = createAdvanceCache((cluster) => {
      calls.push(cluster);
      return 9.6326;
    });

    expect(advanceFor("A")).toBe(9.633);
    expect(advanceFor("A")).toBe(9.633);
    expect(advanceFor("👩‍👩‍👧‍👦")).toBe(9.633);
    expect(calls).toEqual(["A", "👩‍👩‍👧‍👦"]);
  });
});
