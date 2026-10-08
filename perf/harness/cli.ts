import { readdir, readFile, writeFile } from "node:fs/promises";
import { stdin } from "node:process";

import { updateBaseline } from "./baseline";
import { loadBudgetConfig } from "./budget-config";
import { classifyTraceFile, formatTraceClassification } from "./classify-file";
import { runHarness, runSelfTest, type HarnessOptions } from "./runner";

export type CliCommand =
  "run" | "stages" | "self-test" | "baseline" | "classify";

export interface CliArguments {
  readonly command: CliCommand;
  readonly quick: boolean;
  readonly scenario: string | undefined;
  readonly stageTiming: boolean;
  readonly path: string | undefined;
}

export type CliVerdict = "passed" | "failed" | "invalid" | "stage-passed";

export function parseArguments(argv: readonly string[]): CliArguments {
  const first = argv[0];
  const command =
    first === "stages"
      ? "stages"
      : first === "self-test"
        ? "self-test"
        : first === "baseline:update"
          ? "baseline"
          : first === "classify"
            ? "classify"
            : "run";
  const args = command === "run" && first !== "run" ? argv : argv.slice(1);
  const scenarioIndex = args.indexOf("--scenario");
  return {
    command,
    quick: args.includes("--quick"),
    scenario: scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined,
    stageTiming: command === "stages",
    path: command === "classify" ? args[0] : undefined,
  };
}

export function exitCodeFor(verdict: CliVerdict): 0 | 1 | 2 | 3 {
  if (verdict === "passed") return 0;
  if (verdict === "failed") return 1;
  if (verdict === "invalid") return 2;
  return 3;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const argumentsToRun = parseArguments(argv);
  if (argumentsToRun.command === "baseline") return updateBaselineCommand();
  if (argumentsToRun.command === "classify") {
    if (!argumentsToRun.path) {
      process.stderr.write("classify requires a trace path\n");
      return 2;
    }
    const result = await classifyTraceFile(argumentsToRun.path, (path) =>
      readFile(path),
    );
    process.stdout.write(`${formatTraceClassification(result)}\n`);
    return result.valid ? 0 : 2;
  }
  const budgets = await loadBudgetConfig();
  const runnerOptions: HarnessOptions = {
    mode: argumentsToRun.stageTiming ? "stages" : "full",
    quick: argumentsToRun.quick,
    budgets,
    ...(argumentsToRun.scenario ? { scenario: argumentsToRun.scenario } : {}),
  };
  const result =
    argumentsToRun.command === "self-test"
      ? await runSelfTest({ budgets })
      : await runHarness(runnerOptions);
  process.stdout.write(`${result.output}\n`);
  return exitCodeFor(result.verdict);
}

// perf/results folder names are ISO timestamps (e.g.
// 2026-10-01T20-06-17-201Z-full), so sorting them lexically also sorts them
// chronologically.
export const PERF_RESULTS_DIR = "perf/results";

export interface ReportDirectoryFileSystem {
  readdir(path: string): Promise<readonly string[]>;
}

export async function resolveDefaultReportPath(
  fileSystem: ReportDirectoryFileSystem,
  resultsDir: string = PERF_RESULTS_DIR,
): Promise<string> {
  const entries = await fileSystem.readdir(resultsDir).catch(() => []);
  const fullRunFolders = entries
    .filter((entry) => entry.endsWith("-full"))
    .slice()
    .sort();
  const newest = fullRunFolders[fullRunFolders.length - 1];
  if (!newest) {
    throw new Error(`No full report found: no *-full folder in ${resultsDir}`);
  }
  return `${resultsDir}/${newest}/report.json`;
}

async function updateBaselineCommand(): Promise<number> {
  const reportPath =
    process.env.PERF_REPORT_PATH ??
    (await resolveDefaultReportPath({ readdir: (path) => readdir(path) }));
  const report = await readFile(reportPath, "utf8");
  const isTTY = stdin.isTTY;
  const confirmation = isTTY ? await readConfirmation() : undefined;
  const baselineOptions = {
    baselinePath: "perf/baseline.json",
    report,
    isTTY,
    fileSystem: {
      readFile: (path: string) => readFile(path, "utf8"),
      writeFile,
    },
    ...(confirmation ? { confirmation } : {}),
  };
  const result = await updateBaseline(baselineOptions);
  if (result.exitCode !== 0)
    process.stderr.write("baseline update requires interactive confirmation\n");
  return result.exitCode;
}

async function readConfirmation(): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write("Replace perf/baseline.json? [y/N] ");
    process.stdin.once("data", (chunk: Buffer) => {
      resolve(chunk.toString().trim());
    });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    });
}
