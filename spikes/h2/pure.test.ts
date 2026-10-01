import { describe, expect, it } from "vitest";

import {
  droppedFrameCount,
  countTextOutsideWidgetGaps,
  atlasGestureViolationCounter,
  buildTextMask,
  dilateMask,
  expectedSceneCounts,
  gestureSpeedReason,
  intersectionOverUnion,
  runWithCap,
  summaryExitCode,
} from "./pure";

describe("H2 pure measurement helpers", () => {
  it("counts expected glyphs and covered body area independently of renderer", () => {
    const result = expectedSceneCounts(
      [{ x: 0, y: 0, cells: [[{}, {}], [{}]] }],
      0,
      0,
      1,
    );
    expect(result.visibleWidgets).toBe(1);
    expect(result.glyphs).toBe(3);
    expect(result.tileArea).toBe(760 * 680);
  });

  it("counts expected glyphs from the scrolled visible line range, not always line 0 (D7 line window)", () => {
    const result = expectedSceneCounts(
      [{ x: 0, y: 0, cells: [[{}], [{}, {}], [{}, {}, {}]] }],
      0,
      0,
      1,
      new Map([[0, 20]]), // scrollOffset 20px = 1 line at the 20px default line height
    );
    expect(result.glyphs).toBe(5); // lines 1 and 2 (2 + 3 cells); line 0 scrolled out
  });

  it("counts frame intervals over 1.5 times the vsync interval", () => {
    expect(droppedFrameCount([8, 12.4, 12.51, 20], 8.333333)).toBe(2);
  });

  it("counts text-added pixels in grid gaps but not inside a widget body", () => {
    const width = 1200;
    const height = 720;
    const withoutText = new Uint8Array(width * height * 4).fill(31);
    const withText = withoutText.slice();
    // (100, 50) is inside widget column 0's body (x < 760): not a gap pixel.
    // (780, 50) is in the gap between columns (760 <= x < 800).
    const targets: readonly (readonly [number, number])[] = [
      [100, 50],
      [780, 50],
    ];
    for (const [x, y] of targets) {
      const offset = (y * width + x) * 4;
      withText[offset] = 217;
      withText[offset + 1] = 225;
      withText[offset + 2] = 238;
    }
    expect(
      countTextOutsideWidgetGaps(
        { width, data: withText },
        { width, data: withoutText },
        0,
        0,
        1,
        1,
      ),
    ).toBe(1);
  });

  it("does not flag a gap-fill colour that differs from both reference backgrounds when no text was added", () => {
    const width = 1200;
    const height = 720;
    const withoutText = new Uint8Array(width * height * 4);
    // Fill the whole frame with a colour far from both PRODUCT_BACKGROUND and
    // WIDGET_BACKGROUND (e.g. compositor dithering or a screenshot edge
    // artifact) — this previously false-positived as "text" under a
    // fixed-distance-from-two-colours check.
    for (let index = 0; index < withoutText.length; index += 4) {
      withoutText[index] = 53;
      withoutText[index + 1] = 67;
      withoutText[index + 2] = 90;
    }
    const withText = withoutText.slice(); // identical: no text was drawn
    expect(
      countTextOutsideWidgetGaps(
        { width, data: withText },
        { width, data: withoutText },
        0,
        0,
        1,
        1,
      ),
    ).toBe(0);
  });

  it("builds a text mask from a colour-threshold diff against the flat capture", () => {
    const width = 4;
    const height = 1;
    const withoutText = new Uint8Array(width * height * 4);
    const withText = withoutText.slice();
    withText[4] = 217; // pixel 1 changed, well over the threshold
    withText[5] = 225;
    withText[6] = 238;
    expect(
      Array.from(
        buildTextMask({ width, data: withText }, { width, data: withoutText }),
      ),
    ).toEqual([0, 1, 0, 0]);
  });

  it("dilates a mask by one pixel including diagonals", () => {
    const width = 3;
    const height = 3;
    // prettier-ignore
    const mask = Uint8Array.from([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0,
    ]);
    // prettier-ignore
    expect(Array.from(dilateMask(mask, width, height))).toEqual([
      1, 1, 1,
      1, 1, 1,
      1, 1, 1,
    ]);
  });

  it("computes IoU as intersection over union, and 1 for two empty masks", () => {
    expect(
      intersectionOverUnion(
        Uint8Array.from([1, 1, 0, 0]),
        Uint8Array.from([1, 0, 0, 1]),
      ),
    ).toBeCloseTo(1 / 3);
    expect(
      intersectionOverUnion(Uint8Array.from([0, 0]), Uint8Array.from([0, 0])),
    ).toBe(1);
  });

  it("identifies the named atlas mutation counter without flagging preparation", () => {
    expect(
      atlasGestureViolationCounter(
        { atlasPreparationFrames: 2 },
        { atlasPreparationFrames: 4 },
      ),
    ).toBeUndefined();
    expect(
      atlasGestureViolationCounter(
        { atlasBuildsDuringGesture: 0 },
        { atlasBuildsDuringGesture: 1 },
      ),
    ).toBe("atlasBuildsDuringGesture");
  });

  it("reports slow gestures only above the 1.5x threshold", () => {
    expect(gestureSpeedReason(1_500, 1_000)).toBeUndefined();
    expect(gestureSpeedReason(1_501, 1_000)).toContain(
      "validation-gesture-too-slow",
    );
  });

  it("uses missing, then failed, then passing summary exit states", () => {
    expect(summaryExitCode(["missing"], ["pass"])).toBe(2);
    expect(summaryExitCode(["fail"], ["pass"])).toBe(1);
    expect(summaryExitCode(["pass"], ["pass"])).toBe(0);
  });

  it("times out a never-resolving runner and invokes cancellation", async () => {
    let cancelled = false;
    await expect(
      runWithCap(
        () => new Promise<never>(() => undefined),
        10,
        () => {
          cancelled = true;
        },
      ),
    ).rejects.toThrow("timed out");
    expect(cancelled).toBe(true);
  });
});
