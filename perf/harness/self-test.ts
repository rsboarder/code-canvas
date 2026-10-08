import { type CDPSession, type Page } from "@playwright/test";

import type { PerfFile } from "../../src/performance/bridge";
import panScenario from "../scenarios/pan-whole-canvas";
import { type NoiseFloor } from "./preflight";
import {
  openHarnessSession,
  type FullHarnessSession,
  type HarnessEnvironment,
} from "./harness-session";
import {
  evaluateSelfTest,
  type SelfTestCaseName,
  type SelfTestMeasurement,
} from "./self-test-evaluation";
import type { BudgetConfig, HarnessReport } from "./report";

const GPU_ITERATIONS_FOR_SELF_TEST = 20_000;
const GPU_ITERATIONS_RATIONALE =
  "20,000 iterations was chosen as an intentionally heavy full-screen load above the 8.33 ms frame period; tune it on the reference machine.";

interface SelfTestResult {
  readonly verdict: "passed" | "failed" | "invalid" | "stage-passed";
  readonly output: string;
  readonly report: HarnessReport;
}

type HarnessResult = SelfTestResult;

interface SelfTestRunner {
  readonly openReferenceFolder: (
    page: Page,
    files: PerfFile[],
  ) => Promise<string | undefined>;
  readonly readReferenceFiles: () => Promise<PerfFile[]>;
  readonly runMeasuredScenarios: (options: {
    readonly page: Page;
    readonly cdp: CDPSession;
    readonly mode: "full";
    readonly budgets: BudgetConfig;
    readonly scenarios: readonly (typeof panScenario)[];
    readonly environment: HarnessEnvironment;
    readonly noiseFloor: NoiseFloor;
    readonly resultDirectory: string;
  }) => Promise<SelfTestResult>;
  readonly waitForApplicationBridge: (page: Page) => Promise<boolean>;
  readonly writeReport: (
    options: { readonly resultDirectory: string },
    report: HarnessReport,
  ) => Promise<void>;
}

export async function runLiveSelfTest(
  budgets: BudgetConfig,
  runner: SelfTestRunner,
): Promise<HarnessResult> {
  try {
    const session = await openHarnessSession("full");
    if (session.kind === "invalid")
      return invalidSelfTestResult(
        session.reason,
        session.environment,
        session.noiseFloor,
      );
    try {
      return await measureLiveSelfTest(session, budgets, runner);
    } finally {
      await session.close();
    }
  } catch (error: unknown) {
    return invalidSelfTestResult(
      `self-test failed to start: ${errorMessage(error)}`,
    );
  }
}

async function measureLiveSelfTest(
  session: FullHarnessSession,
  budgets: BudgetConfig,
  runner: SelfTestRunner,
): Promise<HarnessResult> {
  const { page, cdp, environment, noiseFloor } = session;
  const files = await runner.readReferenceFiles();
  if (files.length === 0)
    return invalidSelfTestResult(
      "reference dataset is unavailable",
      environment,
      noiseFloor,
    );
  return finishSelfTest({
    page,
    cdp,
    files,
    budgets,
    environment,
    noiseFloor,
    runner,
  });
}

async function finishSelfTest(
  options: Omit<CaseOptions, "root">,
): Promise<HarnessResult> {
  const root = `perf/results/${new Date().toISOString().replace(/[:.]/gu, "-")}-self-test`;
  const measurements = await measureCases({ ...options, root });
  const evaluation = evaluateSelfTest(
    measurements,
    options.budgets.applicationTaskMs,
    options.noiseFloor,
  );
  const report: HarnessReport = {
    mode: "full",
    frameMeasurement: true,
    verdict: verdictForExitCode(evaluation.exitCode),
    environment: options.environment,
    noiseFloor: options.noiseFloor,
    scenarios: [],
    selfTest: {
      ...evaluation,
      gpuIterations: GPU_ITERATIONS_FOR_SELF_TEST,
      gpuIterationsRationale: GPU_ITERATIONS_RATIONALE,
    },
  };
  await options.runner.writeReport({ resultDirectory: root }, report);
  return {
    verdict: report.verdict,
    report,
    output: renderSelfTestTable(evaluation),
  };
}

interface CaseOptions {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly files: PerfFile[];
  readonly budgets: BudgetConfig;
  readonly environment: HarnessEnvironment;
  readonly noiseFloor: NoiseFloor;
  readonly root: string;
  readonly runner: SelfTestRunner;
}

async function measureCases(
  options: CaseOptions,
): Promise<SelfTestMeasurement[]> {
  const stall = await measureLoadedCase(options, {
    caseName: "Artificial stall detected",
    load: { cpuMs: 12, gpuIterations: 0 },
    directory: `${options.root}/artificial-stall-detected`,
  });
  const gpu = await measureLoadedCase(options, {
    caseName: "Artificial GPU load detected",
    load: { cpuMs: 0, gpuIterations: GPU_ITERATIONS_FOR_SELF_TEST },
    directory: `${options.root}/artificial-gpu-load-detected`,
  });
  await options.page.reload();
  const clean = (await options.runner.waitForApplicationBridge(options.page))
    ? (await setSyntheticLoad(options.page, { cpuMs: 0, gpuIterations: 0 }))
      ? await measureScenario(
          options,
          "Harness produces no false failures",
          `${options.root}/harness-produces-no-false-failures`,
        )
      : invalidMeasurement("Harness produces no false failures")
    : invalidMeasurement("Harness produces no false failures");
  await setSyntheticLoad(options.page, { cpuMs: 0, gpuIterations: 0 });
  return [stall, gpu, clean];
}

async function measureLoadedCase(
  options: CaseOptions,
  caseOptions: {
    readonly caseName: Exclude<
      SelfTestCaseName,
      "Harness produces no false failures"
    >;
    readonly load: { readonly cpuMs: number; readonly gpuIterations: number };
    readonly directory: string;
  },
): Promise<SelfTestMeasurement> {
  const opened = await options.runner.openReferenceFolder(
    options.page,
    options.files,
  );
  if (opened || !(await setSyntheticLoad(options.page, caseOptions.load)))
    return invalidMeasurement(caseOptions.caseName);
  try {
    return await measureScenario(
      options,
      caseOptions.caseName,
      caseOptions.directory,
    );
  } finally {
    await setSyntheticLoad(options.page, { cpuMs: 0, gpuIterations: 0 });
  }
}

async function measureScenario(
  options: CaseOptions,
  caseName: SelfTestCaseName,
  directory: string,
): Promise<SelfTestMeasurement> {
  const result = await options.runner.runMeasuredScenarios({
    page: options.page,
    cdp: options.cdp,
    mode: "full",
    budgets: options.budgets,
    scenarios: [panScenario],
    environment: options.environment,
    noiseFloor: options.noiseFloor,
    resultDirectory: directory,
  });
  const scenario = result.report.scenarios[0];
  const metrics = scenario?.worstRun.metrics;
  if (!scenario || !metrics || result.verdict === "invalid")
    return invalidMeasurement(caseName);
  return {
    caseName,
    valid: true,
    budgetViolation: scenario.violations.length > 0,
    droppedFrames: metrics.droppedFrames,
    partiallyPresentedFrames: metrics.partiallyPresentedFrames,
    applicationTaskMs: metrics.applicationTaskMs,
    durationMs: panScenario.durationMs,
    runs: scenario.runs.map((run) => ({
      droppedFrames: run.metrics.droppedFrames,
      partiallyPresentedFrames: run.metrics.partiallyPresentedFrames,
    })),
  };
}

function invalidMeasurement(caseName: SelfTestCaseName): SelfTestMeasurement {
  return {
    caseName,
    valid: false,
    budgetViolation: false,
    droppedFrames: 0,
    partiallyPresentedFrames: 0,
    applicationTaskMs: "unavailable",
    durationMs: panScenario.durationMs,
    runs: [],
  };
}

async function setSyntheticLoad(
  page: Page,
  load: { readonly cpuMs: number; readonly gpuIterations: number },
): Promise<boolean> {
  const available = await page.evaluate(
    () => typeof window.__perf?.setSyntheticLoad === "function",
  );
  if (!available) return false;
  await page.evaluate((value) => {
    window.__perf?.setSyntheticLoad(value);
  }, load);
  return true;
}

function renderSelfTestTable(evaluation: {
  readonly exitCode: 0 | 1 | 2;
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
}): string {
  const lines = [`VERDICT: ${verdictForExitCode(evaluation.exitCode)}`, ""];
  for (const result of evaluation.cases) {
    lines.push(`${result.caseName}: ${result.passed ? "passed" : "failed"}`);
    for (const item of result.expectations)
      lines.push(
        `  ${item.name}: ${item.passed ? "passed" : "failed"} (expected ${item.expected}, actual ${item.actual})`,
      );
  }
  return lines.join("\n");
}

function verdictForExitCode(
  exitCode: 0 | 1 | 2,
): "passed" | "failed" | "invalid" {
  return exitCode === 0 ? "passed" : exitCode === 1 ? "failed" : "invalid";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidSelfTestResult(
  reason: string,
  environment: HarnessEnvironment | null = null,
  noiseFloor: NoiseFloor | null = null,
): HarnessResult {
  return {
    verdict: "invalid",
    output: `INVALID MEASUREMENT: ${reason}`,
    report: {
      mode: "full",
      frameMeasurement: true,
      verdict: "invalid",
      environment,
      noiseFloor,
      scenarios: [],
      invalidReason: reason,
    },
  };
}
