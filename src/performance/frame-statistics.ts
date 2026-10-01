export const UNAVAILABLE = "unavailable" as const;

export type Statistic = number | typeof UNAVAILABLE;

export function nearestRank(
  values: readonly number[],
  percentile: number,
): Statistic {
  if (values.length === 0) return UNAVAILABLE;
  if (percentile < 0 || percentile > 1) {
    throw new RangeError("Percentile must be between 0 and 1");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? UNAVAILABLE;
}

export function countLongIntervals(
  values: readonly number[],
  thresholdMs = 12.5,
): Statistic {
  if (values.length === 0) return UNAVAILABLE;
  return values.reduce(
    (count, value) => count + (value > thresholdMs ? 1 : 0),
    0,
  );
}
