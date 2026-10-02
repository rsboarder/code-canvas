import { describe, expect, it } from "vitest";

import {
  cameraForScenario,
  cameraRangeWithinTolerance,
  cameraWithinTolerance,
  plannedCamera,
  plannedScaleExtremes,
  type CameraState,
} from "./planned-camera";
import type { Scenario, ScenarioStep } from "../scenarios/schema";

function expectCameraClose(actual: CameraState, expected: CameraState): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.scale).toBeCloseTo(expected.scale, 9);
}

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

describe("plannedCamera", () => {
  it("subtracts a pan step's screen delta from the camera offset", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const steps: ScenarioStep[] = [
      { kind: "pan", x: 600, y: 400, dx: 100, dy: -50, durationMs: 1_000 },
    ];

    expectCameraClose(plannedCamera(initial, steps), {
      x: -100,
      y: 50,
      scale: 1,
    });
  });

  it("clamps a pinch that would zoom past the maximum scale", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const steps: ScenarioStep[] = [
      { kind: "pinch", x: 100, y: 100, scaleFactor: 10, durationMs: 1_000 },
    ];

    expectCameraClose(plannedCamera(initial, steps), {
      x: -300,
      y: -300,
      scale: 4,
    });
  });

  it("clamps a pinch that would zoom past the minimum scale", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const steps: ScenarioStep[] = [
      { kind: "pinch", x: 100, y: 100, scaleFactor: 0.01, durationMs: 1_000 },
    ];

    expectCameraClose(plannedCamera(initial, steps), {
      x: 95,
      y: 95,
      scale: 0.05,
    });
  });

  it("composes a pan followed by a pinch", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const steps: ScenarioStep[] = [
      { kind: "pan", x: 0, y: 0, dx: 50, dy: 20, durationMs: 1_000 },
      { kind: "pinch", x: 300, y: 200, scaleFactor: 2, durationMs: 1_000 },
    ];

    expectCameraClose(plannedCamera(initial, steps), {
      x: -400,
      y: -240,
      scale: 2,
    });
  });

  it("leaves the camera unchanged for non-pan, non-pinch steps", () => {
    const initial: CameraState = { x: 1, y: 2, scale: 3 };
    const steps: ScenarioStep[] = [
      { kind: "scroll", x: 10, y: 10, dy: 100, durationMs: 1_000 },
      { kind: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 1 },
      { kind: "wait", ms: 10 },
    ];

    expectCameraClose(plannedCamera(initial, steps), initial);
  });

  it("round-trips a pinch out then back in at the same cursor", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 0.2 };
    const steps: ScenarioStep[] = [
      { kind: "pinch", x: 600, y: 400, scaleFactor: 20, durationMs: 5_000 },
      { kind: "pinch", x: 600, y: 400, scaleFactor: 0.05, durationMs: 5_000 },
    ];

    expectCameraClose(plannedCamera(initial, steps), initial);
  });
});

describe("cameraWithinTolerance", () => {
  it("accepts a small deviation relative to the planned displacement", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const planned: CameraState = { x: 100, y: 0, scale: 2 };
    const actual: CameraState = { x: 101, y: 0, scale: 2.01 };

    expect(cameraWithinTolerance(initial, planned, actual)).toBe(true);
  });

  it("rejects a deviation beyond the tolerance", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const planned: CameraState = { x: 100, y: 0, scale: 2 };
    const actual: CameraState = { x: 140, y: 0, scale: 2 };

    expect(cameraWithinTolerance(initial, planned, actual)).toBe(false);
  });

  it("falls back to a 2 world-px floor when the planned displacement is tiny", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const planned: CameraState = { x: 0, y: 0, scale: 4 };

    expect(
      cameraWithinTolerance(initial, planned, { x: 1.5, y: 0, scale: 4 }),
    ).toBe(true);
    expect(
      cameraWithinTolerance(initial, planned, { x: 3, y: 0, scale: 4 }),
    ).toBe(false);
  });
});

describe("plannedScaleExtremes", () => {
  it("captures the full round trip's min and max scale", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 0.2 };
    const steps: ScenarioStep[] = [
      { kind: "pinch", x: 600, y: 400, scaleFactor: 20, durationMs: 5_000 },
      { kind: "pinch", x: 600, y: 400, scaleFactor: 0.05, durationMs: 5_000 },
    ];

    expect(plannedScaleExtremes(initial, steps)).toEqual({
      minScale: 0.2,
      maxScale: 4,
    });
  });

  it("clamps the max scale when the product would exceed it", () => {
    const initial: CameraState = { x: 0, y: 0, scale: 1 };
    const steps: ScenarioStep[] = [
      { kind: "pinch", x: 0, y: 0, scaleFactor: 10, durationMs: 1_000 },
    ];

    expect(plannedScaleExtremes(initial, steps)).toEqual({
      minScale: 1,
      maxScale: 4,
    });
  });
});

describe("cameraRangeWithinTolerance", () => {
  it("accepts a recorded range within 2% of the planned extremes", () => {
    const planned = { minScale: 0.2, maxScale: 4 };

    expect(
      cameraRangeWithinTolerance(planned, { minScale: 0.202, maxScale: 3.95 }),
    ).toBe(true);
  });

  it("rejects a recorded range that never reached the planned peak", () => {
    const planned = { minScale: 0.2, maxScale: 4 };

    expect(
      cameraRangeWithinTolerance(planned, { minScale: 0.2, maxScale: 1 }),
    ).toBe(false);
  });
});

describe("cameraForScenario", () => {
  const baseScenario: Scenario = {
    name: "Pan across the whole canvas at zoom 1.0",
    setup: { dataset: "reference" },
    steps: [
      { kind: "pan", x: 600, y: 400, dx: 1_800, dy: -900, durationMs: 5_000 },
    ],
    durationMs: 5_000,
  };

  it("returns undefined when the scenario has no starting camera", () => {
    expect(cameraForScenario(baseScenario)).toBeUndefined();
  });

  it("computes the planned camera when the scenario has a starting camera", () => {
    const scenario: Scenario = {
      ...baseScenario,
      setup: { ...baseScenario.setup, camera: { x: 0, y: 0, scale: 1 } },
    };

    expectCameraClose(assertDefined(cameraForScenario(scenario)), {
      x: -1_800,
      y: 900,
      scale: 1,
    });
  });
});
