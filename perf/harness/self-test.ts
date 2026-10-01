import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type CDPSession, type Page } from "@playwright/test";

import type { PerfFile } from "../../src/performance/bridge";
import panScenario from "../scenarios/pan-whole-canvas";
import {
  collectEnvironment,
  evaluateNoiseFloor,
  evaluatePreflight,
  measureNoiseFloor,
  type NoiseFloor,
} from "./preflight";
import { openHarnessPage } from "./harness-page";
import { recordTrace, type TraceMetrics } from "./trace";
import {
  evaluateSelfTest,
  type SelfTestCaseName,
  type SelfTestMeasurement,
} from "./self-test-evaluation";
import type { BudgetConfig, HarnessReport } from "./report";

const GPU_ITERATIONS_FOR_SELF_TEST = 20_000;
const GPU_ITERATIONS_RATIONALE =
  "20,000 iterations was chosen as an intentionally heavy full-screen load above the 8.33 ms frame period; tune it on the reference machine.";

const PREVIEW_PORT = 4173;

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
    readonly environment: Awaited<ReturnType<typeof collectEnvironment>>;
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
  let preview: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await execFileAsync("pnpm", ["build"], {
      env: { ...process.env, VITE_PERF_HARNESS: "1" },
    });
    preview = spawn("pnpm", previewArguments(PREVIEW_PORT), {
      env: process.env,
      stdio: "ignore",
    });
    browser = await chromium.launch({ channel: "chrome", headless: false });
    return await measureLiveSelfTest(browser, budgets, runner);
  } catch (error: unknown) {
    return invalidSelfTestResult(
      `self-test failed to start: ${errorMessage(error)}`,
    );
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      preview?.kill();
    }
  }
}

async function measureLiveSelfTest(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  budgets: BudgetConfig,
  runner: SelfTestRunner,
): Promise<HarnessResult> {
  const page = await openHarnessPage(browser);
  await gotoPreview(page, PREVIEW_PORT);
  if (!(await runner.waitForApplicationBridge(page)))
    return invalidSelfTestResult("application bridge is unavailable");
  const cdp = await page.context().newCDPSession(page);
  const environment = await collectEnvironment(
    browser,
    page,
    cdp,
    runSystemCommand,
  );
  const preflight = evaluatePreflight(environment);
  if (!preflight.valid)
    return invalidSelfTestResult(
      `preflight failed: ${preflight.reasons.join("; ")}`,
      environment,
    );
  const noiseFloor = await measureNoiseFloor({
    page,
    cdp,
    durationMs: 60_000,
    recordTrace,
    classifyTrace: classifyNoiseFloor,
  });
  if (!evaluateNoiseFloor(noiseFloor).valid)
    return invalidSelfTestResult(
      "noise floor exceeds the reference threshold",
      environment,
      noiseFloor,
    );
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
  readonly environment: Awaited<ReturnType<typeof collectEnvironment>>;
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

function classifyNoiseFloor(value: unknown): NoiseFloor {
  if (!isTraceMetrics(value))
    return {
      droppedFramesPerMinute: 0,
      partiallyPresentedFramesPerMinute: 0,
      intervalsOver12_5MsPerMinute: 0,
    };
  const intervals =
    typeof value.intervalsOver12_5Ms === "number"
      ? value.intervalsOver12_5Ms
      : 0;
  return {
    droppedFramesPerMinute: value.frames.dropped,
    partiallyPresentedFramesPerMinute: value.frames.partiallyPresented,
    intervalsOver12_5MsPerMinute: intervals,
  };
}

function isTraceMetrics(value: unknown): value is TraceMetrics {
  return (
    typeof value === "object" &&
    value !== null &&
    "valid" in value &&
    value.valid === true &&
    "frames" in value &&
    typeof value.frames === "object" &&
    value.frames !== null &&
    "intervalsOver12_5Ms" in value
  );
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
  environment: Awaited<ReturnType<typeof collectEnvironment>> | null = null,
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

const execFileAsync = promisify(execFile);

async function runSystemCommand(
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync("sh", ["-lc", command]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: failure.code ?? 1,
    };
  }
}

function previewArguments(port: number): string[] {
  return [
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ];
}

async function gotoPreview(page: Page, port: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await page.goto(`http://127.0.0.1:${String(port)}`);
      return;
    } catch (error: unknown) {
      if (attempt === 19) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}
