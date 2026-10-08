import { describe, expect, it, vi } from "vitest";

import type {
  GestureBoard,
  KeyInput,
  PointerInput,
  WheelInput,
} from "./gesture-targeting";
import { GestureTargeting, WHEEL_GESTURE_END_MS } from "./gesture-targeting";
import type { HitZone } from "../board";

type SourceFileId = Parameters<GestureBoard["readWidget"]>[0];
type TestWheelInput = WheelInput & {
  readonly preventDefaultSpy: ReturnType<typeof vi.fn>;
};

interface HitDescription {
  readonly zone: HitZone;
  readonly widgetId?: SourceFileId;
  readonly contentX?: number;
  readonly contentY?: number;
}

interface Harness {
  targeting: GestureTargeting;
  readonly editing: { activeWidgetId: string | undefined };
  hit: HitDescription;
  maxContentScroll: number;
  scale: number;
  cameraOffsetX: number;
  cameraOffsetY: number;
  widgetX: number;
  widgetY: number;
  widgetWidth: number;
  widgetHeight: number;
  detailLevel: "text" | "minimap";
}

function createHarness(): Harness {
  const state: Harness = {
    targeting: undefined as unknown as GestureTargeting,
    editing: { activeWidgetId: undefined },
    hit: { zone: "empty" },
    maxContentScroll: 100,
    scale: 2,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    widgetX: 100,
    widgetY: 200,
    widgetWidth: 160,
    widgetHeight: 120,
    detailLevel: "text",
  };
  const board: GestureBoard = {
    camera: {
      get offsetX() {
        return state.cameraOffsetX;
      },
      get offsetY() {
        return state.cameraOffsetY;
      },
      get scale() {
        return state.scale;
      },
      toBoard: (point, out) => Object.assign(out, point),
      toScreen: (point, out) => Object.assign(out, point),
    },
    get detailLevel() {
      return state.detailLevel;
    },
    hitTest: (_x, _y, out) => {
      out.zone = state.hit.zone;
      out.widgetId = state.hit.widgetId;
      out.contentX = state.hit.contentX ?? 0;
      out.contentY = state.hit.contentY ?? 0;
      return out;
    },
    readWidget: (_id, out) => {
      out.x = state.widgetX;
      out.y = state.widgetY;
      out.width = state.widgetWidth;
      out.height = state.widgetHeight;
      out.maxContentScroll = state.maxContentScroll;
      return out;
    },
  };
  state.targeting = new GestureTargeting(board, state.editing);
  return state;
}

function wheel(
  timeStamp: number,
  overrides: Partial<WheelInput> = {},
): TestWheelInput {
  const preventDefaultSpy = vi.fn();
  return {
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    metaKey: false,
    offsetX: 10,
    offsetY: 20,
    timeStamp,
    preventDefault: preventDefaultSpy,
    preventDefaultSpy,
    ...overrides,
  };
}

function pointer(overrides: Partial<PointerInput> = {}): PointerInput {
  return {
    button: 0,
    pointerId: 1,
    offsetX: 10,
    offsetY: 20,
    timeStamp: 0,
    ...overrides,
  };
}

function key(overrides: Partial<KeyInput> = {}): KeyInput {
  return {
    code: "Space",
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

const file = "file.ts" as SourceFileId;
const otherFile = "other.ts" as SourceFileId;

describe("GestureTargeting wheel", () => {
  it("Trackpad pan", () => {
    const { targeting } = createHarness();
    const event = wheel(0, { deltaX: 4, deltaY: 7 });

    targeting.wheel(event);

    expect(targeting.takeIntents(0)).toMatchObject({
      panX: -4,
      panY: -7,
      zoomFactor: 1,
    });
    expect(event.preventDefaultSpy).toHaveBeenCalledOnce();
  });

  it("Pinch-zoom toward a point", () => {
    const { targeting } = createHarness();
    const total = -142.6 * Math.log(2);

    for (let index = 0; index < 10; index += 1) {
      targeting.wheel(
        wheel(index * 16, {
          ctrlKey: true,
          deltaY: total / 10,
          offsetX: index === 9 ? 42 : 10,
          offsetY: index === 9 ? 64 : 20,
        }),
      );
    }

    const intents = targeting.takeIntents(144);
    expect(Math.abs(intents.zoomFactor - 2)).toBeLessThan(1e-9);
    expect(intents).toMatchObject({
      zoomX: 42,
      zoomY: 64,
      zoomingIn: true,
      zoomingOut: false,
    });
  });

  it("reports pinch-out direction for the whole gesture", () => {
    const { targeting } = createHarness();

    targeting.wheel(wheel(0, { ctrlKey: true, deltaY: 4 }));

    expect(targeting.takeIntents(0)).toMatchObject({
      zoomingIn: false,
      zoomingOut: true,
    });
    expect(targeting.takeIntents(16)).toMatchObject({
      zoomingIn: false,
      zoomingOut: true,
    });
  });

  it("clamps the per-event pinch step", () => {
    const { targeting } = createHarness();

    targeting.wheel(wheel(0, { ctrlKey: true, deltaY: -1000 }));

    expect(targeting.takeIntents(0).zoomFactor).toBeCloseTo(Math.exp(0.1), 9);
  });

  it("Browser zoom does not intercept the gesture", () => {
    const { targeting } = createHarness();
    const ctrl = wheel(0, { ctrlKey: true });
    const meta = wheel(16, { metaKey: true });

    targeting.wheel(ctrl);
    targeting.wheel(meta);

    expect(ctrl.preventDefaultSpy).toHaveBeenCalledOnce();
    expect(meta.preventDefaultSpy).toHaveBeenCalledOnce();
  });
});

describe("GestureTargeting widget wheel targets", () => {
  it("Scrolling a long file", () => {
    const harness = createHarness();
    harness.hit = { zone: "body", widgetId: file };
    harness.targeting.wheel(wheel(0, { deltaY: 20 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      scrollWidgetId: file,
      scrollDeltaY: 10,
      panX: 0,
      panY: 0,
    });
  });

  it("Content edge", () => {
    const harness = createHarness();
    harness.hit = { zone: "body", widgetId: file };

    for (let time = 0; time <= 1000; time += 16) {
      harness.targeting.wheel(wheel(time, { deltaY: 20 }));
    }

    const intents = harness.targeting.takeIntents(1000);
    expect(intents.scrollWidgetId).toBe(file);
    expect(intents.panY).toBe(0);
  });

  it("Wheel at a far zoom level", () => {
    const harness = createHarness();
    harness.detailLevel = "minimap";
    harness.hit = { zone: "body", widgetId: file };
    harness.targeting.wheel(wheel(0, { deltaY: 8 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      panY: -8,
      scrollDeltaY: 0,
    });
  });

  it("a body whose content fits pans", () => {
    const harness = createHarness();
    harness.maxContentScroll = 0;
    harness.hit = { zone: "body", widgetId: file };
    harness.targeting.wheel(wheel(0, { deltaY: 8 }));

    expect(harness.targeting.takeIntents(0).panY).toBe(-8);
  });
});

describe("GestureTargeting boundaries", () => {
  it("a pause at the wheel boundary starts a new gesture with a new target", () => {
    const harness = createHarness();
    harness.hit = { zone: "body", widgetId: file };
    harness.targeting.wheel(wheel(0, { deltaY: 4 }));
    harness.hit = { zone: "empty" };
    harness.targeting.wheel(wheel(WHEEL_GESTURE_END_MS, { deltaY: 5 }));

    expect(harness.targeting.takeIntents(WHEEL_GESTURE_END_MS)).toMatchObject({
      panY: -5,
      scrollWidgetId: undefined,
      gestureEnded: true,
      gestureInProgress: true,
    });
  });

  it("takeIntents at the wheel idle boundary reports the end once", () => {
    const { targeting } = createHarness();
    targeting.wheel(wheel(10, { deltaY: 4 }));

    expect(targeting.takeIntents(10 + WHEEL_GESTURE_END_MS)).toMatchObject({
      gestureEnded: true,
      gestureInProgress: false,
    });
    expect(targeting.takeIntents(10 + WHEEL_GESTURE_END_MS)).toMatchObject({
      gestureEnded: false,
      gestureInProgress: false,
    });
  });

  it("a modifier switch inside the idle window starts a zoom gesture", () => {
    const { targeting } = createHarness();
    targeting.wheel(wheel(0, { deltaY: 4 }));
    targeting.wheel(wheel(20, { ctrlKey: true, deltaY: -4 }));

    expect(targeting.takeIntents(20)).toMatchObject({
      panY: -4,
      zoomGestureActive: true,
      gestureEnded: true,
    });
    expect(typeof targeting.takeIntents(20).zoomFactor).toBe("number");
  });
});

describe("GestureTargeting editing", () => {
  it("Zoom during editing", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    const event = wheel(0, { ctrlKey: true, deltaY: -4 });
    harness.targeting.wheel(event);

    expect(harness.targeting.editingExitRequested).toBe(true);
    expect(typeof harness.targeting.takeIntents(0).zoomFactor).toBe("number");
    expect(event.preventDefaultSpy).toHaveBeenCalledOnce();
  });

  it("Pan during editing", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    harness.targeting.wheel(wheel(0, { deltaY: 4 }));

    expect(harness.targeting.editingExitRequested).toBe(true);
    expect(harness.targeting.takeIntents(0)).toMatchObject({ panY: -4 });
  });

  it("Swipe over the editor", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    harness.hit = { zone: "body", widgetId: file };
    const event = wheel(0, { deltaY: 4 });
    harness.targeting.wheel(event);

    expect(harness.targeting.editingExitRequested).toBe(false);
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      panY: 0,
      zoomFactor: 1,
    });
    expect(event.preventDefaultSpy).not.toHaveBeenCalled();
    expect(harness.editing.activeWidgetId).toBe(file);
  });

  it("Attempt to drag the active widget", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    harness.hit = { zone: "header", widgetId: file };
    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 20, offsetY: 30 }));
    harness.targeting.pointerUp(pointer());

    expect(harness.targeting.editingExitRequested).toBe(false);
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      panX: 0,
      panY: 0,
    });
  });

  it("clicking another widget while editing ends outside", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    harness.hit = { zone: "body", widgetId: otherFile };
    harness.targeting.pointerDown(pointer());

    expect(harness.targeting.editingExitRequested).toBe(true);
    harness.targeting.takeIntents(0);
  });

  it("scrolling another widget while editing does not end it", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    harness.hit = { zone: "body", widgetId: otherFile };
    harness.targeting.wheel(wheel(0, { deltaY: 4 }));

    expect(harness.targeting.editingExitRequested).toBe(false);
    harness.targeting.takeIntents(0);
  });
});

describe("GestureTargeting keyboard shortcuts", () => {
  it("Shift+Digit1 fits all once", () => {
    const harness = createHarness();
    const preventDefault = vi.fn();
    const event = key({ code: "Digit1", shiftKey: true, preventDefault });

    harness.targeting.keyDown(event);

    expect(harness.targeting.takeIntents(0)).toMatchObject({ fitAll: true });
    expect(harness.targeting.takeIntents(0)).toMatchObject({ fitAll: false });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("Shift+Digit0 zooms to 100%", () => {
    const harness = createHarness();
    const preventDefault = vi.fn();
    const event = key({ code: "Digit0", shiftKey: true, preventDefault });

    harness.targeting.keyDown(event);

    expect(harness.targeting.takeIntents(0)).toMatchObject({ zoomTo100: true });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores repeated or modified shortcuts", () => {
    const cases: Partial<KeyInput>[] = [
      { code: "Digit1", shiftKey: true, repeat: true },
      { code: "Digit1" },
      { code: "Digit1", shiftKey: true, ctrlKey: true },
      { code: "Digit1", shiftKey: true, metaKey: true },
      { code: "Digit1", shiftKey: true, altKey: true },
    ];

    for (const overrides of cases) {
      const harness = createHarness();
      const preventDefault = vi.fn();
      const event = key({ ...overrides, preventDefault });

      harness.targeting.keyDown(event);

      expect(harness.targeting.takeIntents(0)).toMatchObject({
        fitAll: false,
        zoomTo100: false,
      });
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });

  it("shortcuts request the zoom command while editing", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    const preventDefault = vi.fn();
    const event = key({ code: "Digit0", shiftKey: true, preventDefault });

    harness.targeting.keyDown(event);

    expect(harness.targeting.editingExitRequested).toBe(true);
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      zoomTo100: true,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("GestureTargeting toolbar requests", () => {
  it("toolbar Fit all and 100% act like Shift+1 and Shift+0", () => {
    const fitShortcut = createHarness();
    fitShortcut.targeting.keyDown(key({ code: "Digit1", shiftKey: true }));
    const fitToolbar = createHarness();
    fitToolbar.targeting.requestFitAll();

    expect(fitToolbar.targeting.takeIntents(0)).toMatchObject(
      fitShortcut.targeting.takeIntents(0),
    );

    const zoomShortcut = createHarness();
    zoomShortcut.targeting.keyDown(key({ code: "Digit0", shiftKey: true }));
    const zoomToolbar = createHarness();
    zoomToolbar.targeting.requestZoomTo100();

    expect(zoomToolbar.targeting.takeIntents(0)).toMatchObject(
      zoomShortcut.targeting.takeIntents(0),
    );

    zoomToolbar.editing.activeWidgetId = file;
    zoomToolbar.targeting.requestFitAll();

    expect(zoomToolbar.targeting.editingExitRequested).toBe(true);
    zoomToolbar.targeting.takeIntents(0);
  });
});

describe("GestureTargeting double click", () => {
  it("begins editing on a Text body with its content point", () => {
    const harness = createHarness();
    harness.hit = {
      zone: "body",
      widgetId: file,
      contentX: 42,
      contentY: 84,
    };

    harness.targeting.doubleClick({ offsetX: 10, offsetY: 20 });

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      beginEditingWidgetId: file,
      beginEditingContentX: 42,
      beginEditingContentY: 84,
      zoomToWidgetId: undefined,
    });
  });

  it("does not begin editing from a Text header or empty canvas", () => {
    for (const zone of ["header", "empty"] as const) {
      const harness = createHarness();
      harness.hit = zone === "header" ? { zone, widgetId: file } : { zone };

      harness.targeting.doubleClick({ offsetX: 10, offsetY: 20 });

      expect(harness.targeting.takeIntents(0)).toMatchObject({
        beginEditingWidgetId: undefined,
        zoomToWidgetId: undefined,
      });
    }
  });

  it("zooms to a minimap widget once", () => {
    const harness = createHarness();
    harness.detailLevel = "minimap";
    harness.hit = { zone: "header", widgetId: file };

    harness.targeting.doubleClick({ offsetX: 10, offsetY: 20 });

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      zoomToWidgetId: file,
      beginEditingWidgetId: undefined,
    });
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      zoomToWidgetId: undefined,
    });
  });

  it("does not zoom on empty minimap space", () => {
    const empty = createHarness();
    empty.detailLevel = "minimap";
    empty.targeting.doubleClick({ offsetX: 10, offsetY: 20 });
    expect(empty.targeting.takeIntents(0)).toMatchObject({
      zoomToWidgetId: undefined,
    });
  });
});

describe("GestureTargeting metrics shortcut", () => {
  it("Shift+KeyM toggles metrics once without exiting editing", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    const preventDefault = vi.fn();
    harness.targeting.keyDown(
      key({ code: "KeyM", shiftKey: true, preventDefault }),
    );

    expect(harness.targeting.editingExitRequested).toBe(false);
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      toggleMetricsOverlay: true,
    });
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      toggleMetricsOverlay: false,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("GestureTargeting pointer targets", () => {
  it("widget header, edges and body produce no intent yet", () => {
    const harness = createHarness();
    const zones: readonly HitZone[] = [
      "header",
      "right-edge",
      "bottom-edge",
      "corner",
      "body",
    ];

    for (const zone of zones) {
      harness.hit = { zone, widgetId: file };
      harness.targeting.pointerDown(pointer());
      harness.targeting.pointerMove(pointer({ offsetX: 20, offsetY: 30 }));
      harness.targeting.pointerUp(pointer());
    }

    expect(harness.targeting.editingExitRequested).toBe(false);
    expect(harness.targeting.takeIntents(0)).toMatchObject({
      panX: 0,
      panY: 0,
    });
  });

  it("Pan by dragging empty space", () => {
    const { targeting } = createHarness();
    targeting.pointerDown(pointer({ offsetX: 10, offsetY: 20 }));
    targeting.pointerMove(pointer({ offsetX: 25, offsetY: 13 }));

    expect(targeting.takeIntents(0)).toMatchObject({ panX: 15, panY: -7 });
  });
});

describe("GestureTargeting widget manipulation", () => {
  it("Dragging by the header", () => {
    const harness = createHarness();
    harness.scale = 0.5;
    harness.hit = { zone: "header", widgetId: file };

    harness.targeting.pointerDown(pointer({ offsetX: 10, offsetY: 20 }));
    harness.targeting.pointerMove(pointer({ offsetX: 35, offsetY: 30 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      moveWidgetId: file,
      moveX: 150,
      moveY: 220,
      resizeWidgetId: undefined,
    });
  });

  it("Releasing over another widget", () => {
    const harness = createHarness();
    harness.hit = { zone: "header", widgetId: file };

    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 30, offsetY: 40 }));
    harness.hit = { zone: "body", widgetId: otherFile };
    harness.targeting.pointerUp(pointer({ offsetX: 30, offsetY: 40 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      bringToFrontId: file,
      moveWidgetId: file,
      moveX: 110,
      moveY: 210,
    });
  });

  it("Stack order", () => {
    const harness = createHarness();
    harness.hit = { zone: "body", widgetId: file };

    harness.targeting.pointerDown(pointer());

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      bringToFrontId: file,
      moveWidgetId: undefined,
      resizeWidgetId: undefined,
    });
  });
});

describe("GestureTargeting resizing", () => {
  it("Increasing height", () => {
    const harness = createHarness();
    harness.hit = { zone: "bottom-edge", widgetId: file };

    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 10, offsetY: 50 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      resizeWidgetId: file,
      resizeWidth: 160,
      resizeHeight: 135,
    });
  });

  it("right edge", () => {
    const harness = createHarness();
    harness.hit = { zone: "right-edge", widgetId: file };

    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 30, offsetY: 20 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      resizeWidgetId: file,
      resizeWidth: 170,
      resizeHeight: 120,
    });
  });

  it("corner", () => {
    const harness = createHarness();
    harness.hit = { zone: "corner", widgetId: file };

    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 30, offsetY: 50 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      resizeWidgetId: file,
      resizeWidth: 170,
      resizeHeight: 135,
    });
  });
});

describe("GestureTargeting pointer follow-up", () => {
  it("Dragging at a far zoom level", () => {
    const harness = createHarness();
    harness.scale = 0.05;
    harness.detailLevel = "minimap";
    harness.hit = { zone: "header", widgetId: file };

    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 15, offsetY: 25 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      moveWidgetId: file,
      moveX: 200,
      moveY: 300,
    });
  });

  it("spacebar pan over a widget", () => {
    const harness = createHarness();
    const preventDefault = vi.fn();
    const space = key({ preventDefault });
    harness.hit = { zone: "body", widgetId: file };

    harness.targeting.keyDown(space);
    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 25, offsetY: 13 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      panX: 15,
      panY: -7,
      bringToFrontId: undefined,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("a refused target produces no bring-to-front", () => {
    const harness = createHarness();
    harness.editing.activeWidgetId = file;
    harness.hit = { zone: "header", widgetId: file };

    harness.targeting.pointerDown(pointer());
    harness.targeting.pointerMove(pointer({ offsetX: 30, offsetY: 40 }));

    expect(harness.targeting.takeIntents(0)).toMatchObject({
      bringToFrontId: undefined,
      moveWidgetId: undefined,
      resizeWidgetId: undefined,
    });
  });

  it("takeIntents returns the same object and resets accumulators", () => {
    const { targeting } = createHarness();
    targeting.wheel(wheel(0, { deltaX: 4, deltaY: 6 }));
    const first = targeting.takeIntents(0);
    const second = targeting.takeIntents(0);

    expect(second).toBe(first);
    expect(second).toMatchObject({
      panX: 0,
      panY: 0,
      zoomFactor: 1,
      scrollDeltaY: 0,
    });
  });
});
