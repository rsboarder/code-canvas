import { describe, expect, it } from "vitest";

import { PERFORMANCE_SCENARIO_NAMES, scenarioSchema } from "./schema";

const scenario = {
  name: "Pan across the whole canvas at zoom 1.0",
  setup: { dataset: "reference", camera: { x: 0, y: 0, scale: 1 } },
  steps: [
    { kind: "pan", x: 400, y: 300, dx: 300, dy: -120, durationMs: 100 },
    { kind: "pinch", scaleFactor: 1.2, x: 400, y: 300, durationMs: 100 },
    { kind: "scroll", x: 400, y: 300, dy: 80, durationMs: 100 },
    {
      kind: "drag",
      from: { x: 10, y: 20 },
      to: { x: 80, y: 90 },
      durationMs: 100,
    },
    { kind: "type", text: "ab", charsPerSecond: 10 },
    { kind: "wait", ms: 10 },
    { kind: "dblclick", x: 80, y: 90 },
  ],
  durationMs: 500,
};

describe("scenarioSchema", () => {
  it("accepts the supported gesture vocabulary", () => {
    expect(scenarioSchema.parse(scenario)).toEqual(scenario);
    expect(PERFORMANCE_SCENARIO_NAMES).toContain(scenario.name);
  });

  it("rejects an unknown step kind and non-spec scenario name", () => {
    expect(() =>
      scenarioSchema.parse({ ...scenario, name: "made up" }),
    ).toThrow();
    expect(() =>
      scenarioSchema.parse({
        ...scenario,
        steps: [{ kind: "swipe", durationMs: 10 }],
      }),
    ).toThrow();
  });
});
