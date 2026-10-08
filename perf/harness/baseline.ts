import { readFile } from "node:fs/promises";

import type { Baseline } from "./report";
import { isRecord } from "./is-record";

export interface BaselineFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface BaselineUpdateOptions {
  readonly baselinePath: string;
  readonly report: string;
  readonly isTTY: boolean;
  readonly confirmation?: string;
  readonly fileSystem: BaselineFileSystem;
}

export interface BaselineUpdateResult {
  readonly exitCode: number;
  readonly changed: boolean;
}

export async function loadBaseline(): Promise<Baseline | undefined> {
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

export async function updateBaseline({
  baselinePath,
  report,
  isTTY,
  confirmation,
  fileSystem,
}: BaselineUpdateOptions): Promise<BaselineUpdateResult> {
  if (!isTTY || confirmation?.toLowerCase() !== "y") {
    return { exitCode: 1, changed: false };
  }
  const previous = await fileSystem.readFile(baselinePath).catch(() => "");
  await fileSystem.writeFile(baselinePath, report);
  return { exitCode: 0, changed: previous !== report };
}

function statistic(value: unknown): number | "unavailable" {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : "unavailable";
}
