import { describe, expect, it } from "vitest";

import { worldToClip } from "./clip-transform";

describe("worldToClip", () => {
  it("maps CSS-pixel world coordinates through a DPR-aware viewport", () => {
    const point = worldToClip({
      worldX: 760,
      worldY: 0,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      cameraScale: 1,
      viewportWidthCss: 1000,
      viewportHeightCss: 800,
      devicePixelRatio: 2,
    });

    expect(point.x).toBeCloseTo((760 / 1000) * 2 - 1);
    expect(point.y).toBe(1);
  });
});
