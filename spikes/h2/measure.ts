import { readFile } from "node:fs/promises";
import {
  getArg,
  selectedRenderers,
  selectedScenarios,
  cellPath,
  type Stage,
  type Renderer,
} from "./measure-shared";
import { recordRenderer } from "./measure-record";
import { runCells, runCrossRendererCheck, runTrace } from "./measure-stages";
import { summary } from "./measure-summary";
import { summaryExitCode } from "./pure";

async function validationExitCode(
  renderers: readonly Renderer[],
  scenarios: readonly string[],
): Promise<number> {
  const statuses: ("pass" | "fail" | "timed-out" | "missing")[] = [];
  for (const renderer of renderers)
    for (const scenario of scenarios) {
      try {
        const result = JSON.parse(
          await readFile(cellPath("validate", renderer, scenario), "utf8"),
        ) as { readonly status?: "pass" | "fail" | "timed-out" };
        statuses.push(result.status ?? "fail");
      } catch {
        statuses.push("missing");
      }
    }
  return summaryExitCode(statuses, []);
}

async function runStage(stage: Stage): Promise<number> {
  const renderers =
    stage === "smoke"
      ? (["tiles-main"] as const)
      : selectedRenderers(getArg("--renderer"));
  const scenarios = selectedScenarios(getArg("--scenario"));
  const resume = process.argv.includes("--resume");
  if (stage === "summary") return summary();
  if (stage === "trace")
    return runTrace(renderers, getArg("--scenario") ? scenarios : ["zoom"]);
  if (stage === "time") {
    const validated: string[] = [];
    for (const renderer of renderers)
      for (const scenario of scenarios) {
        try {
          const result = JSON.parse(
            await readFile(cellPath("validate", renderer, scenario), "utf8"),
          ) as { readonly status?: string };
          if (result.status === "pass")
            validated.push(renderer + ":" + scenario);
        } catch {
          // Summary reports the corresponding time cell as missing.
        }
      }
    console.log(
      "[spike h2] estimate=time 12 cells x (3 s load + 4 x ~8 s) ~= 7.3 min",
    );
    let failures = 0;
    for (const renderer of renderers) {
      const eligible = scenarios.filter((scenario) =>
        validated.includes(renderer + ":" + scenario),
      );
      failures += await runCells(stage, [renderer], eligible, resume);
    }
    return failures;
  }
  const failures = await runCells(
    stage,
    renderers,
    stage === "smoke" ? ["pan"] : scenarios,
    resume,
  );
  if (stage === "validate") {
    // Needs every scenario's cells on disk (the atlas reference and both
    // tile renderers); --no-cross-check skips it so a tiles-only run is
    // judged by its own checks.
    if (process.argv.includes("--no-cross-check"))
      console.log("[spike h2] cross-renderer check skipped (--no-cross-check)");
    else await runCrossRendererCheck(scenarios);
    return await validationExitCode(renderers, scenarios);
  }
  return failures;
}

const recordIndex = process.argv.indexOf("--record");
const stageArg = getArg("--stage") as Stage | undefined;
const operation =
  recordIndex >= 0
    ? recordRenderer(
        process.argv[recordIndex + 1] ?? "atlas",
        process.argv[recordIndex + 2] ?? "pan",
      )
    : stageArg &&
        ["smoke", "validate", "time", "trace", "summary"].includes(stageArg)
      ? runStage(stageArg).then((code) => {
          if (code !== 0) process.exitCode = code;
        })
      : Promise.reject(
          new Error(
            "usage: --stage smoke|validate|time|trace|summary [--renderer] [--scenario] [--resume]",
          ),
        );
operation.catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
