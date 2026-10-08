import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { relative, join } from "node:path";
import { promisify } from "node:util";
import { type CDPSession, type Page } from "@playwright/test";

import { checkCoverage, requiredScenarios } from "./coverage";
import {
  classifyNoiseFloor,
  evaluateNoiseFloor,
  measureNoiseFloor,
  type NoiseFloor,
} from "./preflight";
import {
  evaluateScenario,
  renderMarkdownReport,
  renderSummaryTable,
  serializeReport,
  traceArchive,
  type Baseline,
  type BudgetConfig,
  type HarnessMode,
  type HarnessReport,
  type ScenarioRun,
} from "./report";
import { runScenario } from "./scenario-execution";
import { loadBaseline } from "./baseline";
import {
  SETTLE_TIMEOUT_MS,
  unsettledDetail,
  waitForSettledApplication,
} from "./settle";
import {
  errorMessage,
  missingBridgeCommands,
  openReferenceFolder,
  prepareInitialLoadRun,
  prepareScenarioRun,
  waitForApplicationBridge,
} from "./run-preparation";
import { recordTrace, type InvalidMeasurement } from "./trace";
import { openHarnessSession, type HarnessEnvironment } from "./harness-session";
import { scenarioAtDevicePixelRatio } from "./scenario-scale";
import type { PerfFile } from "../../src/performance/bridge";
import { isEditorOnlyScenario, type Scenario } from "../scenarios/schema";
import panScenario from "../scenarios/pan-whole-canvas";
import zoomScenario from "../scenarios/zoom-fit-to-four";
import densityScenario from "../scenarios/worst-case-text-density";
import manipulationScenario from "../scenarios/drag-resize-scroll";
import typingScenario from "../scenarios/typing";
import largeEditScenario from "../scenarios/large-edit";
import lineBreakScenario from "../scenarios/line-break";
import loadScenario from "../scenarios/pan-initial-load";

const execFileAsync = promisify(execFile);
const DEFAULT_DATASET_ROOT = "fixtures/reference-dataset";
export const scenarioList = [
  panScenario,
  zoomScenario,
  densityScenario,
  manipulationScenario,
  typingScenario,
  largeEditScenario,
  lineBreakScenario,
  loadScenario,
];

export interface HarnessResult {
  readonly verdict: "passed" | "failed" | "invalid" | "stage-passed";
  readonly output: string;
  readonly report: HarnessReport;
}

export interface RunnerFileSystem {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<string>;
}

export interface ScenarioRunnerDependencies {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly scenarios?: readonly Scenario[];
  readonly specText?: string;
  readonly noiseFloor?: NoiseFloor;
  readonly environment?: HarnessEnvironment;
  readonly baseline?: Baseline;
  readonly fileSystem?: RunnerFileSystem;
  readonly resultDirectory?: string;
  readonly selectedScenario?: string;
  readonly coverageScenarios?: readonly Scenario[];
  readonly referenceFiles?: readonly PerfFile[];
}

export interface HarnessOptions {
  readonly mode: HarnessMode;
  readonly quick?: boolean;
  readonly scenario?: string;
  readonly budgets: BudgetConfig;
  readonly dependencies?: ScenarioRunnerDependencies;
}

export async function runMeasuredScenarios(
  options: ScenarioRunnerDependencies & {
    readonly mode: HarnessMode;
    readonly budgets: BudgetConfig;
  },
): Promise<HarnessResult> {
  const scenarios = selectScenarios(
    options.scenarios ?? scenarioList,
    options.selectedScenario,
  );
  const coverage = options.specText
    ? checkCoverage(
        requiredScenarios(options.specText),
        (options.coverageScenarios ?? options.scenarios ?? scenarioList).map(
          (item) => item.name,
        ),
      )
    : { missing: [], unknown: [] };
  if (coverage.missing.length > 0 || coverage.unknown.length > 0) {
    return invalidResult(
      options.mode,
      `scenario coverage mismatch: ${coverage.missing.join(", ")}`,
    );
  }
  if (options.mode === "full") {
    const measuredNoiseFloor =
      options.noiseFloor ??
      (await measureNoiseFloor({
        page: options.page,
        cdp: options.cdp,
        durationMs: 60_000,
        recordTrace,
        classifyTrace: classifyNoiseFloor,
      }));
    if ("valid" in measuredNoiseFloor)
      return invalidResult(
        options.mode,
        `noise floor measurement invalid: ${measuredNoiseFloor.reason}${measuredNoiseFloor.detail ? `: ${measuredNoiseFloor.detail}` : ""}`,
        options.environment,
      );
    const noiseFloor = measuredNoiseFloor;
    if (!evaluateNoiseFloor(noiseFloor).valid)
      return invalidResult(
        options.mode,
        "noise floor exceeds the reference threshold",
        options.environment,
        noiseFloor,
      );
    return measureScenarios(options, scenarios, noiseFloor);
  }
  return measureScenarios(options, scenarios, null);
}

async function measureScenarios(
  options: ScenarioRunnerDependencies & {
    readonly mode: HarnessMode;
    readonly budgets: BudgetConfig;
  },
  scenarios: readonly Scenario[],
  noiseFloor: NoiseFloor | null,
): Promise<HarnessResult> {
  if (options.resultDirectory)
    await (options.fileSystem ?? defaultFileSystem).mkdir(
      options.resultDirectory,
    );
  const evaluations = [];
  const devicePixelRatio = await options.page.evaluate(
    () => window.devicePixelRatio,
  );
  for (const scenario of scenarios.map((item) =>
    scenarioAtDevicePixelRatio(item, devicePixelRatio),
  )) {
    const missing = await missingBridgeCommands(options.page, scenario);
    if (missing.length > 0)
      return invalidResult(
        options.mode,
        `${scenario.name}: missing bridge command ${missing.join(", ")}`,
        options.environment,
        noiseFloor,
      );
    const measuredRuns = await collectMeasuredRuns(options, scenario);
    if (!Array.isArray(measuredRuns))
      return invalidResult(
        options.mode,
        invalidMeasurementReason(measuredRuns),
        options.environment,
        noiseFloor,
      );
    const evaluationOptions = {
      scenario: scenario.name,
      runs: measuredRuns,
      budgets: options.budgets,
      noiseFloor: noiseFloor ?? emptyNoiseFloor(),
      durationMs: scenario.durationMs,
      stageTiming: options.mode === "stages",
      frameSamplesExpected: !isEditorOnlyScenario(scenario),
      ...(options.baseline ? { baseline: options.baseline } : {}),
    };
    const evaluation = evaluateScenario(evaluationOptions);
    if (evaluation.verdict === "invalid")
      return invalidResult(
        options.mode,
        `${scenario.name}: unavailable metric ${evaluation.invalidMetrics.join(", ")}`,
        options.environment,
        noiseFloor,
      );
    evaluations.push(evaluation);
  }
  const verdict = evaluations.some((item) => item.verdict === "failed")
    ? "failed"
    : options.mode === "stages"
      ? "stage-passed"
      : "passed";
  const report: HarnessReport = {
    mode: options.mode,
    frameMeasurement: options.mode === "full",
    verdict,
    environment: options.environment ?? null,
    noiseFloor,
    scenarios: evaluations,
  };
  await writeReport(options, report);
  return { verdict, report, output: renderSummaryTable(report) };
}

async function collectMeasuredRuns(
  options: ScenarioRunnerDependencies & {
    readonly mode: HarnessMode;
    readonly budgets: BudgetConfig;
  },
  scenario: Scenario,
): Promise<ScenarioRun[] | InvalidMeasurement> {
  const runs: ScenarioRun[] = [];
  const totalRuns = options.budgets.warmupRuns + options.budgets.measuredRuns;
  for (let run = 0; run < totalRuns; run += 1) {
    const preparation = scenario.setup.initialLoad
      ? await prepareInitialLoadRun(
          options.page,
          scenario,
          options.referenceFiles,
        )
      : await prepareScenarioRun(options.page, scenario);
    if (preparation) return preparation;
    if (!scenario.setup.initialLoad) {
      const settled = await waitForSettledApplication(
        options.page,
        SETTLE_TIMEOUT_MS,
      );
      if (!settled.settled)
        return {
          valid: false,
          reason: "app-not-settled",
          detail: unsettledDetail(scenario.name, "before the run", settled),
        };
    }
    const result = await runScenario(
      options.page,
      options.cdp,
      scenario,
      options.mode,
    );
    if (!result.valid) return result;
    const tracePath = await writeTrace(
      options,
      scenario.name,
      run,
      result.trace,
    );
    if (run >= options.budgets.warmupRuns)
      runs.push({
        run: run - options.budgets.warmupRuns + 1,
        metrics: result.metrics,
        tracePath,
      });
  }
  return runs;
}

function selectScenarios(
  scenarios: readonly Scenario[],
  selected: string | undefined,
): readonly Scenario[] {
  if (!selected) return scenarios;
  return scenarios.filter((scenario) => scenario.name === selected);
}

async function writeTrace(
  options: ScenarioRunnerDependencies,
  name: string,
  run: number,
  trace: readonly object[],
): Promise<string> {
  const tracePath = `${safeName(name)}-${String(run + 1)}.json.gz`;
  const fileSystem = options.fileSystem;
  const directory = options.resultDirectory;
  if (directory)
    await (fileSystem ?? defaultFileSystem).writeFile(
      `${directory}/${tracePath}`,
      traceArchive(trace),
    );
  return tracePath;
}

async function writeReport(
  options: Pick<ScenarioRunnerDependencies, "fileSystem" | "resultDirectory">,
  report: HarnessReport,
): Promise<void> {
  const fileSystem = options.fileSystem;
  const directory = options.resultDirectory;
  if (!directory) return;
  const target = fileSystem ?? defaultFileSystem;
  await target.mkdir(directory);
  await target.writeFile(`${directory}/report.json`, serializeReport(report));
  await target.writeFile(
    `${directory}/report.md`,
    renderMarkdownReport(report),
  );
}

function invalidMeasurementReason(result: InvalidMeasurement): string {
  return result.detail ? `${result.reason}: ${result.detail}` : result.reason;
}

function invalidResult(
  mode: HarnessMode,
  reason: string,
  environment: HarnessEnvironment | null = null,
  noiseFloor: NoiseFloor | null = null,
): HarnessResult {
  const report: HarnessReport = {
    mode,
    frameMeasurement: mode === "full",
    verdict: "invalid",
    environment,
    noiseFloor,
    scenarios: [],
    invalidReason: reason,
  };
  return {
    verdict: "invalid",
    report,
    output: `INVALID MEASUREMENT: ${reason}`,
  };
}

function emptyNoiseFloor(): NoiseFloor {
  return {
    droppedFramesPerMinute: 0,
    partiallyPresentedFramesPerMinute: 0,
    intervalsOver12_5MsPerMinute: 0,
  };
}

function safeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

const defaultFileSystem: RunnerFileSystem = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, data) => {
    await writeFile(path, data);
  },
  readFile: async (path) => readFile(path, "utf8"),
};

export async function runHarness(
  options: HarnessOptions,
): Promise<HarnessResult> {
  if (options.dependencies) {
    return runMeasuredScenarios({
      ...options.dependencies,
      mode: options.mode,
      budgets: options.budgets,
      ...(options.scenario ? { selectedScenario: options.scenario } : {}),
    });
  }
  return runLiveHarness(options);
}

export async function runSelfTest(options: {
  readonly budgets: BudgetConfig;
  readonly page?: Page;
}): Promise<HarnessResult> {
  if (options.page)
    return invalidResult("full", "self-test page injection is unsupported");
  const { runLiveSelfTest } = await import("./self-test");
  return runLiveSelfTest(options.budgets, {
    openReferenceFolder,
    readReferenceFiles,
    runMeasuredScenarios,
    waitForApplicationBridge,
    writeReport,
  });
}

async function runLiveHarness(options: HarnessOptions): Promise<HarnessResult> {
  const session = await openHarnessSession(options.mode);
  if (session.kind === "invalid")
    return invalidResult(
      options.mode,
      session.reason,
      session.environment,
      session.noiseFloor,
    );
  try {
    const { page, cdp, environment, noiseFloor } = session;
    let files: PerfFile[];
    try {
      files = await readReferenceFiles();
    } catch (error: unknown) {
      return invalidResult(
        options.mode,
        `reference dataset read failed: ${errorMessage(error)}`,
      );
    }
    if (files.length === 0)
      return invalidResult(options.mode, "reference dataset is unavailable");
    const openError = await openReferenceFolder(page, files);
    if (openError) return invalidResult(options.mode, openError);
    const baseline = await loadBaseline();
    const dependencies = {
      page,
      cdp,
      mode: options.mode,
      budgets: options.budgets,
      scenarios: filteredScenarios(options),
      coverageScenarios: scenarioList,
      specText: await readFile(
        "openspec/changes/code-canvas/specs/performance-budget/spec.md",
        "utf8",
      ),
      resultDirectory: resultDirectory(options.mode),
      ...(environment ? { environment } : {}),
      ...(noiseFloor ? { noiseFloor } : {}),
      ...(baseline ? { baseline } : {}),
      referenceFiles: files,
    };
    return await runMeasuredScenarios(dependencies);
  } finally {
    await session.close();
  }
}

function filteredScenarios(options: HarnessOptions): readonly Scenario[] {
  const scenarios = options.quick
    ? scenarioList.filter((scenario) => scenario.fast)
    : scenarioList;
  return options.scenario
    ? scenarios.filter((scenario) => scenario.name === options.scenario)
    : scenarios;
}

function resultDirectory(mode: HarnessMode | "self-test"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `perf/results/${timestamp}-${mode}`;
}

export async function readReferenceFiles(
  root = DEFAULT_DATASET_ROOT,
  generate = generateReferenceDataset,
): Promise<PerfFile[]> {
  try {
    await readdir(root);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
    await generate(root);
  }
  const files: PerfFile[] = [];
  await collectDatasetFiles(root, root, files);
  return files;
}

async function generateReferenceDataset(root: string): Promise<void> {
  if (root !== DEFAULT_DATASET_ROOT)
    throw new Error(
      `the fixture generator only writes ${DEFAULT_DATASET_ROOT}`,
    );
  await execFileAsync("pnpm", ["fixtures"]);
}

async function collectDatasetFiles(
  directory: string,
  root: string,
  files: PerfFile[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectDatasetFiles(entryPath, root, files);
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name)) continue;
    files.push({
      path: relative(root, entryPath),
      text: await readFile(entryPath, "utf8"),
    });
  }
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !Object.prototype.hasOwnProperty.call(error, "code")
  )
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
