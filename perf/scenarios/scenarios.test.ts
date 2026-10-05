import { describe, expect, it } from "vitest";

import largeEditScenario from "./large-edit";
import panScenario from "./pan-whole-canvas";
import { isEditorOnlyScenario } from "./schema";
import densityScenario from "./worst-case-text-density";
import manipulationScenario from "./drag-resize-scroll";
import lineBreakScenario from "./line-break";
import typingScenario from "./typing";

const fastScenarios = [
  panScenario,
  densityScenario,
  manipulationScenario,
  typingScenario,
];

describe("fast performance scenarios", () => {
  it("fits warm-up plus five measured runs within two minutes", () => {
    const warmupRuns = 1;
    const measuredRuns = 5;
    const totalDurationMs = fastScenarios.reduce(
      (total, scenario) => total + scenario.durationMs,
      0,
    );
    const plannedMs = (warmupRuns + measuredRuns) * totalDurationMs;
    process.stdout.write(
      `quick arithmetic: (${String(warmupRuns)} warm-up + ${String(measuredRuns)} measured) * ${String(totalDurationMs)} ms = ${String(plannedMs)} ms\n`,
    );

    expect(plannedMs).toBeLessThanOrEqual(120_000);
  });
});

describe("editor-only scenarios", () => {
  it("only scenarios without pointer steps are editor-only", () => {
    expect(isEditorOnlyScenario(largeEditScenario)).toBe(true);
    expect(isEditorOnlyScenario(lineBreakScenario)).toBe(true);
    expect(isEditorOnlyScenario(typingScenario)).toBe(false);
  });
});
