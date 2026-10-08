import { spawn, type ChildProcessByStdio } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Writable } from "node:stream";
import type { CDPSession, Page } from "@playwright/test";

import { planEvents, runEvents } from "./driver";
import { openDemoSession } from "./harness-session";
import { readReferenceFiles, scenarioList } from "./runner";
import {
  openReferenceFolder,
  prepareInitialLoadRun,
  prepareScenarioRun,
} from "./run-preparation";
import {
  SETTLE_TIMEOUT_MS,
  unsettledDetail,
  waitForSettledApplication,
} from "./settle";
import type { Scenario } from "../scenarios/schema";

const DEFAULT_SCREEN = "Capture screen 0";
const DETAIL_MODE_SCENARIO = {
  name: "Pan across the whole canvas at zoom 1.0",
  setup: { dataset: "reference" },
  steps: [
    {
      kind: "key",
      key: "M",
      code: "KeyM",
      keyCode: 77,
      modifiers: 8,
    },
    { kind: "wait", ms: 100 },
    {
      kind: "key",
      key: "M",
      code: "KeyM",
      keyCode: 77,
      modifiers: 8,
    },
  ],
  durationMs: 100,
} satisfies Scenario;

type RecordingProcess = ChildProcessByStdio<Writable, null, null>;

interface DemoOptions {
  readonly recordPath: string | undefined;
  readonly screen: string;
}

interface DemoRecording {
  readonly process: RecordingProcess;
  readonly caffeinate: ReturnType<typeof spawn>;
  readonly path: string;
}

interface SettledResult {
  readonly valid: true;
}

interface InvalidResult {
  readonly valid: false;
  readonly reason: string;
}

type PreparationResult = SettledResult | InvalidResult;

async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  let session: Awaited<ReturnType<typeof openDemoSession>> | undefined;
  let recording: DemoRecording | undefined;
  let videoPath: string | undefined;
  let exitCode = 0;
  try {
    session = await openDemoSession();
    const files = await readReferenceFiles();
    const openError = await openReferenceFolder(session.page, files);
    if (openError) throw new Error(openError);
    await setDetailedOverlay(session.cdp);
    if (options.recordPath) {
      recording = startRecording(options.recordPath, options.screen);
      await delay(2_000);
    }
    for (const scenario of orderedScenarios())
      await playScenario(session.page, session.cdp, scenario, files);
    await delay(2_000);
    if (recording) {
      exitCode = await stopRecording(recording);
      videoPath = recording.path;
      recording = undefined;
    }
  } catch (error: unknown) {
    console.error(errorMessage(error));
    exitCode = 1;
  } finally {
    if (recording) {
      try {
        const recordingExitCode = await stopRecording(recording);
        if (recordingExitCode !== 0) exitCode = 1;
      } catch (error: unknown) {
        console.error(errorMessage(error));
        exitCode = 1;
      }
    }
    if (session) {
      try {
        await session.close();
      } catch (error: unknown) {
        console.error(errorMessage(error));
        exitCode = 1;
      }
    }
  }
  if (videoPath) console.log(videoPath);
  return exitCode;
}

function parseOptions(argv: readonly string[]): DemoOptions {
  let recordPath: string | undefined;
  let screen = DEFAULT_SCREEN;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--record") {
      recordPath = requiredValue(argv, ++index, "--record");
      continue;
    }
    if (argument === "--screen") {
      screen = requiredValue(argv, ++index, "--screen");
      continue;
    }
    throw new Error(`unknown option: ${argument ?? ""}`);
  }
  return { recordPath, screen };
}

function requiredValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${option} requires a value`);
  return value;
}

async function setDetailedOverlay(cdp: CDPSession): Promise<void> {
  await runEvents(cdp, planEvents(DETAIL_MODE_SCENARIO, 120));
}

function orderedScenarios(): readonly Scenario[] {
  return [
    ...scenarioList.filter((scenario) => scenario.setup.initialLoad),
    ...scenarioList.filter((scenario) => !scenario.setup.initialLoad),
  ];
}

async function playScenario(
  page: Page,
  cdp: CDPSession,
  scenario: Scenario,
  files: Awaited<ReturnType<typeof readReferenceFiles>>,
): Promise<void> {
  console.log(`${scenario.name}: started`);
  const preparation = await prepareDemoScenario(page, scenario, files);
  let overlayError: string | undefined;
  if (scenario.setup.initialLoad) {
    try {
      await setDetailedOverlay(cdp);
    } catch (error: unknown) {
      overlayError = errorMessage(error);
    }
  }
  if (!preparation.valid) {
    console.error(`${scenario.name}: ${preparation.reason}`);
    return;
  }
  if (overlayError) {
    console.error(`${scenario.name}: ${overlayError}`);
    return;
  }
  try {
    await runEvents(cdp, planEvents(scenario, 120));
  } catch (error: unknown) {
    console.error(`${scenario.name}: ${errorMessage(error)}`);
    return;
  }
  const settled = await waitForSettledApplication(page, SETTLE_TIMEOUT_MS);
  if (!settled.settled) {
    console.error(
      `${scenario.name}: ${unsettledDetail(scenario.name, "after the gesture", settled)}`,
    );
    return;
  }
  await delay(1_500);
}

async function prepareDemoScenario(
  page: Page,
  scenario: Scenario,
  files: Awaited<ReturnType<typeof readReferenceFiles>>,
): Promise<PreparationResult> {
  const preparation = scenario.setup.initialLoad
    ? await prepareInitialLoadRun(page, scenario, files)
    : await prepareScenarioRun(page, scenario);
  if (preparation)
    return { valid: false, reason: formatInvalidResult(preparation) };
  if (scenario.setup.initialLoad) return { valid: true };
  const settled = await waitForSettledApplication(page, SETTLE_TIMEOUT_MS);
  if (!settled.settled)
    return {
      valid: false,
      reason: unsettledDetail(scenario.name, "before the run", settled),
    };
  return { valid: true };
}

function formatInvalidResult(result: {
  readonly reason: string;
  readonly detail?: string;
}): string {
  return result.detail ? `${result.reason}: ${result.detail}` : result.reason;
}

function startRecording(path: string, screen: string): DemoRecording {
  const recordingProcess = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "avfoundation",
      "-framerate",
      "60",
      "-capture_cursor",
      "0",
      "-pixel_format",
      "nv12",
      "-i",
      `${screen}:none`,
      "-an",
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      "24M",
      "-fps_mode",
      "passthrough",
      path,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  const caffeinate = spawn("caffeinate", ["-d", "-i"], { stdio: "ignore" });
  recordingProcess.on("error", () => undefined);
  return { process: recordingProcess, caffeinate, path };
}

async function stopRecording(recording: DemoRecording): Promise<number> {
  recording.caffeinate.kill();
  const recordingProcess = recording.process;
  if (recordingProcess.exitCode !== null) return recordingProcess.exitCode;
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      resolve(code ?? 1);
    };
    const cleanup = (): void => {
      recordingProcess.off("error", onError);
      recordingProcess.off("close", onClose);
    };
    recordingProcess.once("error", onError);
    recordingProcess.once("close", onClose);
    recordingProcess.stdin.write("q");
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
