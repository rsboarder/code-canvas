import { gzipSync } from "node:zlib";

import type { EnvironmentReport } from "./environment";
import type { NoiseFloor } from "./preflight";

export type HarnessMode = "full" | "stages";
export type HarnessVerdict = "passed" | "failed" | "invalid" | "stage-passed";
export type ReportStatistic = number | "unavailable";

export interface BudgetConfig {
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly applicationTaskMs: number;
  readonly longIntervalMs: number;
  readonly allowedRegression: number;
  readonly stageBudgets?: Readonly<Record<string, number>>;
}

export interface ScenarioRunMetrics {
  readonly applicationTaskMs: ReportStatistic;
  readonly p99: ReportStatistic;
  readonly droppedFrames: number;
  readonly partiallyPresentedFrames: number;
  readonly longIntervals: number;
  readonly stages?: Readonly<Record<string, { readonly p99: ReportStatistic }>>;
}

export interface ScenarioRun {
  readonly run: number;
  readonly tracePath: string;
  readonly metrics: ScenarioRunMetrics;
}

export interface Baseline {
  readonly scenarios: Readonly<
    Record<string, Readonly<Record<string, ReportStatistic>>>
  >;
}

export interface Violation {
  readonly metric: string;
  readonly threshold: number;
  readonly actual: number;
}

export interface Regression {
  readonly metric: string;
  readonly baseline: number;
  readonly actual: number;
  readonly allowedDeviation: number;
}

export interface ScenarioEvaluation {
  readonly scenario: string;
  readonly verdict: "passed" | "failed" | "invalid";
  readonly worstRun: ScenarioRun;
  readonly runs: readonly ScenarioRun[];
  readonly violations: readonly Violation[];
  readonly regressions: readonly Regression[];
  readonly baseline: Readonly<Record<string, ReportStatistic>> | "no baseline";
  readonly invalidMetrics: readonly string[];
}

export interface HarnessReport {
  readonly mode: HarnessMode;
  readonly frameMeasurement: boolean;
  readonly verdict: HarnessVerdict;
  readonly environment: EnvironmentReport | null;
  readonly noiseFloor: NoiseFloor | null;
  readonly scenarios: readonly ScenarioEvaluation[];
  readonly invalidReason?: string;
  readonly selfTest?: {
    readonly exitCode: 0 | 1 | 2;
    readonly gpuIterations: number;
    readonly gpuIterationsRationale: string;
    readonly cases: readonly {
      readonly caseName: string;
      readonly passed: boolean;
      readonly expectations: readonly {
        readonly name: string;
        readonly passed: boolean;
        readonly expected: string;
        readonly actual: string;
      }[];
    }[];
  };
}

function noiseFloorFrameAllowance(
  noiseFloor: NoiseFloor,
  durationMs: number,
): number {
  return (
    (noiseFloor.droppedFramesPerMinute +
      noiseFloor.partiallyPresentedFramesPerMinute) *
    (durationMs / 60_000)
  );
}

interface EvaluateScenarioOptions {
  readonly scenario: string;
  readonly runs: readonly ScenarioRun[];
  readonly budgets: BudgetConfig;
  readonly noiseFloor: NoiseFloor;
  readonly baseline?: Baseline;
  readonly durationMs: number;
  readonly stageTiming?: boolean;
}

export function evaluateScenario({
  scenario,
  runs,
  budgets,
  noiseFloor,
  baseline,
  durationMs,
  stageTiming = false,
}: EvaluateScenarioOptions): ScenarioEvaluation {
  if (runs.length === 0)
    throw new RangeError("a scenario needs a measured run");
  const evaluations = runs.map((run) => ({
    run,
    assessment: violationsForRun({
      run,
      budgets,
      noiseFloor,
      durationMs,
      stageTiming,
    }),
  }));
  const worst = evaluations.reduce((current, candidate) =>
    candidate.assessment.violations.length >
    current.assessment.violations.length
      ? candidate
      : current,
  );
  const invalidMetrics = unique(
    evaluations.flatMap(
      (evaluation) => evaluation.assessment.unavailableMetrics,
    ),
  );
  const regressions = baselineRegressions(
    scenario,
    worst.run.metrics,
    baseline,
    budgets,
  );
  const prior = baseline?.scenarios[scenario] ?? "no baseline";
  return {
    scenario,
    verdict:
      invalidMetrics.length > 0
        ? "invalid"
        : worst.assessment.violations.length > 0 || regressions.length > 0
          ? "failed"
          : "passed",
    worstRun: worst.run,
    runs,
    violations: worst.assessment.violations,
    regressions,
    baseline: prior,
    invalidMetrics,
  };
}

interface RunAssessment {
  readonly violations: Violation[];
  readonly unavailableMetrics: string[];
}

function violationsForRun(options: {
  readonly run: ScenarioRun;
  readonly budgets: BudgetConfig;
  readonly noiseFloor: NoiseFloor;
  readonly durationMs: number;
  readonly stageTiming: boolean;
}): RunAssessment {
  const { run, budgets, noiseFloor, durationMs, stageTiming } = options;
  const violations: Violation[] = [];
  const unavailableMetrics: string[] = [];
  if (
    addMaximum(
      violations,
      "applicationTaskMs",
      run.metrics.applicationTaskMs,
      budgets.applicationTaskMs,
    )
  )
    unavailableMetrics.push("applicationTaskMs");
  if (stageTiming)
    addStageViolations(
      violations,
      unavailableMetrics,
      run.metrics,
      budgets.stageBudgets,
    );
  if (!stageTiming) {
    addMaximum(
      violations,
      "droppedOrPartiallyPresentedFrames",
      run.metrics.droppedFrames + run.metrics.partiallyPresentedFrames,
      noiseFloorFrameAllowance(noiseFloor, durationMs),
    );
    addMaximum(
      violations,
      "longIntervals",
      run.metrics.longIntervals,
      noiseFloor.intervalsOver12_5MsPerMinute * (durationMs / 60_000),
    );
  }
  return { violations, unavailableMetrics };
}

function addStageViolations(
  violations: Violation[],
  unavailableMetrics: string[],
  metrics: ScenarioRunMetrics,
  budgets: Readonly<Record<string, number>> | undefined,
): void {
  if (!metrics.stages || Object.keys(metrics.stages).length === 0) {
    unavailableMetrics.push("stages");
    return;
  }
  for (const [stage, stageMetrics] of Object.entries(metrics.stages)) {
    if (stageMetrics.p99 === "unavailable")
      unavailableMetrics.push(`stage.${stage}.p99`);
  }
  if (!budgets) return;
  for (const [stage, threshold] of Object.entries(budgets)) {
    const actual = metrics.stages[stage]?.p99;
    if (
      addMaximum(
        violations,
        `stage.${stage}.p99`,
        actual ?? "unavailable",
        threshold,
      )
    )
      unavailableMetrics.push(`stage.${stage}.p99`);
  }
}

function addMaximum(
  violations: Violation[],
  metric: string,
  actual: ReportStatistic,
  threshold: number,
): boolean {
  if (actual === "unavailable") return true;
  if (actual > threshold) {
    violations.push({ metric, threshold, actual });
  }
  return false;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function baselineRegressions(
  scenario: string,
  metrics: ScenarioRunMetrics,
  baseline: Baseline | undefined,
  budgets: BudgetConfig,
): Regression[] {
  const prior = baseline?.scenarios[scenario];
  if (!prior) return [];
  const regressions: Regression[] = [];
  compareRegression(regressions, {
    metric: "p99",
    baseline: prior.p99 ?? "unavailable",
    actual: metrics.p99,
    allowedDeviation: budgets.allowedRegression,
  });
  return regressions;
}

function compareRegression(
  regressions: Regression[],
  comparison: {
    readonly metric: string;
    readonly baseline: ReportStatistic;
    readonly actual: ReportStatistic;
    readonly allowedDeviation: number;
  },
): void {
  const { metric, baseline, actual, allowedDeviation } = comparison;
  if (typeof baseline !== "number" || typeof actual !== "number") return;
  if (actual > baseline * (1 + allowedDeviation)) {
    regressions.push({ metric, baseline, actual, allowedDeviation });
  }
}

export function renderMarkdownReport(report: HarnessReport): string {
  const mode = report.frameMeasurement
    ? "frame measurement"
    : "not a frame measurement";
  const lines = [
    `# Performance report`,
    ``,
    `Mode: ${mode}`,
    `Verdict: ${report.verdict}`,
    ``,
  ];
  lines.push(
    "| Scenario | Verdict | Worst application task (ms) | p99 (ms) | Delta |",
    "|---|---:|---:|---:|---:|",
  );
  lines.push(
    "",
    "Stage-specific numeric budgets were not specified; stage mode checks the 8 ms application-task budget only.",
  );
  for (const scenario of report.scenarios) {
    const metrics = scenario.worstRun.metrics;
    const delta =
      scenario.baseline === "no baseline"
        ? "no baseline"
        : `${String(scenario.regressions.length)} regression(s)`;
    lines.push(
      `| ${scenario.scenario} | ${scenario.verdict} | ${value(metrics.applicationTaskMs)} | ${value(metrics.p99)} | ${delta} |`,
    );
  }
  if (report.environment)
    lines.push(
      "",
      "## Environment",
      "",
      "```json",
      JSON.stringify(report.environment, null, 2),
      "```",
    );
  if (report.noiseFloor)
    lines.push(
      "",
      "## Noise floor",
      "",
      "```json",
      JSON.stringify(report.noiseFloor, null, 2),
      "```",
    );
  if (report.invalidReason)
    lines.push("", `Invalid reason: ${report.invalidReason}`);
  return `${lines.join("\n")}\n`;
}

export function serializeReport(report: HarnessReport): string {
  const sanitized: HarnessReport = {
    ...report,
    scenarios: report.scenarios.map((scenario) => ({
      ...scenario,
      runs: scenario.runs.map(serializeRun),
      worstRun: serializeRun(scenario.worstRun),
    })),
  };
  return JSON.stringify(sanitized, null, 2);
}

function serializeRun(run: ScenarioRun): ScenarioRun {
  return {
    run: run.run,
    tracePath: run.tracePath,
    metrics: run.metrics,
  };
}

function value(valueToRender: ReportStatistic): string {
  return typeof valueToRender === "number"
    ? valueToRender.toFixed(2)
    : valueToRender;
}

export function traceArchive(trace: readonly object[]): Uint8Array {
  return gzipSync(JSON.stringify({ traceEvents: trace }));
}
