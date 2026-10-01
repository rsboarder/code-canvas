import { describe, expect, it } from "vitest";

import { Camera } from "../board/index";

describe("Camera bridge positioning", () => {
  it("sets the offset and clamps the scale to its bounds", () => {
    const camera = new Camera();
    camera.setPosition({ x: 120, y: -45 }, 8);
    expect(camera.offset).toEqual({ x: 120, y: -45 });
    expect(camera.scale).toBe(4);
    camera.setPosition({ x: -2, y: 3 }, 0.001);
    expect(camera.offset).toEqual({ x: -2, y: 3 });
    expect(camera.scale).toBe(0.05);
  });
});
