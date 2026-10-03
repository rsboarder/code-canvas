import type { Page } from "@playwright/test";

import type { PerfFile } from "../../src/performance/bridge";
import type { Scenario } from "../scenarios/schema";
import {
  SETTLE_TIMEOUT_MS,
  unsettledDetail,
  waitForSettledApplication,
} from "./settle";
import type { InvalidMeasurement } from "./trace";

const BRIDGE_WAIT_TIMEOUT_MS = 10_000;

export async function missingBridgeCommands(
  page: Page,
  scenario: Scenario,
): Promise<string[]> {
  const required = [...(scenario.setup.requiresBridgeCommands ?? [])];
  if (scenario.setup.camera && !required.includes("setCamera"))
    required.push("setCamera");
  if (scenario.setup.camera && !required.includes("camera"))
    required.push("camera");
  if (scenario.setup.camera && !required.includes("cameraRange"))
    required.push("cameraRange");
  if (
    scenario.setup.editPath !== undefined &&
    !required.includes("beginEditing")
  )
    required.push("beginEditing");
  if (!required.includes("settleState")) required.push("settleState");
  return page.evaluate((commands) => {
    const bridge = window.__perf as unknown as
      Record<string, unknown> | undefined;
    return commands.filter(
      (command) => typeof bridge?.[command] !== "function",
    );
  }, required);
}

export async function prepareScenarioRun(
  page: Page,
  scenario: Scenario,
): Promise<InvalidMeasurement | undefined> {
  const camera = scenario.setup.camera;
  if (!camera) return prepareEditing(page, scenario);
  if (scenario.setup.approachScale !== undefined) {
    await setScenarioCamera(page, camera, scenario.setup.approachScale);
    const settled = await waitForSettledApplication(page, SETTLE_TIMEOUT_MS);
    if (!settled.settled)
      return {
        valid: false,
        reason: "app-not-settled",
        detail: unsettledDetail(scenario.name, "approach", settled),
      };
  }
  await setScenarioCamera(page, camera, camera.scale);
  return prepareEditing(page, scenario);
}

async function prepareEditing(
  page: Page,
  scenario: Scenario,
): Promise<InvalidMeasurement | undefined> {
  const path = scenario.setup.editPath;
  if (path === undefined) return;
  const settled = await waitForSettledApplication(page, SETTLE_TIMEOUT_MS);
  if (!settled.settled)
    return {
      valid: false,
      reason: "app-not-settled",
      detail: unsettledDetail(scenario.name, "before editing", settled),
    };
  try {
    await page.evaluate((editPath) => {
      const bridge = window.__perf;
      if (bridge === undefined)
        throw new Error("application bridge is unavailable");
      return bridge.beginEditing(editPath);
    }, path);
  } catch (error: unknown) {
    return {
      valid: false,
      reason: "editing-unavailable",
      detail: `${scenario.name}: ${errorMessage(error)}`,
    };
  }
}

async function setScenarioCamera(
  page: Page,
  camera: { readonly x: number; readonly y: number },
  scale: number,
): Promise<void> {
  await page.evaluate(
    (value) => window.__perf?.setCamera(value.x, value.y, value.scale),
    { ...camera, scale },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
}

export async function prepareInitialLoadRun(
  page: Page,
  scenario: Scenario,
  referenceFiles: readonly PerfFile[] | undefined,
): Promise<InvalidMeasurement | undefined> {
  if (referenceFiles === undefined)
    return {
      valid: false,
      reason: "reference-files-missing",
      detail: `${scenario.name}: reference files are missing`,
    };
  await page.reload();
  if (!(await waitForApplicationBridge(page)))
    return {
      valid: false,
      reason: "app-bridge-missing",
      detail: `${scenario.name}: application bridge did not return after the reload`,
    };
  const openError = await openReferenceFolder(page, referenceFiles);
  if (openError)
    return {
      valid: false,
      reason: "app-bridge-missing",
      detail: `${scenario.name}: ${openError}`,
    };
  const preparation = await prepareScenarioRun(page, scenario);
  if (preparation) return preparation;
  const state = await page.evaluate(() => window.__perf?.settleState());
  if (state === undefined)
    return {
      valid: false,
      reason: "app-bridge-missing",
      detail: `${scenario.name}: application settle state is unavailable`,
    };
  if (state.tokenizationPending === 0)
    return {
      valid: false,
      reason: "load-finished-before-gesture",
      detail: `${scenario.name}: load finished before the gesture`,
    };
}

export async function waitForApplicationBridge(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(() => window.__perf !== undefined, undefined, {
      timeout: BRIDGE_WAIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function openReferenceFolder(
  page: Page,
  files: readonly PerfFile[],
): Promise<string | undefined> {
  try {
    await page.evaluate(
      (referenceFiles) => window.__perf?.openFolder(referenceFiles),
      files,
    );
    return undefined;
  } catch (error: unknown) {
    return `application bridge openFolder failed: ${errorMessage(error)}`;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
