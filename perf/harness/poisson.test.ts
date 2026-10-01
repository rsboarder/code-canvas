import { describe, expect, it } from "vitest";

import { poissonUpperBoundPerMinute } from "./poisson";

describe("poissonUpperBoundPerMinute", () => {
  it("bounds 0 events observed over 1 minute at ~2.996 per minute", () => {
    expect(poissonUpperBoundPerMinute(0, 1)).toBeCloseTo(2.996, 3);
  });

  it("bounds 1 event observed over 1 minute at ~4.744 per minute", () => {
    expect(poissonUpperBoundPerMinute(1, 1)).toBeCloseTo(4.744, 3);
  });

  it("bounds 2 events observed over 1 minute at ~6.296 per minute", () => {
    expect(poissonUpperBoundPerMinute(2, 1)).toBeCloseTo(6.296, 3);
  });

  it("scales the bound down as the observation window grows", () => {
    const oneMinute = poissonUpperBoundPerMinute(0, 1);
    const twoMinutes = poissonUpperBoundPerMinute(0, 2);
    expect(twoMinutes).toBeCloseTo(oneMinute / 2, 6);
  });
});
