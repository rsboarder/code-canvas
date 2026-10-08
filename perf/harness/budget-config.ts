import { readFile } from "node:fs/promises";

import type { BudgetConfig } from "./report";
import { isRecord } from "./is-record";

type ScenarioBudgetOverride = NonNullable<
  BudgetConfig["scenarioOverrides"]
>[string];

export async function loadBudgetConfig(
  path = "perf/budgets.json",
): Promise<BudgetConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  const scenarioOverrides = parseScenarioOverrides(raw.scenarioOverrides);
  return {
    warmupRuns: budgetValue(raw.warmupRuns),
    measuredRuns: budgetValue(raw.measuredRuns),
    applicationTaskMs: budgetValue(raw.applicationTaskMs),
    longIntervalMs: budgetValue(raw.longIntervalMs),
    allowedRegression: budgetValue(raw.allowedRegression),
    ...(scenarioOverrides ? { scenarioOverrides } : {}),
  };
}

function budgetValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (isRecord(value) && typeof value.value === "number") return value.value;
  throw new TypeError("budget value is missing");
}

function parseScenarioOverrides(
  entry: unknown,
): Record<string, ScenarioBudgetOverride> | undefined {
  if (entry === undefined) return undefined;
  if (!isRecord(entry) || !isRecord(entry.value))
    throw new TypeError("scenario overrides value is missing");
  const overrides: Record<string, ScenarioBudgetOverride> = {};
  for (const [scenario, value] of Object.entries(entry.value)) {
    overrides[scenario] = parseScenarioOverride(scenario, value);
  }
  return overrides;
}

function parseScenarioOverride(
  scenario: string,
  value: unknown,
): ScenarioBudgetOverride {
  if (!isRecord(value)) throw invalidScenarioOverride(scenario);
  const applicationTaskMs = value.applicationTaskMs;
  const extraMissedFramesPerRun = value.extraMissedFramesPerRun;
  if (applicationTaskMs === undefined && extraMissedFramesPerRun === undefined)
    throw invalidScenarioOverride(scenario);
  if (
    applicationTaskMs !== undefined &&
    !isPositiveFiniteNumber(applicationTaskMs)
  )
    throw invalidScenarioOverride(scenario);
  if (
    extraMissedFramesPerRun !== undefined &&
    !isNonnegativeInteger(extraMissedFramesPerRun)
  )
    throw invalidScenarioOverride(scenario);
  return {
    ...(applicationTaskMs === undefined ? {} : { applicationTaskMs }),
    ...(extraMissedFramesPerRun === undefined
      ? {}
      : { extraMissedFramesPerRun }),
  };
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function invalidScenarioOverride(scenario: string): TypeError {
  return new TypeError(`invalid budget override for scenario "${scenario}"`);
}
