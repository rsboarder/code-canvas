import { describe, expect, it } from "vitest";

import { REFERENCE_THRESHOLDS, type EnvironmentReport } from "./environment";
import {
  collectEnvironment,
  evaluateNoiseFloor,
  evaluatePreflight,
  measureNoiseFloor,
  type NoiseFloor,
  type NoiseFloorClassifier,
  type PreflightVerdict,
  type TraceRecorder,
} from "./preflight";

const environment = (
  overrides: Partial<EnvironmentReport> = {},
): EnvironmentReport => ({
  chromeVersion: "Chrome/154.0.8037.58",
  userAgent: "Mozilla/5.0 Chrome/154.0.8037.58 Safari/537.36",
  commandLine: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  commandLineAvailable: true,
  headless: false,
  devicePixelRatio: 2,
  screenSize: { width: 3024, height: 1964 },
  windowSize: { width: 3024, height: 1964 },
  idleRateHz: 120.48,
  idleIntervalMs: [8.3, 8.3, 8.4],
  powerSource: "ac",
  lowPowerMode: false,
  machineModel: "MacBookPro18,3",
  ...overrides,
});

const invalid = (report: EnvironmentReport): void => {
  const verdict: PreflightVerdict = evaluatePreflight(
    report,
    REFERENCE_THRESHOLDS,
  );
  expect(verdict.valid).toBe(false);
  expect(verdict.exitCode).toBe(2);
  expect(verdict.reasons).toHaveLength(1);
};

const browserWithCommandLine = (commandLine: string | Error) => {
  let closed = false;
  const versionPage = {
    goto: () => Promise.resolve(),
    evaluate: () =>
      commandLine instanceof Error
        ? Promise.reject(commandLine)
        : Promise.resolve(commandLine),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  const browser = { newPage: () => Promise.resolve(versionPage) };
  const page = {
    evaluate: (callback: unknown) => {
      if (typeof callback !== "function") return Promise.resolve(undefined);
      const source = String(callback);
      if (source.includes("requestAnimationFrame")) {
        return Promise.resolve({ intervals: [8.3, 8.4, 8.3] });
      }
      return Promise.resolve({
        userAgent: "Mozilla/5.0 Chrome/154.0.8037.58 Safari/537.36",
        devicePixelRatio: 2,
        screen: { width: 3024, height: 1964 },
        window: { width: 3024, height: 1964 },
      });
    },
  };
  return { browser, page, wasClosed: () => closed };
};

const collectEnvironmentWithCommandLine = (commandLine: string | Error) => {
  const fake = browserWithCommandLine(commandLine);
  const cdp = {
    send: () => Promise.resolve({ product: "Chrome/154.0.8037.58" }),
  };
  const system = (command: string) => {
    if (command === "pmset -g batt")
      return Promise.resolve({
        stdout: "Now drawing from 'AC Power'",
        stderr: "",
        exitCode: 0,
      });
    if (command === "pmset -g")
      return Promise.resolve({
        stdout: "lowpowermode 0",
        stderr: "",
        exitCode: 0,
      });
    return Promise.resolve({
      stdout: "MacBookPro18,3",
      stderr: "",
      exitCode: 0,
    });
  };
  return collectEnvironment(
    fake.browser as never,
    fake.page as never,
    cdp as never,
    system,
  ).then((result) => ({ result, wasClosed: fake.wasClosed }));
};

describe("environment preflight", () => {
  it("rejects a headless browser", () => {
    invalid(environment({ headless: true }));
  });

  it("rejects browser flags that disable frame pacing", () => {
    invalid(
      environment({ commandLine: ["chrome", "--disable-frame-rate-limit"] }),
    );
  });

  it("rejects an unavailable browser command line", () => {
    invalid(environment({ commandLineAvailable: false, commandLine: [] }));
  });

  it("rejects an idle rate below 115 Hz", () => {
    invalid(environment({ idleRateHz: 114.99 }));
  });

  it("rejects battery power", () => {
    invalid(environment({ powerSource: "battery" }));
  });

  it("rejects Low Power Mode", () => {
    invalid(environment({ lowPowerMode: true }));
  });

  it("accepts all reference conditions", () => {
    expect(evaluatePreflight(environment(), REFERENCE_THRESHOLDS)).toEqual({
      valid: true,
      exitCode: 0,
      reasons: [],
    });
  });

  it("accepts the idle-rate boundary", () => {
    expect(
      evaluatePreflight(environment({ idleRateHz: 115 }), REFERENCE_THRESHOLDS)
        .valid,
    ).toBe(true);
  });
});

describe("noise floor validity", () => {
  const floor = (overrides: Partial<NoiseFloor> = {}): NoiseFloor => ({
    droppedFramesPerMinute: 0,
    partiallyPresentedFramesPerMinute: 0,
    intervalsOver12_5MsPerMinute: 0,
    ...overrides,
  });

  it("accepts three dropped and three partially presented frames per minute", () => {
    expect(
      evaluateNoiseFloor(
        floor({
          droppedFramesPerMinute: 3,
          partiallyPresentedFramesPerMinute: 3,
        }),
        REFERENCE_THRESHOLDS,
      ).valid,
    ).toBe(true);
  });

  it.each([
    { droppedFramesPerMinute: 4 },
    { partiallyPresentedFramesPerMinute: 4 },
    { intervalsOver12_5MsPerMinute: 1 },
  ])("rejects a floor above its threshold: %o", (overrides) => {
    expect(evaluateNoiseFloor(floor(overrides), REFERENCE_THRESHOLDS)).toEqual(
      expect.objectContaining({ valid: false, exitCode: 2 }),
    );
  });
});

describe("noise floor measurement", () => {
  it("runs the redraw loop through injected trace recording and classification", async () => {
    const evaluations: unknown[] = [];
    const page = {
      evaluate: (...args: unknown[]) => {
        evaluations.push(args);
        return Promise.resolve(undefined);
      },
    };
    const trace = { trace: true };
    const floor = {
      droppedFramesPerMinute: 1,
      partiallyPresentedFramesPerMinute: 0,
      intervalsOver12_5MsPerMinute: 0,
    };
    let recorded = false;
    const recordTrace: TraceRecorder = async (_cdp, action) => {
      recorded = true;
      await action();
      return trace;
    };
    const classifyTrace: NoiseFloorClassifier = (receivedTrace) => {
      expect(receivedTrace).toBe(trace);
      return floor;
    };
    const result = await measureNoiseFloor({
      page: page as never,
      cdp: {} as never,
      durationMs: 2_000,
      recordTrace,
      classifyTrace,
    });

    expect(recorded).toBe(true);
    expect(evaluations).toHaveLength(1);
    expect(result).toBe(floor);
  });
});

describe("environment collection", () => {
  it("parses command-line arguments from the Chrome version page", async () => {
    const { result, wasClosed } = await collectEnvironmentWithCommandLine(
      "chrome --user-data-dir=/tmp/profile --disable-features=Foo",
    );

    expect(result.commandLine).toEqual([
      "chrome",
      "--user-data-dir=/tmp/profile",
      "--disable-features=Foo",
    ]);
    expect(result.commandLineAvailable).toBe(true);
    expect(wasClosed()).toBe(true);
  });

  it("rejects a frame-pacing flag read from the Chrome version page", async () => {
    const { result } = await collectEnvironmentWithCommandLine(
      "chrome --disable-frame-rate-limit",
    );

    expect(evaluatePreflight(result)).toEqual(
      expect.objectContaining({ valid: false, exitCode: 2 }),
    );
    expect(evaluatePreflight(result).reasons.join(" ")).toContain(
      "frame-pacing flags present",
    );
  });

  it("marks an unreadable Chrome version command line unavailable", async () => {
    const { result } = await collectEnvironmentWithCommandLine(
      new Error("version page unavailable"),
    );

    expect(result.commandLine).toEqual([]);
    expect(result.commandLineAvailable).toBe(false);
    expect(evaluatePreflight(result)).toEqual(
      expect.objectContaining({
        valid: false,
        exitCode: 2,
        reasons: ["browser command line unavailable"],
      }),
    );
  });
});

describe("environment collection", () => {
  it("collects browser, display, power, and machine parameters", async () => {
    const page = {
      evaluate: (callback: unknown) => {
        if (typeof callback !== "function") return Promise.resolve(undefined);
        const source = String(callback);
        if (source.includes("requestAnimationFrame")) {
          return Promise.resolve({ intervals: [8.3, 8.4, 8.3] });
        }
        return Promise.resolve({
          userAgent: "Mozilla/5.0 Chrome/154.0.8037.58 Safari/537.36",
          devicePixelRatio: 2,
          screen: { width: 3024, height: 1964 },
          window: { width: 3024, height: 1964 },
        });
      },
    };
    const cdp = {
      send: (method: string) => {
        if (method === "Browser.getVersion") {
          return Promise.resolve({ product: "Chrome/154.0.8037.58" });
        }
        return Promise.resolve({ arguments: ["chrome"] });
      },
    };
    const commands: string[] = [];
    const result = await collectEnvironment(
      {} as never,
      page as never,
      cdp as never,
      (command) => {
        commands.push(command);
        if (command === "pmset -g batt") {
          return Promise.resolve({
            stdout: "Now drawing from 'AC Power'",
            stderr: "",
            exitCode: 0,
          });
        }
        if (command === "pmset -g") {
          return Promise.resolve({
            stdout: "lowpowermode 0",
            stderr: "",
            exitCode: 0,
          });
        }
        return Promise.resolve({
          stdout: "MacBookPro18,3",
          stderr: "",
          exitCode: 0,
        });
      },
    );

    expect(result.chromeVersion).toBe("Chrome/154.0.8037.58");
    expect(result.idleRateHz).toBeCloseTo(120.48, 1);
    expect(result.powerSource).toBe("ac");
    expect(result.lowPowerMode).toBe(false);
    expect(commands).toEqual([
      "pmset -g batt",
      "pmset -g",
      "sysctl -n hw.model",
    ]);
  });
});
