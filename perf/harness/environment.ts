export interface ScreenSize {
  width: number;
  height: number;
}

export type PowerSource = "ac" | "battery" | "unknown";

export interface EnvironmentReport {
  chromeVersion: string;
  userAgent: string;
  commandLine: string[];
  commandLineAvailable: boolean;
  headless: boolean;
  devicePixelRatio: number;
  screenSize: ScreenSize;
  windowSize: ScreenSize;
  idleRateHz: number;
  idleIntervalMs: number[];
  powerSource: PowerSource;
  lowPowerMode: boolean;
  machineModel: string;
}

export interface PreflightThresholds {
  minimumIdleRateHz: number;
  maximumDroppedFramesPerMinute: number;
  maximumPartiallyPresentedFramesPerMinute: number;
  maximumIntervalsOver12_5MsPerMinute: number;
}

export const REFERENCE_THRESHOLDS: PreflightThresholds = {
  minimumIdleRateHz: 115,
  maximumDroppedFramesPerMinute: 3,
  maximumPartiallyPresentedFramesPerMinute: 3,
  maximumIntervalsOver12_5MsPerMinute: 0,
};

export interface SystemCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SystemCommandRunner = (
  command: string,
) => Promise<SystemCommandResult>;
