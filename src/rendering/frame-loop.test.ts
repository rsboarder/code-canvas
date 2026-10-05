import { afterEach, describe, expect, it, vi } from "vitest";

import type { FrameSample, FrameStage } from "../shared/frame";
import { FrameLoop } from "./frame-loop";

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

function recordStage(order: string[], name: string): boolean {
  order.push(name);
  return false;
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
      { name: "input", run: () => recordStage(order, "input") },
      { name: "draw", run: () => recordStage(order, "draw") },
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
    const run = vi.fn(() => false);
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

describe("FrameLoop metrics", () => {
  it("keeps the frame sample shape and resets tile metrics on every tick", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    const ownKeys: string[][] = [];
    let tick = 0;
    const loop = new FrameLoop(
      [
        {
          name: "draw",
          run: () => {
            tick += 1;
            if (tick === 1)
              loop.setFrameMetrics({
                tileMemoryBytes: 1024,
                missingTile: true,
                timeToSharpMs: 12,
              });
            return false;
          },
        },
      ],
      (sample) => {
        ownKeys.push(Object.keys(sample).sort());
        if (tick === 1) expect(sample.tileMemoryBytes).toBe(1024);
        else expect(Number.isNaN(sample.tileMemoryBytes)).toBe(true);
        expect(sample.missingTile).toBe(tick === 1);
        if (tick === 1) expect(sample.timeToSharpMs).toBe(12);
        else expect(Number.isNaN(sample.timeToSharpMs)).toBe(true);
      },
    );

    loop.invalidate();
    callbacks.shift()?.(0);
    loop.invalidate();
    callbacks.shift()?.(0);

    expect(ownKeys[0]).toEqual(ownKeys[1]);
  });
});

describe("FrameLoop sample state", () => {
  it("carries sample state to one tick and resets it for the next", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    let tick = 0;
    const samples: {
      detailLevel: string | undefined;
      visibleWidgetCount: number | undefined;
      residencyBacklogDepth: number | undefined;
    }[] = [];
    const loop = new FrameLoop(
      [
        {
          name: "draw",
          run: () => {
            tick += 1;
            if (tick === 1) loop.setSampleState("minimap", 3, 7);
            return false;
          },
        },
      ],
      (sample) =>
        samples.push({
          detailLevel: sample.detailLevel,
          visibleWidgetCount: sample.visibleWidgetCount,
          residencyBacklogDepth: sample.residencyBacklogDepth,
        }),
    );

    loop.invalidate();
    callbacks.shift()?.(0);
    loop.invalidate();
    callbacks.shift()?.(0);

    expect(samples).toEqual([
      {
        detailLevel: "minimap",
        visibleWidgetCount: 3,
        residencyBacklogDepth: 7,
      },
      {
        detailLevel: undefined,
        visibleWidgetCount: Number.NaN,
        residencyBacklogDepth: Number.NaN,
      },
    ]);
  });

  it("carries text switch state for one tick and resets it for the next", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    let tick = 0;
    const pending: boolean[] = [];
    const loop = new FrameLoop(
      [
        {
          name: "draw",
          run: () => {
            tick += 1;
            if (tick === 1) loop.setSampleState("minimap", 3, 7, true);
            return false;
          },
        },
      ],
      (sample) => pending.push(sample.textSwitchPending ?? false),
    );

    loop.invalidate();
    callbacks.shift()?.(0);
    loop.invalidate();
    callbacks.shift()?.(0);

    expect(pending).toEqual([true, false]);
  });
});

describe("FrameLoop liveness", () => {
  it("runs the following tick when drain uploads a tile", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    let uploaded = true;
    const drain = vi.fn(() => {
      if (uploaded) {
        uploaded = false;
        return true;
      }
      return false;
    });
    const loop = new FrameLoop([{ name: "residency-drain", run: drain }]);

    loop.invalidate();
    callbacks.shift()?.(0);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(1);

    callbacks.shift()?.(0);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(callbacks).toHaveLength(0);
  });

  it("does not schedule a tick at rest without an upload", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    const drain = vi.fn(() => false);
    const loop = new FrameLoop([{ name: "residency-drain", run: drain }]);

    loop.invalidate();
    callbacks.shift()?.(0);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(0);
  });
});

describe("FrameLoop idle samples", () => {
  it("marks the first tick after idle and clears the mark for a continuous run", () => {
    const callbacks = stubAnimationFrame();
    vi.spyOn(performance, "now").mockReturnValue(1);
    const samples: FrameSample[] = [];
    const loop = new FrameLoop(
      [{ name: "draw", run: vi.fn(() => false) }],
      (sample) => samples.push({ ...sample }),
    );

    loop.invalidate();
    callbacks.shift()?.(0);
    loop.invalidate();
    callbacks.shift()?.(0);
    loop.setGestureInProgress(true);
    callbacks.shift()?.(0);
    callbacks.shift()?.(0);

    expect(samples.map((sample) => sample.afterIdle)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});
