import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";

import {
  classifyNoiseFloor,
  collectEnvironment,
  evaluateNoiseFloor,
  evaluatePreflight,
  measureNoiseFloor,
  type NoiseFloor,
} from "./preflight";
import {
  HEADED_WINDOW_ARGS,
  addKeepNamesInitScript,
  moveToBuiltInDisplay,
  openHarnessPage,
} from "./harness-page";
import type { HarnessMode } from "./report";
import { waitForApplicationBridge } from "./run-preparation";
import { recordTrace } from "./trace";

const execFileAsync = promisify(execFile);
const PREVIEW_PORT = 4173;

export type HarnessEnvironment = Awaited<ReturnType<typeof collectEnvironment>>;
type Environment = HarnessEnvironment;

interface SessionResources {
  readonly browser: Awaited<ReturnType<typeof chromium.launch>>;
  readonly preview: ReturnType<typeof spawn>;
  readonly close: () => Promise<void>;
}

interface OpenHarnessSessionBase {
  readonly kind: "open";
  readonly mode: HarnessMode;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly close: () => Promise<void>;
}

export interface FullHarnessSession extends OpenHarnessSessionBase {
  readonly mode: "full";
  readonly environment: Environment;
  readonly noiseFloor: NoiseFloor;
}

interface StageHarnessSession extends OpenHarnessSessionBase {
  readonly mode: "stages";
  readonly environment: undefined;
  readonly noiseFloor: undefined;
}

interface InvalidHarnessSession {
  readonly kind: "invalid";
  readonly reason: string;
  readonly environment: Environment | null;
  readonly noiseFloor: NoiseFloor | null;
}

type HarnessSession = FullHarnessSession | StageHarnessSession;
type HarnessSessionResult = HarnessSession | InvalidHarnessSession;

interface DemoSession {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly close: () => Promise<void>;
}

export function openHarnessSession(
  mode: "full",
): Promise<FullHarnessSession | InvalidHarnessSession>;
export function openHarnessSession(
  mode: "stages",
): Promise<StageHarnessSession | InvalidHarnessSession>;
export function openHarnessSession(
  mode: HarnessMode,
): Promise<HarnessSessionResult>;
export async function openHarnessSession(
  mode: HarnessMode,
): Promise<HarnessSessionResult> {
  const resources = await startResources(mode);
  try {
    const page = await openHarnessPage(resources.browser, mode === "full");
    await gotoPreview(page, PREVIEW_PORT);
    if (mode === "full") {
      const displayError = await moveToBuiltInDisplay(page);
      if (displayError)
        return await invalidSession(
          resources,
          `built-in display unavailable: ${displayError}`,
        );
      await page.reload();
    }
    if (!(await waitForApplicationBridge(page)))
      return await invalidSession(
        resources,
        "application bridge is unavailable",
      );
    const cdp = await page.context().newCDPSession(page);
    const measurement = await prepareMeasurement(
      resources.browser,
      page,
      cdp,
      mode,
    );
    if (measurement.kind === "invalid")
      return await invalidSession(
        resources,
        measurement.reason,
        measurement.environment,
        measurement.noiseFloor,
      );
    return {
      kind: "open",
      mode,
      page,
      cdp,
      environment: measurement.environment,
      noiseFloor: measurement.noiseFloor,
      close: resources.close,
    } as HarnessSession;
  } catch (error: unknown) {
    await resources.close();
    throw error;
  }
}

export async function openDemoSession(): Promise<DemoSession> {
  const userDataDir = await mkdtemp(join(tmpdir(), "code-canvas-demo-"));
  let preview: ReturnType<typeof spawn> | undefined;
  let context: BrowserContext | undefined;
  try {
    preview = await startPreview();
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: ["--kiosk"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await addKeepNamesInitScript(page);
    await gotoPreview(page, PREVIEW_PORT);
    await page.reload();
    if (!(await waitForApplicationBridge(page)))
      throw new Error("application bridge is unavailable");
    const cdp = await page.context().newCDPSession(page);
    let closed = false;
    return {
      page,
      cdp,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await context?.close();
        } finally {
          try {
            preview?.kill();
          } finally {
            await rm(userDataDir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error: unknown) {
    try {
      await context?.close();
    } finally {
      try {
        preview?.kill();
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function startResources(mode: HarnessMode): Promise<SessionResources> {
  let preview: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    preview = await startPreview();
    browser = await chromium.launch({
      channel: "chrome",
      headless: mode === "stages",
      args: mode === "full" ? HEADED_WINDOW_ARGS : [],
    });
    return createResources(browser, preview);
  } catch (error: unknown) {
    await closeResources(browser, preview);
    throw error;
  }
}

async function startPreview(): Promise<ReturnType<typeof spawn>> {
  await execFileAsync("pnpm", ["build"], {
    env: { ...process.env, VITE_PERF_HARNESS: "1" },
  });
  return spawn("pnpm", previewArguments(PREVIEW_PORT), {
    env: process.env,
    stdio: "ignore",
  });
}

function createResources(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  preview: ReturnType<typeof spawn>,
): SessionResources {
  let closed = false;
  return {
    browser,
    preview,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await browser.close();
      } finally {
        preview.kill();
      }
    },
  };
}

async function closeResources(
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  preview: ReturnType<typeof spawn> | undefined,
): Promise<void> {
  try {
    if (browser) await browser.close();
  } finally {
    preview?.kill();
  }
}

async function invalidSession(
  resources: SessionResources,
  reason: string,
  environment: Environment | null = null,
  noiseFloor: NoiseFloor | null = null,
): Promise<InvalidHarnessSession> {
  await resources.close();
  return { kind: "invalid", reason, environment, noiseFloor };
}

type Measurement =
  | {
      readonly kind: "ready";
      readonly environment: Environment | undefined;
      readonly noiseFloor: NoiseFloor | undefined;
    }
  | InvalidHarnessSession;

async function prepareMeasurement(
  browser: Browser,
  page: Page,
  cdp: CDPSession,
  mode: HarnessMode,
): Promise<Measurement> {
  if (mode === "stages")
    return { kind: "ready", environment: undefined, noiseFloor: undefined };
  const environment = await collectEnvironment(
    browser,
    page,
    cdp,
    runSystemCommand,
  );
  const preflight = evaluatePreflight(environment);
  if (!preflight.valid)
    return {
      kind: "invalid",
      reason: `preflight failed: ${preflight.reasons.join("; ")}`,
      environment,
      noiseFloor: null,
    };
  const measuredNoiseFloor = await measureNoiseFloor({
    page,
    cdp,
    durationMs: 60_000,
    recordTrace,
    classifyTrace: classifyNoiseFloor,
  });
  if ("valid" in measuredNoiseFloor)
    return {
      kind: "invalid",
      reason: `noise floor measurement invalid: ${measuredNoiseFloor.reason}${measuredNoiseFloor.detail ? `: ${measuredNoiseFloor.detail}` : ""}`,
      environment,
      noiseFloor: null,
    };
  if (!evaluateNoiseFloor(measuredNoiseFloor).valid)
    return {
      kind: "invalid",
      reason: "noise floor exceeds the reference threshold",
      environment,
      noiseFloor: measuredNoiseFloor,
    };
  return { kind: "ready", environment, noiseFloor: measuredNoiseFloor };
}

export function previewArguments(port: number): string[] {
  return [
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ];
}

export function previewUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

async function gotoPreview(page: Page, port: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await page.goto(previewUrl(port));
      return;
    } catch (error: unknown) {
      if (attempt === 19) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function runSystemCommand(
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync("sh", ["-lc", command]);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: failure.code ?? 1,
    };
  }
}
