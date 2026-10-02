import { describe, expect, it } from "vitest";

import { DetailLevel } from "../board/index";

describe("DetailLevel", () => {
  it("waits at Minimap until Text Tiles are ready", () => {
    const detail = new DetailLevel();
    detail.update(8.9, true);
    expect(detail.update(11.1, false)).toBe("minimap");
    expect(detail.update(11.1, true)).toBe("text");
  });

  it("computes the zoom threshold from line height and DPR", () => {
    const detail = new DetailLevel();
    expect(detail.textThresholdZoom(20, 2)).toBeCloseTo(11 / 40);
  });

  it("keeps hysteresis unchanged", () => {
    const detail = new DetailLevel();
    expect(detail.update(8.9, true)).toBe("minimap");
    expect(detail.update(11, true)).toBe("minimap");
    expect(detail.update(11.1, true)).toBe("text");
  });
});
