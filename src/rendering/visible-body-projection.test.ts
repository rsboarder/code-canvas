import { describe, expect, it } from "vitest";

import { Camera } from "../board/index";
import type { BoardReadModel, WidgetRow } from "../board/index";
import type { Viewport } from "./viewport";
import { VisibleBodyProjection } from "./visible-body-projection";
import { WidgetTable, type WidgetTableBoard } from "./scene/widget-table";

const FILE_ID = "visible.ts";
const BODY_TOP = 20;
const VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };
const BODY = {
  x: 50,
  y: 20,
  width: 100,
  height: 100,
  contentScroll: 7,
};

type WidgetId = NonNullable<ReturnType<BoardReadModel["widgetIdAtFromTop"]>>;

class FakeBoard implements WidgetTableBoard {
  layoutVersion = 1;
  readonly widgetCount = 1;

  widgetIdAtFromTop(index: number): WidgetId | undefined {
    return index === 0 ? (FILE_ID as WidgetId) : undefined;
  }

  readWidget(_id: WidgetId, out: WidgetRow): WidgetRow {
    Object.assign(out, {
      ...BODY,
      maxContentScroll: 80,
      lineCount: 10,
      stackIndex: 0,
    });
    return out;
  }

  drainDirtyWidgets(out: WidgetId[]): number {
    out.length = 0;
    return 0;
  }
}

function projection(): VisibleBodyProjection {
  const table = new WidgetTable();
  table.sync(new FakeBoard());
  return new VisibleBodyProjection(table);
}

describe("VisibleBodyProjection", () => {
  it("does not report a body outside the Viewport", () => {
    const visible = projection();
    const camera = new Camera({ x: 200, y: 0 }, 1);

    visible.update(camera, VIEWPORT, BODY_TOP);

    expect(visible.windowAt(0)).toBeUndefined();
  });

  it("does not report a body that only touches the Viewport edge", () => {
    const visible = projection();
    const camera = new Camera({ x: -150, y: 0 }, 1);

    visible.update(camera, VIEWPORT, BODY_TOP);

    expect(visible.windowAt(0)).toBeUndefined();
  });

  it("clamps a body crossing the Viewport edge", () => {
    const visible = projection();
    const camera = new Camera({ x: 0, y: 0 }, 1);

    visible.update(camera, VIEWPORT, BODY_TOP);

    expect(visible.windowAt(0)).toEqual({
      left: 0,
      top: 7,
      right: 50,
      bottom: 67,
    });
  });

  it("includes Content Scroll in the body-local window", () => {
    const visible = projection();
    const camera = new Camera({ x: -25, y: 0 }, 1);

    visible.update(camera, VIEWPORT, BODY_TOP);

    expect(visible.windowAt(0)).toEqual({
      left: 0,
      top: 7,
      right: 75,
      bottom: 67,
    });
  });

  it("refreshes after a Camera change but not when inputs are unchanged", () => {
    const visible = projection();
    const camera = new Camera({ x: 0, y: 0 }, 1);

    visible.update(camera, VIEWPORT, BODY_TOP);
    const initialWindow = visible.windowAt(0);
    expect(visible.refresh(camera, VIEWPORT, BODY_TOP)).toBe(false);
    expect(visible.windowAt(0)).toBe(initialWindow);

    camera.setPosition({ x: -25, y: 0 }, 1);
    expect(visible.refresh(camera, VIEWPORT, BODY_TOP)).toBe(true);
    expect(visible.windowAt(0)).toBe(initialWindow);
    expect(visible.windowAt(0)).toEqual({
      left: 0,
      top: 7,
      right: 75,
      bottom: 67,
    });
    expect(visible.refresh(camera, VIEWPORT, BODY_TOP)).toBe(false);
  });
});
