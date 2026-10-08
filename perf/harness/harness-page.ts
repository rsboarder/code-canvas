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

export async function moveToBuiltInDisplay(
  page: Page,
): Promise<string | undefined> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.send("Browser.grantPermissions", {
      ...(targetInfo.browserContextId === undefined
        ? {}
        : { browserContextId: targetInfo.browserContextId }),
      origin: new URL(page.url()).origin,
      permissions: ["windowManagement"],
    });
    const screen = await page.evaluate(async () => {
      const getScreenDetails = (
        window as Window & {
          getScreenDetails?: () => Promise<{
            screens: {
              isInternal: boolean;
              availLeft: number;
              availTop: number;
              availWidth: number;
              availHeight: number;
            }[];
          }>;
        }
      ).getScreenDetails;
      if (typeof getScreenDetails !== "function")
        throw new Error("window management API is unavailable");
      const details = await getScreenDetails();
      const internal = details.screens.find(
        (candidate) => candidate.isInternal,
      );
      if (internal === undefined) throw new Error("no internal screen found");
      return {
        left: internal.availLeft,
        top: internal.availTop,
        width: internal.availWidth,
        height: internal.availHeight,
      };
    });
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { ...screen, windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "maximized" },
    });
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function openHarnessPage(
  browser: Browser,
  headed: boolean,
): Promise<Page> {
  const context = await browser.newContext(headed ? { viewport: null } : {});
  const page = await context.newPage();
  await addKeepNamesInitScript(page);
  return page;
}

export async function addKeepNamesInitScript(page: Page): Promise<void> {
  await page.addInitScript(KEEP_NAMES_HELPER);
}
