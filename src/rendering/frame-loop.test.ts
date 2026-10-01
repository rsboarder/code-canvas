import { afterEach, describe, expect, it, vi } from "vitest";

import type { FrameSample } from "../shared/frame";
import { FrameLoop, type FrameStage } from "./frame-loop";

function stubAnimationFrame(): ((time: number) => void)[] {
  const callbacks: ((time: number) => void)[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return callbacks;
}

function stubPerformanceNow(values: number[]) {
  return vi
    .spyOn(performance, "now")
    .mockImplementation(() => values.shift() ?? 0);
}

describe("FrameLoop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs stages in order and sends one timed sample per frame", () => {
    const callbacks = stubAnimationFrame();
    const now = stubPerformanceNow([
      100, 100, 103, 103, 108, 120, 120, 122, 122, 127,
    ]);
    const order: string[] = [];
    const samples: FrameSample[] = [];
    const stages: FrameStage[] = [
      { name: "input", run: () => order.push("input") },
      { name: "draw", run: () => order.push("draw") },
    ];
    const loop = new FrameLoop(stages, (sample) => {
      samples.push({
        frameStartTime: sample.frameStartTime,
        stageTimings: sample.stageTimings.map((timing) => ({ ...timing })),
      });
    });

    loop.invalidate();
    callbacks.shift()?.(0);
    loop.invalidate();
    callbacks.shift()?.(0);

    expect(order).toEqual(["input", "draw", "input", "draw"]);
    expect(samples).toEqual([
      {
        frameStartTime: 100,
        stageTimings: [
          { name: "input", durationMs: 3 },
          { name: "draw", durationMs: 5 },
        ],
      },
      {
        frameStartTime: 120,
        stageTimings: [
          { name: "input", durationMs: 2 },
          { name: "draw", durationMs: 5 },
        ],
      },
    ]);
    expect(now).toHaveBeenCalledTimes(10);
  });

  it("does not run a frame at rest, and keeps running during a gesture", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    const run = vi.fn();
    const samples: FrameSample[] = [];
    const loop = new FrameLoop([{ name: "draw", run }], (sample) =>
      samples.push(sample),
    );

    loop.invalidate();
    callbacks.shift()?.(0);
    callbacks.shift()?.(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(1);

    loop.setGestureInProgress(true);
    callbacks.shift()?.(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(samples).toHaveLength(2);
    expect(callbacks).toHaveLength(1);

    loop.setGestureInProgress(false);
    callbacks.shift()?.(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(samples).toHaveLength(2);
  });
});
