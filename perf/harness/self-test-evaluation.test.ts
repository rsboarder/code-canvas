import { describe, expect, it } from "vitest";

import {
  evaluateSelfTest,
  type SelfTestMeasurement,
} from "./self-test-evaluation";
import type { NoiseFloor } from "./preflight";

const APPLICATION_TASK_BUDGET_MS = 8;

const noiseFloor = (
  droppedFramesPerMinute: number,
  partiallyPresentedFramesPerMinute = 0,
): NoiseFloor => ({
  droppedFramesPerMinute,
  partiallyPresentedFramesPerMinute,
  intervalsOver12_5MsPerMinute: 0,
});

const passingStall = (): SelfTestMeasurement => ({
  caseName: "Artificial stall detected",
  valid: true,
  budgetViolation: true,
  droppedFrames: 3,
  partiallyPresentedFrames: 0,
  applicationTaskMs: 20,
  durationMs: 5_000,
  runs: [{ droppedFrames: 3, partiallyPresentedFrames: 0 }],
});

const passingGpuLoad = (): SelfTestMeasurement => ({
  caseName: "Artificial GPU load detected",
  valid: true,
  budgetViolation: true,
  droppedFrames: 2,
  partiallyPresentedFrames: 1,
  applicationTaskMs: 7,
  durationMs: 5_000,
  runs: [{ droppedFrames: 2, partiallyPresentedFrames: 1 }],
});

const emptyScene = (
  runs: readonly { droppedFrames: number; partiallyPresentedFrames?: number }[],
): SelfTestMeasurement => ({
  caseName: "Harness produces no false failures",
  valid: true,
  budgetViolation: false,
  droppedFrames: runs[0]?.droppedFrames ?? 0,
  partiallyPresentedFrames: runs[0]?.partiallyPresentedFrames ?? 0,
  applicationTaskMs: 5,
  durationMs: 5_000,
  runs: runs.map((run) => ({
    droppedFrames: run.droppedFrames,
    partiallyPresentedFrames: run.partiallyPresentedFrames ?? 0,
  })),
});

const emptySceneVerdict = (
  runs: readonly { droppedFrames: number; partiallyPresentedFrames?: number }[],
  floor: NoiseFloor,
): { readonly passed: boolean | undefined; readonly exitCode: 0 | 1 | 2 } => {
  const measurements = [passingStall(), passingGpuLoad(), emptyScene(runs)];
  const result = evaluateSelfTest(
    measurements,
    APPLICATION_TASK_BUDGET_MS,
    floor,
  );
  const emptySceneCase = result.cases.find(
    (item) => item.caseName === "Harness produces no false failures",
  );
  return { passed: emptySceneCase?.passed, exitCode: result.exitCode };
};

describe("evaluateSelfTest — empty-scene noise allowance for a single run", () => {
  it("passes when dropped plus partially presented frames are under the noise-floor allowance for the run's duration", () => {
    const verdict = emptySceneVerdict(
      [{ droppedFrames: 1, partiallyPresentedFrames: 0 }],
      noiseFloor(60),
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.exitCode).toBe(0);
  });

  it("fails when dropped plus partially presented frames exceed the noise-floor allowance for the run's duration", () => {
    const verdict = emptySceneVerdict(
      [{ droppedFrames: 1, partiallyPresentedFrames: 0 }],
      noiseFloor(6),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(1);
  });

  it("fails a dropped frame against a zero noise floor", () => {
    const verdict = emptySceneVerdict(
      [{ droppedFrames: 1, partiallyPresentedFrames: 0 }],
      noiseFloor(0),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(1);
  });
});

describe("evaluateSelfTest — empty-scene noise allowance across measured runs", () => {
  it("passes a single dropped frame in a minority (1 of 5) of runs against a zero noise floor", () => {
    const verdict = emptySceneVerdict(
      [
        { droppedFrames: 1 },
        { droppedFrames: 0 },
        { droppedFrames: 0 },
        { droppedFrames: 0 },
        { droppedFrames: 0 },
      ],
      noiseFloor(0),
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.exitCode).toBe(0);
  });

  it("fails when a majority (3 of 5) of runs exceed the allowance against a zero noise floor", () => {
    const verdict = emptySceneVerdict(
      [
        { droppedFrames: 1 },
        { droppedFrames: 1 },
        { droppedFrames: 1 },
        { droppedFrames: 0 },
        { droppedFrames: 0 },
      ],
      noiseFloor(0),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(1);
  });
});
