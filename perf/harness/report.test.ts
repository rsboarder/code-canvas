import { describe, expect, it } from "vitest";

import {
  evaluateScenario,
  renderMarkdownReport,
  serializeReport,
  type Baseline,
  type BudgetConfig,
  type Regression,
  type ScenarioRun,
  type Violation,
} from "./report";

const budgets: BudgetConfig = {
  warmupRuns: 1,
  measuredRuns: 5,
  applicationTaskMs: 8,
  longIntervalMs: 12.5,
  allowedRegression: 0.2,
};

const run = (applicationTaskMs: number, p99 = 5): ScenarioRun => ({
  run: 1,
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
): ScenarioRun => ({
  run: 1,
  tracePath: "trace-1.json.gz",
  metrics: {
    applicationTaskMs: 7,
    p99: 5,
    droppedFrames,
    partiallyPresentedFrames,
    longIntervals: 0,
  },
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

describe("frame floor verdicts", () => {
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
