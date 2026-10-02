import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestureInput, WHEEL_GESTURE_END_MS } from "./input";
import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../shared/pinch";

interface FakeWheelEvent {
  readonly deltaX?: number;
  readonly deltaY: number;
  readonly ctrlKey?: boolean;
  readonly offsetX?: number;
  readonly offsetY?: number;
}

interface FakePointerEvent {
  readonly button?: number;
  readonly pointerId?: number;
  readonly clientX?: number;
  readonly clientY?: number;
}

function createFakeCanvas(): {
  readonly canvas: HTMLCanvasElement;
  readonly dispatchWheel: (event: FakeWheelEvent) => void;
  readonly dispatchPointerDown: (event?: FakePointerEvent) => void;
  readonly dispatchPointerUp: (event?: FakePointerEvent) => void;
} {
  const handlers = new Map<string, (event: unknown) => void>();
  const canvas = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler);
    },
    removeEventListener: (type: string) => {
      handlers.delete(type);
    },
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
  };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    dispatchWheel: (event) => {
      handlers.get("wheel")?.({
        deltaX: 0,
        offsetX: 0,
        offsetY: 0,
        ctrlKey: false,
        metaKey: false,
        preventDefault: () => undefined,
        ...event,
      });
    },
    dispatchPointerDown: (event = {}) => {
      handlers.get("pointerdown")?.({
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        ...event,
      });
    },
    dispatchPointerUp: (event = {}) => {
      handlers.get("pointerup")?.({
        pointerId: 1,
        ...event,
      });
    },
  };
}

describe("GestureInput pinch gain", () => {
  it("doubles the zoom factor for ctrl wheel events summing to -K*ln(2)", () => {
    const input = new GestureInput();
    const { canvas, dispatchWheel } = createFakeCanvas();
    input.attach(canvas, () => undefined);

    const totalDeltaY = -PINCH_WHEEL_DELTA_PER_LN_SCALE * Math.log(2);
    const steps = 50;
    for (let index = 0; index < steps; index += 1) {
      dispatchWheel({ deltaY: totalDeltaY / steps, ctrlKey: true });
    }

    const { zoomFactor } = input.consume();
    expect(Math.abs(zoomFactor - 2)).toBeLessThan(1e-9);
  });

  it("clamps a single large ctrl wheel delta to the maximum zoom step", () => {
    const input = new GestureInput();
    const { canvas, dispatchWheel } = createFakeCanvas();
    input.attach(canvas, () => undefined);

    dispatchWheel({
      deltaY: -10 * PINCH_WHEEL_DELTA_PER_LN_SCALE,
      ctrlKey: true,
    });

    const { zoomFactor } = input.consume();
    expect(Math.abs(zoomFactor - Math.exp(MAX_ZOOM_STEP_LN))).toBeLessThan(
      1e-9,
    );
  });

  it("reuses the consumed object and resets accumulated input", () => {
    const input = new GestureInput();
    const { canvas, dispatchWheel } = createFakeCanvas();
    input.attach(canvas, () => undefined);

    dispatchWheel({ deltaX: 4, deltaY: 6 });
    const first = input.consume();
    expect(first).toMatchObject({ panX: -4, panY: -6, zoomFactor: 1 });

    const second = input.consume();
    expect(second).toBe(first);
    expect(second).toMatchObject({ panX: 0, panY: 0, zoomFactor: 1 });
  });
});

function attachTrackingInput(): {
  readonly dispatchWheel: (event: FakeWheelEvent) => void;
  readonly dispatchPointerDown: (event?: FakePointerEvent) => void;
  readonly dispatchPointerUp: (event?: FakePointerEvent) => void;
  readonly changes: boolean[];
} {
  const input = new GestureInput();
  const { canvas, dispatchWheel, dispatchPointerDown, dispatchPointerUp } =
    createFakeCanvas();
  const changes: boolean[] = [];
  input.attach(
    canvas,
    () => undefined,
    undefined,
    (inProgress) => {
      changes.push(inProgress);
    },
  );
  return { dispatchWheel, dispatchPointerDown, dispatchPointerUp, changes };
}

describe("GestureInput gesture boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the gesture on the first wheel event", () => {
    const { dispatchWheel, changes } = attachTrackingInput();

    dispatchWheel({ deltaY: -1 });

    expect(changes).toEqual([true]);
  });

  it("is still in progress after 149 ms of wheel silence", () => {
    const { dispatchWheel, changes } = attachTrackingInput();

    dispatchWheel({ deltaY: -1 });
    vi.advanceTimersByTime(WHEEL_GESTURE_END_MS - 1);

    expect(changes).toEqual([true]);
  });

  it("ends the gesture 150 ms after the last wheel event", () => {
    const { dispatchWheel, changes } = attachTrackingInput();

    dispatchWheel({ deltaY: -1 });
    vi.advanceTimersByTime(WHEEL_GESTURE_END_MS);

    expect(changes).toEqual([true, false]);
  });

  it("restarts the idle timer when a new wheel event arrives before it ends", () => {
    const { dispatchWheel, changes } = attachTrackingInput();

    dispatchWheel({ deltaY: -1 });
    vi.advanceTimersByTime(WHEEL_GESTURE_END_MS - 10);
    dispatchWheel({ deltaY: -1 });
    vi.advanceTimersByTime(WHEEL_GESTURE_END_MS - 10);

    expect(changes).toEqual([true]);

    vi.advanceTimersByTime(10);

    expect(changes).toEqual([true, false]);
  });

  it("reports a pointer drag from pointer down to pointer up", () => {
    const { dispatchPointerDown, dispatchPointerUp, changes } =
      attachTrackingInput();

    dispatchPointerDown();
    dispatchPointerUp();

    expect(changes).toEqual([true, false]);
  });
});
