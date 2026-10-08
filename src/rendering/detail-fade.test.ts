import { describe, expect, it } from "vitest";

import {
  DETAIL_FADE_MS,
  detailFrameFor,
  type DetailFrame,
  stepTextWeight,
} from "./detail-fade";

describe("detail fade", () => {
  it("steps toward the target by elapsed time", () => {
    expect(stepTextWeight(0, 1, 30)).toBe(0.2);
  });

  it("clamps long pauses and reverses from the current weight", () => {
    expect(stepTextWeight(0, 1, DETAIL_FADE_MS * 2)).toBeCloseTo(1 / 3);
    expect(stepTextWeight(0.6, 0, DETAIL_FADE_MS / 2)).toBeCloseTo(0.2666667);
  });

  it("does not move when already at the target", () => {
    expect(stepTextWeight(1, 1, DETAIL_FADE_MS)).toBe(1);
    expect(stepTextWeight(0, 0, DETAIL_FADE_MS)).toBe(0);
  });

  it("describes minimap, content, and label alpha for each detail weight", () => {
    const frame: DetailFrame = {
      minimapAlpha: 0,
      contentAlpha: 0,
      labelAlpha: 0,
    };

    expect(detailFrameFor(0, frame)).toBe(frame);
    expect(frame).toEqual({ minimapAlpha: 1, contentAlpha: 0, labelAlpha: 1 });

    detailFrameFor(1, frame);
    expect(frame).toEqual({ minimapAlpha: 0, contentAlpha: 1, labelAlpha: 0 });

    detailFrameFor(0.5, frame);
    expect(frame).toEqual({
      minimapAlpha: 0.5,
      contentAlpha: 0.5,
      labelAlpha: 0.5,
    });
  });
});
