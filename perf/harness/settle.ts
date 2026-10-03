import type { Page } from "@playwright/test";

import type { SettleState } from "../../src/performance/bridge";

export const SETTLE_TIMEOUT_MS = 60_000;

interface SettledApplication {
  readonly settled: true;
}

interface UnsettledApplication {
  readonly settled: false;
  readonly waitedMs: number;
  readonly last: SettleState | undefined;
}

type SettledApplicationResult = SettledApplication | UnsettledApplication;

function isSettled(state: SettleState): boolean {
  return (
    (state.frameLoopIdle || state.syntheticLoadActive) &&
    state.tilesSettled &&
    state.residencyBacklog === 0 &&
    state.tokenizationPending === 0 &&
    !state.textSwitchPending
  );
}

export function unsettledDetail(
  scenario: string,
  phase: string,
  result: { readonly waitedMs: number; readonly last: SettleState | undefined },
): string {
  const singleSettledPoll =
    result.last !== undefined && isSettled(result.last)
      ? " (one settled poll)"
      : "";
  return `${scenario}: ${phase} did not settle after ${result.waitedMs.toFixed(1)} ms; last state ${JSON.stringify(result.last)}${singleSettledPoll}`;
}

export async function waitForSettledApplication(
  page: Page,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<SettledApplicationResult> {
  const startedAt = performance.now();
  let previousPollSettled = false;
  let waitedMs = 0;
  let timedOut = false;
  let last: SettleState | undefined;
  while (!timedOut) {
    const state = await page.evaluate(() => window.__perf?.settleState());
    last = state;
    const currentPollSettled = state === undefined ? false : isSettled(state);
    if (currentPollSettled && previousPollSettled) return { settled: true };
    previousPollSettled = currentPollSettled;
    waitedMs = performance.now() - startedAt;
    timedOut = waitedMs >= timeoutMs;
    if (!timedOut) await waitForAnimationFrame(page);
  }
  return { settled: false, waitedMs, last };
}

function waitForAnimationFrame(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
}
