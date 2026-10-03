import { describe, expect, it } from "vitest";

import {
  evaluateScenario,
  renderMarkdownReport,
  serializeReport,
  type Baseline,
  type BudgetConfig,
  type Regression,
  type ScenarioRun,
  type ScenarioEvaluation,
  type Violation,
} from "./report";

const budgets: BudgetConfig = {
  warmupRuns: 1,
  measuredRuns: 5,
  applicationTaskMs: 8,
  longIntervalMs: 12.5,
  allowedRegression: 0.2,
};

const run = (
  applicationTaskMs: number,
  p99 = 5,
  runNumber = 1,
): ScenarioRun => ({
  run: runNumber,
  tracePath: "trace-1.json.gz",
  metrics: {
    applicationTaskMs,
    p99,
    droppedFrames: 0,
    partiallyPresentedFrames: 0,
    longIntervals: 0,
  },
});

const runWithFrames = (
  droppedFrames: number,
  partiallyPresentedFrames: number,
  longIntervals = 0,
  runNumber = 1,
): ScenarioRun => ({
  run: runNumber,
  tracePath: "trace-1.json.gz",
  metrics: {
    applicationTaskMs: 7,
    p99: 5,
    droppedFrames,
    partiallyPresentedFrames,
    longIntervals,
  },
});

const frameCountsForRun = (total: number, presented: number) => ({
  trace: { total, presented, partiallyPresented: 1, dropped: 2, idle: 3 },
  window: {
    total: total - 1,
    presented: presented - 1,
    partiallyPresented: 1,
    dropped: 1,
    idle: 0,
  },
});

const evaluationForRuns = (scenario: string): ScenarioEvaluation =>
  evaluateScenario({
    scenario,
    runs: [
      {
        ...run(7, 5, 1),
        tracePath: `${scenario}-1.json.gz`,
        metrics: {
          ...run(7, 5, 1).metrics,
          frames: frameCountsForRun(10, 6),
        },
      },
      {
        ...run(7, 5, 2),
        tracePath: `${scenario}-2.json.gz`,
        metrics: {
          ...run(7, 5, 2).metrics,
          frames: frameCountsForRun(20, 16),
        },
      },
    ],
    budgets,
    noiseFloor: {
      droppedFramesPerMinute: 0,
      partiallyPresentedFramesPerMinute: 0,
      intervalsOver12_5MsPerMinute: 0,
    },
    durationMs: 5_000,
  });

const evaluationFor = (scenario: string) =>
  evaluateScenario({
    scenario,
    runs: [run(7)],
    budgets,
    noiseFloor: {
      droppedFramesPerMinute: 0,
      partiallyPresentedFramesPerMinute: 0,
      intervalsOver12_5MsPerMinute: 0,
    },
    durationMs: 5_000,
  });

describe("scenario verdicts", () => {
  it("uses the worst measured run for a budget verdict", () => {
    expect([] as Violation[]).toEqual([]);
    expect([] as Regression[]).toEqual([]);
    const result = evaluateScenario({
      scenario: "pan",
      runs: [run(7.9), run(9.1), run(7.8), run(7.7), run(7.6)],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
    });

    expect(result.verdict).toBe("failed");
    expect(result.violations).toEqual([
      expect.objectContaining({
        metric: "applicationTaskMs",
        threshold: 8,
        actual: 9.1,
      }),
    ]);
  });

  it("flags a p99 regression even when the budget is met", () => {
    const baseline: Baseline = { scenarios: { pan: { p99: 5 } } };
    const result = evaluateScenario({
      scenario: "pan",
      runs: [run(7, 7.5)],
      budgets,
      baseline,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
    });

    expect(result.verdict).toBe("failed");
    expect(result.regressions).toEqual([
      expect.objectContaining({ metric: "p99", baseline: 5, actual: 7.5 }),
    ]);
  });
});

describe("dropped frame floor verdicts", () => {
  it("One bad run out of five", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        runWithFrames(1, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(result.verdict).toBe("passed");
    expect(result.runs[0]?.metrics.droppedFrames).toBe(1);
    expect(result.floorRelativeMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "droppedOrPartiallyPresentedFrames",
          runsOverAllowance: 1,
          runCount: 5,
        }),
      ]),
    );
  });

  it("A drop that repeats", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        runWithFrames(1, 0),
        runWithFrames(1, 0),
        runWithFrames(1, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(result.verdict).toBe("failed");
    expect(result.violations).toEqual([
      expect.objectContaining({
        metric: "droppedOrPartiallyPresentedFrames",
        actual: 1,
        runsOverAllowance: 3,
      }),
    ]);
  });
});

describe("long interval floor verdicts", () => {
  it("One bad run out of five", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        runWithFrames(0, 0, 1),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(result.verdict).toBe("passed");
    expect(result.runs[0]?.metrics.longIntervals).toBe(1);
    expect(result.floorRelativeMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "longIntervals",
          runsOverAllowance: 1,
          runCount: 5,
        }),
      ]),
    );
  });

  it("A drop that repeats", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        runWithFrames(0, 0, 1),
        runWithFrames(0, 0, 1),
        runWithFrames(0, 0, 1),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(result.verdict).toBe("failed");
    expect(result.violations).toEqual([
      expect.objectContaining({
        metric: "longIntervals",
        actual: 1,
        runsOverAllowance: 3,
      }),
    ]);
  });
});

describe("scenario application-task overrides", () => {
  it("applies a scenario's application-task override", () => {
    const scenarioRuns = [run(12)];
    const overridden = evaluateScenario({
      scenario: "large-edit",
      runs: scenarioRuns,
      budgets: {
        ...budgets,
        scenarioOverrides: { "large-edit": { applicationTaskMs: 16 } },
      },
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });
    const withoutOverride = evaluateScenario({
      scenario: "pan",
      runs: scenarioRuns,
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(overridden.verdict).toBe("passed");
    expect(overridden.violations).toEqual([]);
    expect(withoutOverride.verdict).toBe("failed");
    expect(withoutOverride.violations).toEqual([
      expect.objectContaining({
        metric: "applicationTaskMs",
        threshold: 8,
        actual: 12,
      }),
    ]);
  });
});

describe("application task budget", () => {
  it("fails when one measured run has an application task over 8 ms", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        run(7, 5, 1),
        run(7, 5, 2),
        run(9.1, 5, 3),
        run(7, 5, 4),
        run(7, 5, 5),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(result.verdict).toBe("failed");
    expect(result.worstRun.metrics.applicationTaskMs).toBe(9.1);
    expect(result.violations).toEqual([
      expect.objectContaining({
        metric: "applicationTaskMs",
        threshold: 8,
        actual: 9.1,
      }),
    ]);
  });

  it("uses the third run as worst when it is the only run with a long interval", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        runWithFrames(0, 0, 0, 1),
        runWithFrames(0, 0, 0, 2),
        runWithFrames(0, 0, 1, 3),
        runWithFrames(0, 0, 0, 4),
        runWithFrames(0, 0, 0, 5),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(result.worstRun.run).toBe(3);
    expect(result.worstRun.metrics.longIntervals).toBe(1);
  });
});

describe("scenario floor allowances", () => {
  it("adds a scenario's extra missed frames to the floor allowance", () => {
    const scenarioRuns = (frames: number): ScenarioRun[] =>
      Array.from({ length: 5 }, (_, index) =>
        runWithFrames(frames, 0, 0, index + 1),
      );
    const budgetsWithExtraAllowance: BudgetConfig = {
      ...budgets,
      scenarioOverrides: { pan: { extraMissedFramesPerRun: 2 } },
    };

    const passing = evaluateScenario({
      scenario: "pan",
      runs: scenarioRuns(2),
      budgets: budgetsWithExtraAllowance,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });
    const failing = evaluateScenario({
      scenario: "pan",
      runs: scenarioRuns(3),
      budgets: budgetsWithExtraAllowance,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });

    expect(passing.verdict).toBe("passed");
    expect(failing.verdict).toBe("failed");
    expect(failing.floorRelativeMetrics[0]?.allowancePerRun).toBeGreaterThan(2);
    expect(failing.violations).toEqual([
      expect.objectContaining({
        metric: "droppedOrPartiallyPresentedFrames",
        actual: 3,
      }),
    ]);
  });
});

describe("floor input combinations", () => {
  it("compares dropped and partially presented frames as one floor budget", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [runWithFrames(0, 1)],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 2,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
    });

    expect(result.verdict).toBe("passed");
    expect(result.worstRun.metrics.droppedFrames).toBe(0);
    expect(result.worstRun.metrics.partiallyPresentedFrames).toBe(1);
  });
});

describe("invalid metrics", () => {
  it("marks an unavailable budgeted metric as invalid", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        {
          ...run(7),
          metrics: { ...run(7).metrics, applicationTaskMs: "unavailable" },
        },
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
    });

    expect(result.verdict).toBe("invalid");
    expect(result.invalidMetrics).toContain("applicationTaskMs");
  });

  it("marks unavailable stage data as invalid in stage timing mode", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        {
          ...run(7),
          metrics: {
            ...run(7).metrics,
            stages: { draw: { p99: "unavailable" } },
          },
        },
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
      stageTiming: true,
    });

    expect(result.verdict).toBe("invalid");
    expect(result.invalidMetrics).toContain("stage.draw.p99");
  });
});

describe("stage sample expectations", () => {
  it("accepts a stage run without Frame Samples when the scenario expects none", () => {
    const result = evaluateScenario({
      scenario: "large-edit",
      runs: [
        {
          ...run(7),
          metrics: { ...run(7).metrics, stages: {} },
        },
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
      stageTiming: true,
      frameSamplesExpected: false,
    });

    expect(result.verdict).toBe("passed");
    expect(result.invalidMetrics).toEqual([]);
  });

  it("still checks the application task when no Frame Sample is expected", () => {
    const result = evaluateScenario({
      scenario: "large-edit",
      runs: [
        {
          ...run(20),
          metrics: { ...run(20).metrics, stages: {} },
        },
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
      stageTiming: true,
      frameSamplesExpected: false,
    });

    expect(result.verdict).toBe("failed");
    expect(result.violations).toEqual([
      expect.objectContaining({ metric: "applicationTaskMs" }),
    ]);
  });

  it("marks a stage run without Frame Samples invalid when the scenario expects them", () => {
    const result = evaluateScenario({
      scenario: "pan",
      runs: [
        {
          ...run(7),
          metrics: { ...run(7).metrics, stages: {} },
        },
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
      stageTiming: true,
    });

    expect(result.verdict).toBe("invalid");
    expect(result.invalidMetrics).toContain("stages");
  });
});

describe("stage reports", () => {
  it("marks stage reports as not frame measurements", () => {
    const markdown = renderMarkdownReport({
      mode: "stages",
      frameMeasurement: false,
      verdict: "stage-passed",
      scenarios: [],
      environment: null,
      noiseFloor: null,
    });

    expect(markdown).toContain("not a frame measurement");
    expect(markdown).not.toContain("frame verdict");
  });
});

describe("Markdown report table", () => {
  it("keeps full-mode scenario rows directly after the table separator", () => {
    const markdown = renderMarkdownReport({
      mode: "full",
      frameMeasurement: true,
      verdict: "passed",
      scenarios: [evaluationFor("pan"), evaluationFor("zoom")],
      environment: null,
      noiseFloor: null,
    });
    const lines = markdown.trimEnd().split("\n");
    const separatorIndex = lines.findIndex((line) => line.startsWith("|---|"));

    expect(lines[separatorIndex + 1]?.startsWith("| pan |")).toBe(true);
    expect(lines[separatorIndex + 2]?.startsWith("| zoom |")).toBe(true);
    expect(markdown).not.toContain("Stage-specific numeric budgets");
  });

  it("keeps stage-mode rows in the table after the stage-mode sentence", () => {
    const markdown = renderMarkdownReport({
      mode: "stages",
      frameMeasurement: false,
      verdict: "stage-passed",
      scenarios: [evaluationFor("pan"), evaluationFor("zoom")],
      environment: null,
      noiseFloor: null,
    });
    const lines = markdown.trimEnd().split("\n");
    const sentenceIndex = lines.findIndex((line) =>
      line.startsWith("Stage-specific numeric budgets"),
    );
    const headerIndex = lines.findIndex((line) =>
      line.startsWith("| Scenario |"),
    );
    const separatorIndex = lines.findIndex((line) => line.startsWith("|---|"));

    expect(sentenceIndex).toBeGreaterThan(-1);
    expect(sentenceIndex).toBeLessThan(headerIndex);
    expect(lines[separatorIndex + 1]?.startsWith("| pan |")).toBe(true);
    expect(lines[separatorIndex + 2]?.startsWith("| zoom |")).toBe(true);
  });

  it("does not render run frame counts in stage mode", () => {
    const markdown = renderMarkdownReport({
      mode: "stages",
      frameMeasurement: false,
      verdict: "stage-passed",
      scenarios: [evaluationFor("pan")],
      environment: null,
      noiseFloor: null,
    });

    expect(markdown).not.toContain("## Runs");
  });
});

describe("per-run Markdown report table", () => {
  it("renders one frame-count row for every measured run", () => {
    const markdown = renderMarkdownReport({
      mode: "full",
      frameMeasurement: true,
      verdict: "passed",
      scenarios: [evaluationForRuns("pan"), evaluationForRuns("zoom")],
      environment: null,
      noiseFloor: null,
    });
    const lines = markdown.trimEnd().split("\n");
    const mainSeparatorIndex = lines.findIndex((line) =>
      line.startsWith(
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      ),
    );
    const runsSeparatorIndex = lines.indexOf("## Runs") + 3;

    expect(lines[runsSeparatorIndex + 1]).toBe(
      "| pan | 1 | pan-1.json.gz | 10 | 6 | 1 | 2 | 9 | 5 | 1 | 1 | 0 |",
    );
    expect(lines[runsSeparatorIndex + 2]).toBe(
      "| pan | 2 | pan-2.json.gz | 20 | 16 | 1 | 2 | 19 | 15 | 1 | 1 | 0 |",
    );
    expect(lines[runsSeparatorIndex + 3]).toBe(
      "| zoom | 1 | zoom-1.json.gz | 10 | 6 | 1 | 2 | 9 | 5 | 1 | 1 | 0 |",
    );
    expect(lines[runsSeparatorIndex + 4]).toBe(
      "| zoom | 2 | zoom-2.json.gz | 20 | 16 | 1 | 2 | 19 | 15 | 1 | 1 | 0 |",
    );
    expect(markdown).toContain("## Runs");
    expect(mainSeparatorIndex).toBeLessThan(runsSeparatorIndex);
  });
});

describe("tile reports", () => {
  it("renders tile metrics in Markdown and serialized JSON", () => {
    const evaluation = evaluateScenario({
      scenario: "pan",
      runs: [
        {
          ...run(7),
          metrics: {
            ...run(7).metrics,
            tileMemoryBytes: 2 * 1024 * 1024,
            missingTileFrameCount: 3,
            timeToSharpMs: 42,
          },
        },
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
    });
    const report = {
      mode: "full" as const,
      frameMeasurement: true,
      verdict: "passed" as const,
      scenarios: [evaluation],
      environment: null,
      noiseFloor: null,
    };

    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("Tile memory (bytes)");
    expect(markdown).toContain("2097152.00");
    expect(markdown).toContain("2.00");
    expect(markdown).toContain("| 3 | 42.00 |");

    const serialized = JSON.parse(serializeReport(report)) as {
      scenarios: [{ worstRun: { metrics: { tileMemoryMiB: number } } }];
    };
    expect(serialized.scenarios[0].worstRun.metrics.tileMemoryMiB).toBe(2);
  });
});

describe("floor report counts", () => {
  it("renders floor allowance exceedances in Markdown and JSON", () => {
    const evaluation = evaluateScenario({
      scenario: "pan",
      runs: [
        runWithFrames(1, 0, 1),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
        runWithFrames(0, 0),
      ],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 5_000,
    });
    const report = {
      mode: "full" as const,
      frameMeasurement: true,
      verdict: "passed" as const,
      scenarios: [evaluation],
      environment: null,
      noiseFloor: null,
    };

    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("Dropped/partial over floor");
    expect(markdown).toContain("Long intervals over floor");
    expect(markdown).toContain("1/5");

    const serialized = JSON.parse(serializeReport(report)) as {
      scenarios: [{ floorRelativeMetrics: [{ runsOverAllowance: number }] }];
    };
    expect(
      serialized.scenarios[0].floorRelativeMetrics[0].runsOverAllowance,
    ).toBe(1);
  });
});

describe("report serialization", () => {
  it("keeps trace paths without serializing trace events", () => {
    const tracePath = "pan-across-the-whole-canvas-at-zoom-1-1.json.gz";
    const runWithTrace = {
      ...run(7),
      tracePath,
      trace: [{ name: "trace-event", payload: "x".repeat(1_000_000) }],
    } as unknown as ScenarioRun;
    const evaluation = evaluateScenario({
      scenario: "pan",
      runs: [runWithTrace],
      budgets,
      noiseFloor: {
        droppedFramesPerMinute: 0,
        partiallyPresentedFramesPerMinute: 0,
        intervalsOver12_5MsPerMinute: 0,
      },
      durationMs: 60_000,
    });

    const serialized = serializeReport({
      mode: "full",
      frameMeasurement: true,
      verdict: "passed",
      scenarios: [evaluation],
      environment: null,
      noiseFloor: null,
    });

    expect(serialized).toContain(tracePath);
    expect(serialized).not.toContain("trace-event");
    expect(serialized).not.toContain("payload");
  });
});
