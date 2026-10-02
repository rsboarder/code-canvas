import { evaluateFloorMetric } from "./floor-verdict";
import type { NoiseFloor } from "./preflight";

export const SELF_TEST_CASE_NAMES = [
  "Artificial stall detected",
  "Artificial GPU load detected",
  "Harness produces no false failures",
] as const;

export type SelfTestCaseName = (typeof SELF_TEST_CASE_NAMES)[number];

export interface SelfTestRunFrames {
  readonly droppedFrames: number;
  readonly partiallyPresentedFrames: number;
}

export interface SelfTestMeasurement {
  readonly caseName: SelfTestCaseName;
  readonly valid: boolean;
  readonly budgetViolation: boolean;
  readonly droppedFrames: number;
  readonly partiallyPresentedFrames: number;
  readonly applicationTaskMs: number | "unavailable";
  readonly durationMs: number;
  readonly runs: readonly SelfTestRunFrames[];
}

interface SelfTestExpectation {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

interface SelfTestCaseResult {
  readonly caseName: SelfTestCaseName;
  readonly passed: boolean;
  readonly expectations: readonly SelfTestExpectation[];
}

interface SelfTestEvaluation {
  readonly exitCode: 0 | 1 | 2;
  readonly cases: readonly SelfTestCaseResult[];
}

export function evaluateSelfTest(
  measurements: readonly SelfTestMeasurement[],
  applicationTaskBudgetMs: number,
  noiseFloor: NoiseFloor,
): SelfTestEvaluation {
  const byName = new Map(
    measurements.map((measurement) => [measurement.caseName, measurement]),
  );
  const cases = SELF_TEST_CASE_NAMES.map((caseName) =>
    selfTestCaseResult(
      caseName,
      byName.get(caseName),
      applicationTaskBudgetMs,
      noiseFloor,
    ),
  );
  const invalid =
    measurements.some((measurement) => !measurement.valid) ||
    measurements.length !== SELF_TEST_CASE_NAMES.length ||
    cases.some((result) => result.expectations.length === 0);
  return {
    exitCode: invalid ? 2 : cases.every((result) => result.passed) ? 0 : 1,
    cases,
  };
}

function selfTestCaseResult(
  caseName: SelfTestCaseName,
  measurement: SelfTestMeasurement | undefined,
  applicationTaskBudgetMs: number,
  noiseFloor: NoiseFloor,
): SelfTestCaseResult {
  if (!measurement) return { caseName, passed: false, expectations: [] };
  const expectations = expectationsForCase(
    caseName,
    measurement,
    applicationTaskBudgetMs,
    noiseFloor,
  );
  return {
    caseName,
    passed: measurement.valid && expectations.every((item) => item.passed),
    expectations,
  };
}

function expectationsForCase(
  caseName: SelfTestCaseName,
  measurement: SelfTestMeasurement,
  applicationTaskBudgetMs: number,
  noiseFloor: NoiseFloor,
): SelfTestExpectation[] {
  if (caseName === "Artificial stall detected")
    return [
      expectation(
        "budget violation",
        measurement.budgetViolation,
        "true",
        String(measurement.budgetViolation),
      ),
      expectation(
        "dropped frames",
        measurement.droppedFrames > 0,
        "> 0",
        String(measurement.droppedFrames),
      ),
    ];
  if (caseName === "Artificial GPU load detected")
    return [
      expectation(
        "dropped or partially presented frames",
        measurement.droppedFrames + measurement.partiallyPresentedFrames > 0,
        "> 0",
        String(
          measurement.droppedFrames + measurement.partiallyPresentedFrames,
        ),
      ),
      expectation(
        "application task budget",
        typeof measurement.applicationTaskMs === "number" &&
          measurement.applicationTaskMs <= applicationTaskBudgetMs,
        `<= ${String(applicationTaskBudgetMs)}`,
        String(measurement.applicationTaskMs),
      ),
    ];
  const actualPerRun = measurement.runs.map(
    (run) => run.droppedFrames + run.partiallyPresentedFrames,
  );
  const floorVerdict = evaluateFloorMetric(
    actualPerRun,
    noiseFloor.droppedFramesPerMinute +
      noiseFloor.partiallyPresentedFramesPerMinute,
    measurement.durationMs,
  );
  return [
    expectation(
      "dropped or partially presented frames across measured runs",
      !floorVerdict.fails,
      `<= ${String(floorVerdict.allowancePerRun)} in a majority of ${String(floorVerdict.runCount)} runs`,
      `${actualPerRun.join(", ")} (${String(floorVerdict.runsOverAllowance)}/${String(floorVerdict.runCount)} runs over)`,
    ),
  ];
}

function expectation(
  name: string,
  passed: boolean,
  expected: string,
  actual: string,
): SelfTestExpectation {
  return { name, passed, expected, actual };
}
