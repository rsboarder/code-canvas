import { describe, expect, it } from "vitest";

import {
  bodyViewWindow,
  prefetchViewWindow,
  type ViewWindow,
} from "./tile-view-window";

const camera = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  toScreen: (_point: { x: number; y: number }, out: { x: number; y: number }) =>
    out,
  toBoard: (_point: { x: number; y: number }, out: { x: number; y: number }) =>
    out,
};

function window(): ViewWindow {
  return { left: 0, top: 0, right: 0, bottom: 0 };
}

describe("tile view windows", () => {
  it("returns false when the body is entirely outside the view", () => {
    const out = window();

    const visible = bodyViewWindow(
      {
        camera,
        viewport: { width: 100, height: 100, devicePixelRatio: 1 },
        frame: { x: 200, y: 200, width: 50, height: 50 },
        bodyTop: 10,
        contentScroll: 0,
      },
      out,
    );

    expect(visible).toBe(false);
  });

  it("clamps a partly visible body to body-local coordinates", () => {
    const out = window();

    const visible = bodyViewWindow(
      {
        camera,
        viewport: { width: 100, height: 100, devicePixelRatio: 1 },
        frame: { x: 50, y: 40, width: 100, height: 100 },
        bodyTop: 20,
        contentScroll: 0,
      },
      out,
    );

    expect(visible).toBe(true);
    expect(out).toEqual({ left: 0, top: 0, right: 50, bottom: 40 });
  });

  it("matches the visible window when prefetch zoom equals camera zoom", () => {
    const visible = window();
    const prefetch = window();
    const input = {
      camera: {
        ...camera,
        offsetX: -30,
        offsetY: -15,
        scale: 2,
      },
      viewport: { width: 200, height: 120, devicePixelRatio: 1 },
      frame: { x: 10, y: -10, width: 150, height: 100 },
      bodyTop: 15,
      contentScroll: 0,
      targetZoom: 2,
      focusX: 40,
      focusY: 20,
    };

    expect(bodyViewWindow(input, visible)).toBe(true);
    prefetchViewWindow(input, prefetch);

    expect(prefetch).toEqual(visible);
  });
});

describe("scrolled tile view windows", () => {
  it("shifts a scrolled body window in content coordinates", () => {
    const initial = window();
    const scrolled = window();
    const input = {
      camera,
      viewport: { width: 100, height: 100, devicePixelRatio: 1 },
      frame: { x: 0, y: 0, width: 100, height: 100 },
      bodyTop: 20,
      contentScroll: 40,
    };

    expect(bodyViewWindow({ ...input, contentScroll: 0 }, initial)).toBe(true);
    expect(bodyViewWindow(input, scrolled)).toBe(true);
    expect(scrolled).toEqual({
      left: initial.left,
      top: initial.top + 40,
      right: initial.right,
      bottom: initial.bottom + 40,
    });
  });
});
