import type { Browser, Page } from "@playwright/test";

// tsx compiles the harness with esbuild `keepNames`, which wraps named functions
// inside `page.evaluate` callbacks in a `__name` helper that the page lacks.
const KEEP_NAMES_HELPER = "globalThis.__name = (target) => target;";

export async function openHarnessPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(KEEP_NAMES_HELPER);
  return page;
}
