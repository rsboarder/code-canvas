import type { Browser, Page } from "@playwright/test";

// tsx compiles the harness with esbuild `keepNames`, which wraps named functions
// inside `page.evaluate` callbacks in a `__name` helper that the page lacks.
const KEEP_NAMES_HELPER = "globalThis.__name = (target) => target;";

// A headed run measures the reference display itself: no viewport emulation,
// so the page gets the screen's device pixel ratio and the maximized window's
// size. Playwright's default 1280 × 720 at DPR 1 rendered a quarter of the
// display's pixels, and Chrome scaled CDP wheel deltas by the screen's DPR 2
// against that emulated DPR 1, so every wheel gesture ran twice as far; without
// emulation they arrive 1:1 (both measured 2026-10-01).
export const HEADED_WINDOW_ARGS = ["--start-maximized"];

export async function openHarnessPage(
  browser: Browser,
  headed: boolean,
): Promise<Page> {
  const context = await browser.newContext(headed ? { viewport: null } : {});
  const page = await context.newPage();
  await page.addInitScript(KEEP_NAMES_HELPER);
  return page;
}
