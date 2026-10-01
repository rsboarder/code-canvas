import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { relative, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type CDPSession, type Page } from "@playwright/test";

import { checkCoverage, requiredScenarios } from "./coverage";
import { runEvents, planEvents } from "./driver";
import {
  collectEnvironment,
  evaluateNoiseFloor,
  evaluatePreflight,
  measureNoiseFloor,
  type NoiseFloor,
} from "./preflight";
import {
  evaluateScenario,
  renderMarkdownReport,
  serializeReport,
  traceArchive,
  type Baseline,
  type BudgetConfig,
  type HarnessMode,
  type HarnessReport,
  type ScenarioRun,
  type ScenarioRunMetrics,
} from "./report";
import {
  classifyTrace,
  recordTrace,
  type InvalidMeasurement,
  type TraceClassification,
  type TraceEvents,
  type TraceMetrics,
} from "./trace";
import { bridgeMetricsFromSnapshot, type BridgeMetrics } from "./metrics";
import { openHarnessPage } from "./harness-page";
import type { PerfFile } from "../../src/performance/bridge";
import type { Scenario } from "../scenarios/schema";
import panScenario from "../scenarios/pan-whole-canvas";
import zoomScenario from "../scenarios/zoom-fit-to-four";
import densityScenario from "../scenarios/worst-case-text-density";
import manipulationScenario from "../scenarios/drag-resize-scroll";
import typingScenario from "../scenarios/typing";
import loadScenario from "../scenarios/pan-initial-load";

const execFileAsync = promisify(execFile);
const DEFAULT_DATASET_ROOT = "fixtures/reference-dataset";
const DEFAULT_PREVIEW_PORT = 4173;
const BRIDGE_WAIT_TIMEOUT_MS = 10_000;
const scenarioList = [
  panScenario,
  zoomScenario,
  densityScenario,
  manipulationScenario,
  typingScenario,
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
  readonly environment?: Awaited<ReturnType<typeof collectEnvironment>>;
  readonly baseline?: Baseline;
  readonly fileSystem?: RunnerFileSystem;
  readonly resultDirectory?: string;
  readonly selectedScenario?: string;
  readonly coverageScenarios?: readonly Scenario[];
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
    const noiseFloor =
      options.noiseFloor ??
      (await measureNoiseFloor({
        page: options.page,
        cdp: options.cdp,
        durationMs: 60_000,
        recordTrace,
        classifyTrace: classifyNoiseFloor,
      }));
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
  for (const scenario of scenarios) {
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
        measuredRuns.reason,
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
  return { verdict, report, output: renderTable(report) };
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
    await prepareScenarioRun(options.page, scenario);
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

async function runScenario(
  page: Page,
  cdp: CDPSession,
  scenario: Scenario,
  mode: HarnessMode,
): Promise<ScenarioExecution | InvalidMeasurement> {
  const events = planEvents(scenario, 120);
  const bridgeAvailable = await page.evaluate(
    () => typeof window.__perf?.snapshot === "function",
  );
  if (!bridgeAvailable) return { valid: false, reason: "app-bridge-missing" };
  await page.evaluate(() => window.__perf?.reset());
  const result = await recordTrace(cdp, () =>
    recordScenarioAction(cdp, events),
  );
  const bridgeMetrics = await readBridgeMetrics(page);
  const classified = await classifyTrace(result, {
    applicationMarkers: ["127.0.0.1", "localhost"],
    bridgeMetrics,
  });
  if (mode === "stages")
    return stageClassification(classified, result, bridgeMetrics);
  if (!classified.valid) return classified;
  return { valid: true, metrics: metricsFromTrace(classified), trace: result };
}

interface ScenarioExecution {
  readonly valid: true;
  readonly metrics: ScenarioRunMetrics;
  readonly trace: TraceEvents;
}

async function recordScenarioAction(
  cdp: CDPSession,
  events: ReturnType<typeof planEvents>,
): Promise<void> {
  await runEvents(cdp, events);
}

function stageClassification(
  classified: TraceClassification,
  trace: TraceEvents,
  bridge: BridgeMetrics,
): ScenarioExecution {
  if (classified.valid)
    return { valid: true, metrics: metricsFromTrace(classified), trace };
  const tasks = trace.filter(
    (event) => event.name === "RunTask" && typeof event.dur === "number",
  );
  const longest = tasks.reduce(
    (max, event) => Math.max(max, (event.dur ?? 0) / 1_000),
    0,
  );
  return {
    valid: true,
    metrics: {
      applicationTaskMs: longest,
      p99: "unavailable",
      droppedFrames: 0,
      partiallyPresentedFrames: 0,
      longIntervals: 0,
      stages: bridge.stages,
    },
    trace,
  };
}

async function readBridgeMetrics(page: Page): Promise<BridgeMetrics> {
  const snapshot = await page.evaluate(() => window.__perf?.snapshot());
  return bridgeMetricsFromSnapshot(snapshot);
}

function metricsFromTrace(metrics: TraceMetrics): ScenarioRunMetrics {
  return {
    applicationTaskMs: metrics.longestApplicationTaskMs,
    p99: metrics.intervalsMs.p99,
    droppedFrames: metrics.frames.dropped,
    partiallyPresentedFrames: metrics.frames.partiallyPresented,
    longIntervals:
      typeof metrics.intervalsOver12_5Ms === "number"
        ? metrics.intervalsOver12_5Ms
        : 0,
    stages: metrics.stages,
  };
}

function selectScenarios(
  scenarios: readonly Scenario[],
  selected: string | undefined,
): readonly Scenario[] {
  if (!selected) return scenarios;
  return scenarios.filter((scenario) => scenario.name === selected);
}

export async function missingBridgeCommands(
  page: Page,
  scenario: Scenario,
): Promise<string[]> {
  const required = [...(scenario.setup.requiresBridgeCommands ?? [])];
  if (scenario.setup.camera && !required.includes("setCamera"))
    required.push("setCamera");
  return page.evaluate((commands) => {
    const bridge = window.__perf as unknown as
      Record<string, unknown> | undefined;
    return commands.filter(
      (command) => typeof bridge?.[command] !== "function",
    );
  }, required);
}

export async function prepareScenarioRun(
  page: Page,
  scenario: Scenario,
): Promise<void> {
  const camera = scenario.setup.camera;
  if (!camera) return;
  await page.evaluate(
    (value) => window.__perf?.setCamera(value.x, value.y, value.scale),
    camera,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
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

function renderTable(report: HarnessReport): string {
  const lines = [
    `VERDICT: ${report.verdict}`,
    "",
    "Scenario | App task ms | p99 ms | Delta to baseline",
    "--- | ---: | ---: | ---:",
  ];
  for (const scenario of report.scenarios)
    lines.push(
      `${scenario.scenario} | ${format(scenario.worstRun.metrics.applicationTaskMs)} | ${format(scenario.worstRun.metrics.p99)} | ${String(scenario.regressions.length)}`,
    );
  return lines.join("\n");
}

function format(value: number | "unavailable"): string {
  return typeof value === "number" ? value.toFixed(2) : value;
}

function invalidResult(
  mode: HarnessMode,
  reason: string,
  environment: Awaited<ReturnType<typeof collectEnvironment>> | null = null,
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

function classifyNoiseFloor(result: unknown): NoiseFloor {
  if (!isTraceClassification(result)) return emptyNoiseFloor();
  const intervals =
    typeof result.intervalsOver12_5Ms === "number"
      ? result.intervalsOver12_5Ms
      : 0;
  return {
    droppedFramesPerMinute: result.frames.dropped,
    partiallyPresentedFramesPerMinute: result.frames.partiallyPresented,
    intervalsOver12_5MsPerMinute: intervals,
  };
}

function isTraceClassification(value: unknown): value is TraceMetrics {
  return (
    isRecord(value) &&
    value.valid === true &&
    isRecord(value.frames) &&
    isRecord(value.intervalsMs)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

export async function loadBudgetConfig(
  path = "perf/budgets.json",
): Promise<BudgetConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    { value: number } | number
  >;
  return {
    warmupRuns: budgetValue(raw.warmupRuns),
    measuredRuns: budgetValue(raw.measuredRuns),
    applicationTaskMs: budgetValue(raw.applicationTaskMs),
    longIntervalMs: budgetValue(raw.longIntervalMs),
    allowedRegression: budgetValue(raw.allowedRegression),
  };
}

function budgetValue(value: { value: number } | number | undefined): number {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  throw new TypeError("budget value is missing");
}

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
  let preview: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await execFileAsync("pnpm", ["build"], {
      env: { ...process.env, VITE_PERF_HARNESS: "1" },
    });
    preview = spawn("pnpm", previewArguments(DEFAULT_PREVIEW_PORT), {
      env: process.env,
      stdio: "ignore",
    });
    browser = await chromium.launch({
      channel: "chrome",
      headless: options.mode === "stages",
    });
    const page = await openHarnessPage(browser);
    await gotoPreview(page, DEFAULT_PREVIEW_PORT);
    if (!(await waitForApplicationBridge(page)))
      return invalidResult(options.mode, "application bridge is unavailable");
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
    const cdp = await page.context().newCDPSession(page);
    const environment =
      options.mode === "full"
        ? await collectEnvironment(browser, page, cdp, runSystemCommand)
        : undefined;
    const preflight = environment && evaluatePreflight(environment);
    if (preflight && !preflight.valid)
      return invalidResult(
        options.mode,
        `preflight failed: ${preflight.reasons.join("; ")}`,
        environment,
      );
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
      ...(baseline ? { baseline } : {}),
    };
    return await runMeasuredScenarios(dependencies);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      preview?.kill();
    }
  }
}

export function previewArguments(port: number): string[] {
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

export function previewUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

export async function waitForApplicationBridge(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(() => window.__perf !== undefined, undefined, {
      timeout: BRIDGE_WAIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function openReferenceFolder(
  page: Page,
  files: PerfFile[],
): Promise<string | undefined> {
  try {
    await page.evaluate(
      (referenceFiles) => window.__perf?.openFolder(referenceFiles),
      files,
    );
    return undefined;
  } catch (error: unknown) {
    return `application bridge openFolder failed: ${errorMessage(error)}`;
  }
}

async function gotoPreview(page: Page, port: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await page.goto(previewUrl(port));
      return;
    } catch (error: unknown) {
      if (attempt === 19) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function loadBaseline(): Promise<Baseline | undefined> {
  try {
    const raw = JSON.parse(await readFile("perf/baseline.json", "utf8")) as {
      scenarios?: unknown;
    };
    if (!Array.isArray(raw.scenarios)) return raw as Baseline;
    const scenarios: Record<string, { p99: number | "unavailable" }> = {};
    for (const scenario of raw.scenarios) {
      if (!isRecord(scenario) || typeof scenario.scenario !== "string")
        continue;
      const worstRun = isRecord(scenario.worstRun)
        ? scenario.worstRun
        : undefined;
      const metrics =
        worstRun && isRecord(worstRun.metrics) ? worstRun.metrics : undefined;
      scenarios[scenario.scenario] = { p99: statistic(metrics?.p99) };
    }
    return { scenarios };
  } catch {
    return undefined;
  }
}

function statistic(value: unknown): number | "unavailable" {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "unavailable";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
