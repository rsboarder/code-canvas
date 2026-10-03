import { describe, expect, it } from "vitest";

import type { Scenario } from "../scenarios/schema";
import { scenarioAtDevicePixelRatio } from "./scenario-scale";

const scenario: Scenario = {
  name: "Worst-case text density",
  setup: {
    dataset: "reference",
    camera: { x: 4, y: 5, scale: 0.23 },
    approachScale: 0.3,
    scaleAtDevicePixelRatio: 2,
  },
  steps: [{ kind: "wait", ms: 10 }],
  durationMs: 10,
};
const scenarioWithoutReference: Scenario = {
  ...scenario,
  setup: {
    dataset: "reference",
    camera: { x: 4, y: 5, scale: 0.23 },
    approachScale: 0.3,
  },
};

describe("scenarioAtDevicePixelRatio", () => {
  it("does not convert scenarios without a reference device pixel ratio", () => {
    expect(scenarioAtDevicePixelRatio(scenarioWithoutReference, 1)).toBe(
      scenarioWithoutReference,
    );
  });

  it("converts both setup scales at another device pixel ratio", () => {
    const converted = scenarioAtDevicePixelRatio(scenario, 1);

    expect(converted.setup.camera?.scale).toBe(0.46);
    expect(converted.setup.approachScale).toBe(0.6);
    expect(converted.setup.scaleAtDevicePixelRatio).toBeUndefined();
  });

  it("keeps setup scales unchanged at the reference device pixel ratio", () => {
    const converted = scenarioAtDevicePixelRatio(scenario, 2);

    expect(converted.setup.camera?.scale).toBe(0.23);
    expect(converted.setup.approachScale).toBe(0.3);
    expect(converted.setup.scaleAtDevicePixelRatio).toBeUndefined();
  });

  it("keeps steps unchanged and is idempotent", () => {
    const once = scenarioAtDevicePixelRatio(scenario, 1);
    const twice = scenarioAtDevicePixelRatio(once, 1);

    expect(once.steps).toBe(scenario.steps);
    expect(twice).toEqual(once);
  });
});
