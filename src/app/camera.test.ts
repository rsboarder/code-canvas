import { describe, expect, it } from "vitest";

import { Camera } from "../board/index";
import { zoomToPoint, type CameraPosition } from "../shared/geometry";

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

  it("converts a Board point to a screen point and back", () => {
    const camera = new Camera({ x: 10, y: 20 }, 2);
    const screen = camera.toScreen({ x: 5, y: 7 }, { x: 0, y: 0 });
    expect(screen).toEqual({ x: 5 * 2 + 10, y: 7 * 2 + 20 });

    const board = camera.toBoard(screen, { x: 0, y: 0 });
    expect(board.x).toBeCloseTo(5);
    expect(board.y).toBeCloseTo(7);
  });
});

describe("zoomToPoint aliasing", () => {
  it("gives the same result whether out is a separate object or options.camera itself", () => {
    const request = (camera: CameraPosition) => ({
      camera,
      screenPoint: { x: 210, y: 120 },
      factor: 2,
      minZoom: 0.05,
      maxZoom: 4,
    });

    const camera: CameraPosition = { x: 10, y: 20, zoom: 1 };
    const separateOut: CameraPosition = { x: 0, y: 0, zoom: 0 };
    const resultSeparate = zoomToPoint(request(camera), separateOut);

    const sameObject: CameraPosition = { x: 10, y: 20, zoom: 1 };
    const resultAliased = zoomToPoint(request(sameObject), sameObject);

    expect(resultAliased).toEqual(resultSeparate);
    expect(resultAliased).toBe(sameObject);
  });
});
