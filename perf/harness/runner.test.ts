import { describe, expect, it } from "vitest";

import {
  previewArguments,
  previewUrl,
  runMeasuredScenarios,
  type HarnessResult,
  type RunnerFileSystem,
  type ScenarioRunnerDependencies,
} from "./runner";
import {
  missingBridgeCommands,
  openReferenceFolder,
  prepareScenarioRun,
  waitForApplicationBridge,
} from "./run-preparation";
import { evaluateSelfTest, SELF_TEST_CASE_NAMES } from "./self-test-evaluation";
import type { Page } from "@playwright/test";
import type { BudgetConfig } from "./report";
import type { NoiseFloor } from "./preflight";
import type { Scenario } from "../scenarios/schema";

const budgets: BudgetConfig = {
  warmupRuns: 1,
  measuredRuns: 5,
  applicationTaskMs: 8,
  longIntervalMs: 12.5,
  allowedRegression: 0.2,
};

const zeroNoiseFloor: NoiseFloor = {
  droppedFramesPerMinute: 0,
  partiallyPresentedFramesPerMinute: 0,
  intervalsOver12_5MsPerMinute: 0,
};

describe("scenario runner", () => {
  it("checks required bridge commands on the live page", async () => {
    const page = {
      evaluate: (callback: unknown, commands: readonly string[]) => {
        expect(typeof callback).toBe("function");
        return Promise.resolve(
          commands.filter((command) => command === "missing"),
        );
      },
    } as unknown as Page;
    const scenario = {
      name: "Worst-case text density",
      setup: {
        dataset: "reference",
        camera: { x: 0, y: 0, scale: 1 },
        requiresBridgeCommands: ["setCamera", "missing"],
      },
      steps: [{ kind: "pan", x: 1, y: 1, dx: 1, dy: 1, durationMs: 1 }],
      durationMs: 1,
    } as Scenario;

    await expect(missingBridgeCommands(page, scenario)).resolves.toEqual([
      "missing",
    ]);
  });

  it("applies a scenario camera before waiting for the next frame", async () => {
    const calls: string[] = [];
    const page = {
      evaluate: (callback: unknown) => {
        calls.push(String(callback));
        return Promise.resolve(undefined);
      },
    } as unknown as Page;
    const scenario = {
      name: "Worst-case text density",
      setup: { dataset: "reference", camera: { x: 4, y: 5, scale: 1 } },
      steps: [{ kind: "pan", x: 1, y: 1, dx: 1, dy: 1, durationMs: 1 }],
      durationMs: 1,
    } as Scenario;

    await prepareScenarioRun(page, scenario);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("setCamera");
    expect(calls[1]).toContain("requestAnimationFrame");
  });
});

describe("self-test evaluation", () => {
  it("maps self-test expectations to pass, fail, and invalid exits", () => {
    const passing = SELF_TEST_CASE_NAMES.map((caseName) => {
      const droppedFrames =
        caseName === "Harness produces no false failures" ? 0 : 1;
      return {
        caseName,
        valid: true,
        budgetViolation: caseName === "Artificial stall detected",
        droppedFrames,
        partiallyPresentedFrames: 0,
        applicationTaskMs: 7,
        durationMs: 5_000,
        runs: [{ droppedFrames, partiallyPresentedFrames: 0 }],
      };
    });
    expect(evaluateSelfTest(passing, 8, zeroNoiseFloor).exitCode).toBe(0);
    for (const failed of passing) {
      const result = evaluateSelfTest(
        passing.map((measurement) =>
          measurement.caseName === failed.caseName
            ? failed.caseName === "Artificial stall detected"
              ? { ...measurement, budgetViolation: false, droppedFrames: 0 }
              : failed.caseName === "Artificial GPU load detected"
                ? { ...measurement, droppedFrames: 0, applicationTaskMs: 9 }
                : {
                    ...measurement,
                    droppedFrames: 1,
                    runs: [{ droppedFrames: 1, partiallyPresentedFrames: 0 }],
                  }
            : measurement,
        ),
        8,
        zeroNoiseFloor,
      );
      expect(result.exitCode).toBe(1);
    }
    expect(
      evaluateSelfTest(
        passing.map((measurement) =>
          measurement.caseName === "Artificial GPU load detected"
            ? { ...measurement, valid: false }
            : measurement,
        ),
        8,
        zeroNoiseFloor,
      ).exitCode,
    ).toBe(2);
  });
});

describe("scenario runner", () => {
  it("waits for the asynchronously installed application bridge", async () => {
    let timeout: number | undefined;
    const page = {
      waitForFunction: (
        _predicate: unknown,
        _argument: unknown,
        options: { timeout: number },
      ) => {
        timeout = options.timeout;
        return Promise.resolve();
      },
    } as unknown as Page;

    await expect(waitForApplicationBridge(page)).resolves.toBe(true);
    expect(timeout).toBeGreaterThan(0);
  });

  it("turns a bridge wait timeout into an unavailable result", async () => {
    const page = {
      waitForFunction: () => Promise.reject(new Error("timeout")),
    } as unknown as Page;

    await expect(waitForApplicationBridge(page)).resolves.toBe(false);
  });

  it("reports openFolder rejection without checking its void result", async () => {
    let evaluated = false;
    const page = {
      evaluate: () => {
        evaluated = true;
        return Promise.reject(new Error("folder rejected"));
      },
    } as unknown as Page;

    await expect(openReferenceFolder(page, [])).resolves.toBe(
      "application bridge openFolder failed: folder rejected",
    );
    expect(evaluated).toBe(true);
  });

  it("uses one strict preview port for the process and browser URL", () => {
    expect(previewArguments(4567)).toEqual([
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4567",
      "--strictPort",
    ]);
    expect(previewUrl(4567)).toBe("http://127.0.0.1:4567");
  });

  it("returns coverage mismatches before it touches the browser", async () => {
    const fileSystem: RunnerFileSystem = {
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
      readFile: () => Promise.resolve(""),
    };
    const dependencies: ScenarioRunnerDependencies = {
      page: {} as never,
      cdp: {} as never,
      scenarios: [],
      specText: "### Requirement: Frame budget\n#### Scenario: Required",
      fileSystem,
    };
    const result: HarnessResult = await runMeasuredScenarios({
      ...dependencies,
      mode: "full",
      budgets,
    });

    expect(result.verdict).toBe("invalid");
    expect(result.report.scenarios).toHaveLength(0);
  });
});
