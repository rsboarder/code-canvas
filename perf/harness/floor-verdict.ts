import { poissonUpperBoundPerMinute } from "./poisson";

interface FloorMetricVerdict {
  readonly allowancePerRun: number;
  readonly actualAtMajorityRank: number;
  readonly runsOverAllowance: number;
  readonly runCount: number;
  readonly fails: boolean;
}

export function evaluateFloorMetric(
  values: readonly number[],
  floorPerMinute: number,
  durationMs: number,
): FloorMetricVerdict {
  const allowancePerRun =
    poissonUpperBoundPerMinute(floorPerMinute, 1) * (durationMs / 60_000);
  const runsOverAllowance = values.filter(
    (value) => value > allowancePerRun,
  ).length;
  const sortedValues = [...values].sort((left, right) => right - left);
  return {
    allowancePerRun,
    actualAtMajorityRank: sortedValues[Math.floor(values.length / 2)] ?? 0,
    runsOverAllowance,
    runCount: values.length,
    fails: runsOverAllowance * 2 > values.length,
  };
}
