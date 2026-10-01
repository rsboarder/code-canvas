const UPPER_BOUND_ALPHA = 0.05;
const MAX_BISECTION_ITERATIONS = 100;
const BISECTION_TOLERANCE = 1e-9;

/**
 * One-sided 95% Poisson upper bound of a rate: `observedEvents` counted over
 * `durationMinutes` minutes maps to the lambda (events per minute) for which
 * P(X <= observedEvents; lambda * durationMinutes) = 0.05, scaled back to a
 * per-minute rate. Found numerically by bisecting on the Poisson CDF — no
 * closed-form dependency.
 */
export function poissonUpperBoundPerMinute(
  observedEvents: number,
  durationMinutes: number,
): number {
  return poissonUpperBoundCount(observedEvents) / durationMinutes;
}

function poissonUpperBoundCount(observedEvents: number): number {
  let low = 0;
  let high = Math.max(1, observedEvents) * 4;
  while (poissonCdf(observedEvents, high) > UPPER_BOUND_ALPHA) high *= 2;
  for (
    let iteration = 0;
    iteration < MAX_BISECTION_ITERATIONS && high - low > BISECTION_TOLERANCE;
    iteration += 1
  ) {
    const mid = (low + high) / 2;
    if (poissonCdf(observedEvents, mid) > UPPER_BOUND_ALPHA) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function poissonCdf(observedEvents: number, lambda: number): number {
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= observedEvents; i += 1) {
    term *= lambda / i;
    sum += term;
  }
  return sum;
}
