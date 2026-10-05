import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  checkCoverage,
  requiredScenarios,
  type CoverageResult,
} from "./coverage";

const performanceBudgetSpec = readFileSync(
  new URL(
    "../../openspec/changes/code-canvas/specs/performance-budget/spec.md",
    import.meta.url,
  ),
  "utf8",
);

describe("performance budget scenario coverage", () => {
  it("discovers the frame-budget and background-stall scenarios from the real spec", () => {
    expect(requiredScenarios(performanceBudgetSpec)).toEqual([
      "Pan across the whole canvas at zoom 1.0",
      'Zoom from "Fit all" to 4.0 and back',
      "Worst-case text density",
      "Drag, resize and scroll inside a widget",
      "Typing",
      "Large edit in the editor",
      "Line break in the editor",
      "Pan during initial load",
    ]);
  });

  it("reports missing and unknown harness scenarios", () => {
    const result: CoverageResult = checkCoverage(
      ["Pan", "Zoom"],
      ["Pan", "Unexpected"],
    );
    expect(result).toEqual({
      missing: ["Zoom"],
      unknown: ["Unexpected"],
    });
  });

  it("ignores scenarios under unrelated requirements", () => {
    const spec = `
### Requirement: Other
#### Scenario: Ignore me

### Requirement: Frame budget
#### Scenario: Keep me

### Requirement: No background stalls
#### Scenario: Keep this too
`;

    expect(requiredScenarios(spec)).toEqual(["Keep me", "Keep this too"]);
  });
});
