import { gzipSync } from "node:zlib";

import { evaluateFloorMetric } from "./floor-verdict";
import type { EnvironmentReport } from "./environment";
import type { NoiseFloor } from "./preflight";
import type { FrameCounts } from "./trace";

export type HarnessMode = "full" | "stages";
export type HarnessVerdict = "passed" | "failed" | "invalid" | "stage-passed";
export type ReportStatistic = number | "unavailable";

interface ScenarioBudgetOverride {
  readonly applicationTaskMs?: number;
  readonly extraMissedFramesPerRun?: number;
}

export interface BudgetConfig {
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly applicationTaskMs: number;
  readonly longIntervalMs: number;
  readonly allowedRegression: number;
  readonly stageBudgets?: Readonly<Record<string, number>>;
  readonly scenarioOverrides?: Readonly<Record<string, ScenarioBudgetOverride>>;
}

export interface GestureTiming {
  readonly wallTimeMs: number;
  readonly plannedDurationMs: number;
  readonly ratio: number;
}

export interface CameraSample {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface CameraCheck {
  readonly checked: boolean;
  readonly planned?: CameraSample;
  readonly actual?: CameraSample;
  readonly withinTolerance?: boolean;
}

export interface CameraRangeSample {
  readonly minScale: number;
  readonly maxScale: number;
}

export interface CameraRangeCheck {
  readonly checked: boolean;
  readonly planned?: CameraRangeSample;
  readonly recorded?: CameraRangeSample;
  readonly withinTolerance?: boolean;
}

export interface ScenarioRunMetrics {
  readonly applicationTaskMs: ReportStatistic;
  readonly p99: ReportStatistic;
  readonly droppedFrames: number;
  readonly partiallyPresentedFrames: number;
  readonly longIntervals: number;
  readonly frames?: {
    readonly trace: FrameCounts;
    readonly window: FrameCounts;
  };
  readonly stages?: Readonly<Record<string, { readonly p99: ReportStatistic }>>;
  readonly gesture?: GestureTiming;
  readonly camera?: CameraCheck;
  readonly cameraRange?: CameraRangeCheck;
  readonly tileMemoryBytes?: ReportStatistic;
  readonly tileMemoryMiB?: ReportStatistic;
  readonly missingTileFrameCount?: number;
  readonly timeToSharpMs?: ReportStatistic;
  readonly textSwitchLagMs?: ReportStatistic;
  readonly residencyBacklog?: ReportStatistic;
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
  readonly runsOverAllowance?: number;
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
  readonly floorRelativeMetrics: readonly FloorRelativeMetric[];
}

interface FloorRelativeMetric {
  readonly metric: string;
  readonly allowancePerRun: number;
  readonly actualAtMajorityRank: number;
  readonly runsOverAllowance: number;
  readonly runCount: number;
  readonly fails: boolean;
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

interface EvaluateScenarioOptions {
  readonly scenario: string;
  readonly runs: readonly ScenarioRun[];
  readonly budgets: BudgetConfig;
  readonly noiseFloor: NoiseFloor;
  readonly baseline?: Baseline;
  readonly durationMs: number;
  readonly stageTiming?: boolean;
  readonly frameSamplesExpected?: boolean;
}

export function evaluateScenario({
  scenario,
  runs,
  budgets,
  noiseFloor,
  baseline,
  durationMs,
  stageTiming = false,
  frameSamplesExpected = true,
}: EvaluateScenarioOptions): ScenarioEvaluation {
  if (runs.length === 0)
    throw new RangeError("a scenario needs a measured run");
  const scenarioOverride = budgets.scenarioOverrides?.[scenario];
  const evaluations = runs.map((run) => ({
    run,
    assessment: violationsForRun({
      run,
      budgets,
      stageTiming,
      frameSamplesExpected,
      applicationTaskMs:
        scenarioOverride?.applicationTaskMs ?? budgets.applicationTaskMs,
    }),
  }));
  const worst = evaluations.reduce((current, candidate) =>
    compareWorstRuns(current, candidate) > 0 ? candidate : current,
  );
  const invalidMetrics = unique(
    evaluations.flatMap(
      (evaluation) => evaluation.assessment.unavailableMetrics,
    ),
  );
  const floorRelativeMetrics = stageTiming
    ? []
    : evaluateFloorMetrics(
        runs,
        noiseFloor,
        durationMs,
        scenarioOverride?.extraMissedFramesPerRun ?? 0,
      );
  const floorViolations = floorRelativeMetrics
    .filter((metric) => metric.fails)
    .map((metric) => ({
      metric: metric.metric,
      threshold: metric.allowancePerRun,
      actual: metric.actualAtMajorityRank,
      runsOverAllowance: metric.runsOverAllowance,
    }));
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
        : worst.assessment.violations.length > 0 ||
            floorViolations.length > 0 ||
            regressions.length > 0
          ? "failed"
          : "passed",
    worstRun: worst.run,
    runs,
    violations: [...worst.assessment.violations, ...floorViolations],
    regressions,
    baseline: prior,
    invalidMetrics,
    floorRelativeMetrics,
  };
}

function evaluateFloorMetrics(
  runs: readonly ScenarioRun[],
  noiseFloor: NoiseFloor,
  durationMs: number,
  extraAllowancePerRun: number,
): FloorRelativeMetric[] {
  const metrics = [
    {
      metric: "droppedOrPartiallyPresentedFrames",
      floorPerMinute:
        noiseFloor.droppedFramesPerMinute +
        noiseFloor.partiallyPresentedFramesPerMinute,
      values: runs.map(
        (run) =>
          run.metrics.droppedFrames + run.metrics.partiallyPresentedFrames,
      ),
    },
    {
      metric: "longIntervals",
      floorPerMinute: noiseFloor.intervalsOver12_5MsPerMinute,
      values: runs.map((run) => run.metrics.longIntervals),
    },
  ];
  return metrics.map(({ metric, floorPerMinute, values }) => {
    const verdict = evaluateFloorMetric(
      values,
      floorPerMinute,
      durationMs,
      extraAllowancePerRun,
    );
    return {
      metric,
      allowancePerRun: verdict.allowancePerRun,
      actualAtMajorityRank: verdict.actualAtMajorityRank,
      runsOverAllowance: verdict.runsOverAllowance,
      runCount: verdict.runCount,
      fails: verdict.fails,
    };
  });
}

function compareWorstRuns(
  current: { readonly run: ScenarioRun; readonly assessment: RunAssessment },
  candidate: { readonly run: ScenarioRun; readonly assessment: RunAssessment },
): number {
  const absolute =
    candidate.assessment.violations.length -
    current.assessment.violations.length;
  if (absolute !== 0) return absolute;
  const candidateFrames = frameCount(candidate.run);
  const currentFrames = frameCount(current.run);
  if (candidateFrames !== currentFrames) return candidateFrames - currentFrames;
  const longIntervals =
    candidate.run.metrics.longIntervals - current.run.metrics.longIntervals;
  if (longIntervals !== 0) return longIntervals;
  return compareHigher(
    numericMetric(candidate.run.metrics.p99),
    numericMetric(current.run.metrics.p99),
  );
}

function frameCount(run: ScenarioRun): number {
  return run.metrics.droppedFrames + run.metrics.partiallyPresentedFrames;
}

function numericMetric(value: ReportStatistic): number {
  return typeof value === "number" ? value : Number.NEGATIVE_INFINITY;
}

function compareHigher(candidate: number, current: number): number {
  if (candidate > current) return 1;
  if (candidate < current) return -1;
  return 0;
}

interface RunAssessment {
  readonly violations: Violation[];
  readonly unavailableMetrics: string[];
}

function violationsForRun(options: {
  readonly run: ScenarioRun;
  readonly budgets: BudgetConfig;
  readonly stageTiming: boolean;
  readonly frameSamplesExpected: boolean;
  readonly applicationTaskMs: number;
}): RunAssessment {
  const { run, budgets, stageTiming, frameSamplesExpected, applicationTaskMs } =
    options;
  const violations: Violation[] = [];
  const unavailableMetrics: string[] = [];
  if (
    addMaximum(
      violations,
      "applicationTaskMs",
      run.metrics.applicationTaskMs,
      applicationTaskMs,
    )
  )
    unavailableMetrics.push("applicationTaskMs");
  if (
    stageTiming &&
    (frameSamplesExpected || Object.keys(run.metrics.stages ?? {}).length > 0)
  )
    addStageViolations(
      violations,
      unavailableMetrics,
      run.metrics,
      budgets.stageBudgets,
    );
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
  if (!report.frameMeasurement)
    lines.push(
      "Stage-specific numeric budgets were not specified; stage mode checks the application-task budget only (budgets.json, including per-scenario overrides).",
      "",
    );
  lines.push(
    "| Scenario | Verdict | Worst application task (ms) | p99 (ms) | Dropped/partial over floor | Long intervals over floor | Tile memory (bytes) | Tile memory (MiB) | Missing-tile frames | Time to sharp (ms) | Switch to Text lag (ms) | Residency backlog (max) | Delta |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const scenario of report.scenarios) {
    const metrics = scenario.worstRun.metrics;
    const delta =
      scenario.baseline === "no baseline"
        ? "no baseline"
        : `${String(scenario.regressions.length)} regression(s)`;
    lines.push(
      `| ${scenario.scenario} | ${scenario.verdict} | ${value(metrics.applicationTaskMs)} | ${value(metrics.p99)} | ${floorMetricValue(scenario, "droppedOrPartiallyPresentedFrames")} | ${floorMetricValue(scenario, "longIntervals")} | ${value(metrics.tileMemoryBytes ?? "unavailable")} | ${value(tileMemoryMiB(metrics))} | ${String(metrics.missingTileFrameCount ?? 0)} | ${value(metrics.timeToSharpMs ?? "unavailable")} | ${value(metrics.textSwitchLagMs ?? "unavailable")} | ${value(metrics.residencyBacklog ?? "unavailable")} | ${delta} |`,
    );
  }
  if (report.frameMeasurement) appendRunTable(lines, report.scenarios);
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

function appendRunTable(
  lines: string[],
  scenarios: readonly ScenarioEvaluation[],
): void {
  lines.push(
    "",
    "## Runs",
    "",
    "| Scenario | Run | Trace | Trace frames | Trace wake-up | Presented | Partially presented | Dropped | Window frames | Window wake-up | Window presented | Window partially presented | Window dropped | Intervals > 12.5 ms |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const scenario of scenarios) {
    for (const run of scenario.runs) {
      const trace = run.metrics.frames?.trace;
      const window = run.metrics.frames?.window;
      lines.push(
        `| ${scenario.scenario} | ${String(run.run)} | ${run.tracePath} | ${frameValue(trace, "total")} | ${frameValue(trace, "wakeUp")} | ${frameValue(trace, "presented")} | ${frameValue(trace, "partiallyPresented")} | ${frameValue(trace, "dropped")} | ${frameValue(window, "total")} | ${frameValue(window, "wakeUp")} | ${frameValue(window, "presented")} | ${frameValue(window, "partiallyPresented")} | ${frameValue(window, "dropped")} | ${String(run.metrics.longIntervals)} |`,
      );
    }
  }
}

function frameValue(
  frames: FrameCounts | undefined,
  field: keyof FrameCounts,
): string {
  return frames ? String(frames[field] ?? 0) : "unavailable";
}

function floorMetricValue(
  scenario: ScenarioEvaluation,
  metric: string,
): string {
  const floorMetric = scenario.floorRelativeMetrics.find(
    (item) => item.metric === metric,
  );
  return floorMetric
    ? `${String(floorMetric.runsOverAllowance)}/${String(floorMetric.runCount)}`
    : "unavailable";
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
    metrics: {
      ...run.metrics,
      tileMemoryMiB: tileMemoryMiB(run.metrics),
    },
  };
}

function tileMemoryMiB(metrics: ScenarioRunMetrics): ReportStatistic {
  return typeof metrics.tileMemoryBytes === "number"
    ? metrics.tileMemoryBytes / (1024 * 1024)
    : "unavailable";
}

function value(valueToRender: ReportStatistic): string {
  return typeof valueToRender === "number"
    ? valueToRender.toFixed(2)
    : valueToRender;
}

export function traceArchive(trace: readonly object[]): Uint8Array {
  return gzipSync(JSON.stringify({ traceEvents: trace }));
}
