import { readFile, writeFile } from "node:fs/promises";
import { stdin } from "node:process";

import { updateBaseline } from "./baseline";
import {
  loadBudgetConfig,
  runHarness,
  runSelfTest,
  type HarnessOptions,
} from "./runner";

export type CliCommand = "run" | "stages" | "self-test" | "baseline";

export interface CliArguments {
  readonly command: CliCommand;
  readonly quick: boolean;
  readonly scenario: string | undefined;
  readonly stageTiming: boolean;
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
          : "run";
  const args = command === "run" && first !== "run" ? argv : argv.slice(1);
  const scenarioIndex = args.indexOf("--scenario");
  return {
    command,
    quick: args.includes("--quick"),
    scenario: scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined,
    stageTiming: command === "stages",
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

async function updateBaselineCommand(): Promise<number> {
  const reportPath =
    process.env.PERF_REPORT_PATH ?? "perf/results/latest/report.json";
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
