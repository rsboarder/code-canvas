import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  atomicWriteJson,
  cellPath,
  DOC_PATH,
  RESULT_DIR,
  RENDERERS,
  SCENARIOS,
  type CellStatus,
} from "./measure-shared";
import { summaryExitCode } from "./pure";

export async function summary(): Promise<number> {
  const cells: CellStatus[] = [];
  const missing: string[] = [];
  const validationStatuses: ("pass" | "fail" | "timed-out" | "missing")[] = [];
  const timeStatuses: ("pass" | "fail" | "timed-out" | "missing")[] = [];
  for (const renderer of RENDERERS)
    for (const scenario of SCENARIOS.map((item) => item.key)) {
      try {
        const validation = JSON.parse(
          await readFile(cellPath("validate", renderer, scenario), "utf8"),
        ) as CellStatus;
        cells.push(validation);
        validationStatuses.push(validation.status);
        if (validation.status !== "pass") continue;
      } catch {
        missing.push(`${renderer}-${scenario}-validate`);
        validationStatuses.push("missing");
        continue;
      }
      try {
        cells.push(
          JSON.parse(
            await readFile(cellPath("time", renderer, scenario), "utf8"),
          ) as CellStatus,
        );
        timeStatuses.push(cells[cells.length - 1]?.status ?? "missing");
      } catch {
        missing.push(`${renderer}-${scenario}-time`);
        timeStatuses.push("missing");
      }
    }
  const failed = cells.filter((cell) => cell.status !== "pass");
  const exitCode = summaryExitCode(validationStatuses, timeStatuses);
  const status = exitCode === 2 ? "missing" : exitCode === 1 ? "fail" : "pass";
  const result = {
    stage: "summary",
    status,
    missing,
    failed,
    cells,
    generatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(resolve(RESULT_DIR, "summary.json"), result);
  await updateSummaryDoc(cells, status, missing);
  console.log(`[spike h2] stage=summary cell=all status=${status} elapsed=0ms`);
  return exitCode;
}

async function updateSummaryDoc(
  cells: readonly CellStatus[],
  status: string,
  missing: readonly string[],
): Promise<void> {
  const existing = await readFile(DOC_PATH, "utf8").catch(() => "");
  const rows = RENDERERS.flatMap((renderer) =>
    SCENARIOS.map((scenario) => {
      const cell = cells.find(
        (item) =>
          item.renderer === renderer &&
          item.scenario === scenario.key &&
          item.stage === "time",
      );
      const metric = cell?.runtime?.jsFrameP99Ms;
      const p99 = typeof metric === "number" ? String(metric) : "—";
      return `| ${renderer} | ${scenario.key} | ${cell?.status ?? "missing"} | ${p99} |`;
    }),
  ).join("\n");
  const section = `\n\n<!-- H2 SUMMARY START -->\n## Measured summary\n\nStatus: **${status}**${missing.length ? `; missing: ${missing.join(", ")}` : ""}.\n\n| Renderer | Scenario | Status | JS frame p99 (ms) |\n|---|---|---|---|\n${rows}\n<!-- H2 SUMMARY END -->\n`;
  const withoutOld = existing.replace(
    /\n<!-- H2 SUMMARY START -->[\s\S]*?<!-- H2 SUMMARY END -->\n?/u,
    "",
  );
  await writeFile(DOC_PATH, `${withoutOld.trimEnd()}${section}`);
}
