import type { Browser, CDPSession, Page } from "@playwright/test";

import {
  REFERENCE_THRESHOLDS,
  type EnvironmentReport,
  type PreflightThresholds,
  type ScreenSize,
  type SystemCommandRunner,
} from "./environment";

interface BrowserVersion {
  product?: string;
}

interface CommandLine {
  readonly available: boolean;
  readonly arguments: string[];
}

interface PageEnvironment {
  userAgent: string;
  devicePixelRatio: number;
  screen: ScreenSize;
  window: ScreenSize;
}

interface IdleSample {
  intervals: number[];
}

export interface PreflightVerdict {
  valid: boolean;
  exitCode: 0 | 2;
  reasons: string[];
}

export interface NoiseFloor {
  droppedFramesPerMinute: number;
  partiallyPresentedFramesPerMinute: number;
  intervalsOver12_5MsPerMinute: number;
}

export type TraceRecorder = (
  cdp: CDPSession,
  action: () => Promise<void>,
) => Promise<unknown>;

export type NoiseFloorClassifier = (trace: unknown) => NoiseFloor;

interface NoiseFloorOptions {
  page: Page;
  cdp: CDPSession;
  durationMs: number;
  recordTrace: TraceRecorder;
  classifyTrace: NoiseFloorClassifier;
}

const DISALLOWED_FLAGS = [
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--disable-gpu-rasterization",
];

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const collectIdleSample = async (
  page: Page,
  durationMs: number,
): Promise<IdleSample> =>
  page.evaluate(
    (duration) =>
      new Promise<IdleSample>((resolve) => {
        const intervals: number[] = [];
        let previous: number | null = null;
        const started = performance.now();
        const frame = (timestamp: number): void => {
          if (previous !== null) intervals.push(timestamp - previous);
          previous = timestamp;
          if (timestamp - started >= duration) {
            resolve({ intervals });
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    durationMs,
  );

const parsePowerSource = (output: string): EnvironmentReport["powerSource"] => {
  if (output.includes("AC Power")) return "ac";
  if (output.includes("Battery Power")) return "battery";
  return "unknown";
};

const parseLowPowerMode = (output: string): boolean => {
  const match = /\blowpowermode\s*[:=]?\s*(\d+)/iu.exec(output);
  return match?.[1] === "1";
};

const isHeadless = (userAgent: string, product: string): boolean =>
  /headless/iu.test(userAgent) || /headless/iu.test(product);

const COMMAND_LINE_SELECTOR = "#command_line";

const readCommandLineText = async (
  browser: Browser,
): Promise<string | null> => {
  let commandLinePage: Page | undefined;
  try {
    commandLinePage = await browser.newPage();
    await commandLinePage.goto("chrome://version");
    return await commandLinePage.evaluate(
      (selector) => document.querySelector(selector)?.textContent ?? null,
      COMMAND_LINE_SELECTOR,
    );
  } catch {
    return null;
  } finally {
    await commandLinePage?.close();
  }
};

const parseCommandLine = (text: string): string[] =>
  text
    .trim()
    .split(/\s+/u)
    .filter((argument) => argument.length > 0);

const collectCommandLine = async (browser: Browser): Promise<CommandLine> => {
  const text = await readCommandLineText(browser);
  const args = text === null ? [] : parseCommandLine(text);
  return args.length === 0
    ? { available: false, arguments: [] }
    : { available: true, arguments: args };
};

export const collectEnvironment = async (
  browser: Browser,
  page: Page,
  cdp: CDPSession,
  system: SystemCommandRunner,
): Promise<EnvironmentReport> => {
  const version = (await cdp.send("Browser.getVersion")) as BrowserVersion;
  const commandLine = await collectCommandLine(browser);
  const pageEnvironment = await page.evaluate((): PageEnvironment => ({
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: window.screen.width, height: window.screen.height },
    window: { width: window.innerWidth, height: window.innerHeight },
  }));
  const idleSample = await collectIdleSample(page, 2_000);
  const battery = await system("pmset -g batt");
  const powerMode = await system("pmset -g");
  const machine = await system("sysctl -n hw.model");
  const product = version.product ?? "unknown";
  const interval = median(idleSample.intervals);

  return {
    chromeVersion: product,
    userAgent: pageEnvironment.userAgent,
    commandLine: commandLine.arguments,
    commandLineAvailable: commandLine.available,
    headless: isHeadless(pageEnvironment.userAgent, product),
    devicePixelRatio: pageEnvironment.devicePixelRatio,
    screenSize: pageEnvironment.screen,
    windowSize: pageEnvironment.window,
    idleRateHz: interval === 0 ? 0 : 1_000 / interval,
    idleIntervalMs: idleSample.intervals,
    powerSource: parsePowerSource(battery.stdout),
    lowPowerMode: parseLowPowerMode(powerMode.stdout),
    machineModel: machine.stdout.trim(),
  };
};

const invalidVerdict = (reasons: string[]): PreflightVerdict => ({
  valid: false,
  exitCode: 2,
  reasons,
});

export const evaluatePreflight = (
  environment: EnvironmentReport,
  thresholds: PreflightThresholds = REFERENCE_THRESHOLDS,
): PreflightVerdict => {
  const reasons: string[] = [];
  if (environment.headless) reasons.push("browser is running headless");
  if (!environment.commandLineAvailable)
    reasons.push("browser command line unavailable");

  const disallowedFlags = environment.commandLine.filter((argument) =>
    DISALLOWED_FLAGS.some(
      (flag) => argument === flag || argument.startsWith(`${flag}=`),
    ),
  );
  if (disallowedFlags.length > 0) {
    reasons.push(`frame-pacing flags present: ${disallowedFlags.join(", ")}`);
  }
  if (environment.idleRateHz < thresholds.minimumIdleRateHz) {
    reasons.push(
      `idle frame rate is ${environment.idleRateHz.toFixed(2)} Hz; minimum is ${String(thresholds.minimumIdleRateHz)} Hz`,
    );
  }
  if (environment.powerSource !== "ac") {
    reasons.push("machine is not running on AC power");
  }
  if (environment.lowPowerMode) reasons.push("Low Power Mode is on");
  return reasons.length === 0
    ? { valid: true, exitCode: 0, reasons }
    : invalidVerdict(reasons);
};

export const evaluateNoiseFloor = (
  floor: NoiseFloor,
  thresholds: PreflightThresholds = REFERENCE_THRESHOLDS,
): PreflightVerdict => {
  const reasons: string[] = [];
  if (floor.droppedFramesPerMinute > thresholds.maximumDroppedFramesPerMinute) {
    reasons.push("noise floor has too many dropped frames");
  }
  if (
    floor.partiallyPresentedFramesPerMinute >
    thresholds.maximumPartiallyPresentedFramesPerMinute
  ) {
    reasons.push("noise floor has too many partially presented frames");
  }
  if (
    floor.intervalsOver12_5MsPerMinute >
    thresholds.maximumIntervalsOver12_5MsPerMinute
  ) {
    reasons.push("noise floor has too many long frame intervals");
  }
  return reasons.length === 0
    ? { valid: true, exitCode: 0, reasons }
    : invalidVerdict(reasons);
};

const redrawBlankPage = async (
  page: Page,
  durationMs: number,
): Promise<void> => {
  await page.evaluate((duration) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    const started = performance.now();
    return new Promise<void>((resolve) => {
      const frame = (): void => {
        context?.fillRect(0, 0, 1, 1);
        if (performance.now() - started >= duration) {
          resolve();
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }, durationMs);
};

export const measureNoiseFloor = async ({
  page,
  cdp,
  durationMs,
  recordTrace,
  classifyTrace,
}: NoiseFloorOptions): Promise<NoiseFloor> => {
  const trace = await recordTrace(cdp, () => redrawBlankPage(page, durationMs));
  return classifyTrace(trace);
};
