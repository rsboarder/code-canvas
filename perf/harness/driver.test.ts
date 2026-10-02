import { describe, expect, it, vi } from "vitest";

import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../../src/performance/bridge";
import {
  GestureCapExceededError,
  planEvents,
  runEvents,
  type DriverClock,
  type DriverEvent,
} from "./driver";
import type { Scenario } from "../scenarios/schema";

type CDPSession = import("@playwright/test").CDPSession;

function createRecordingClock(): {
  readonly clock: DriverClock;
  now: () => number;
} {
  let currentTime = 0;
  const clock: DriverClock = {
    now: () => currentTime,
    sleep: (milliseconds) => {
      currentTime += milliseconds;
      return Promise.resolve();
    },
  };
  return { clock, now: () => currentTime };
}

const scenario: Scenario = {
  name: "Pan across the whole canvas at zoom 1.0",
  setup: { dataset: "reference" },
  steps: [
    { kind: "pan", x: 400, y: 300, dx: 80, dy: -40, durationMs: 100 },
    { kind: "type", text: "abc", charsPerSecond: 10 },
  ],
  durationMs: 300,
};

describe("gesture plan", () => {
  it("produces a byte-identical deterministic plan with frame-rate cadence", () => {
    const first: readonly DriverEvent[] = planEvents(scenario, 120);
    const second = planEvents(scenario, 120);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const panEvents = first.filter((event) => event.stepKind === "pan");
    expect(panEvents.length).toBeGreaterThanOrEqual(12);
    expect(panEvents.every((event) => event.atMs <= 100)).toBe(true);
    expect(first.filter((event) => event.stepKind === "type")).toHaveLength(6);
    expect(first.find((event) => event.stepKind === "type")?.atMs).toBe(100);
  });

  it("includes numeric deltas on every mouse wheel event", () => {
    const events = planEvents(
      {
        name: "Pan across the whole canvas at zoom 1.0",
        setup: { dataset: "reference" },
        steps: [
          { kind: "scroll", x: 10, y: 20, dy: 80, durationMs: 100 },
          { kind: "pinch", x: 10, y: 20, scaleFactor: 1.2, durationMs: 100 },
        ],
        durationMs: 200,
      },
      120,
    ).filter((event) => event.params.type === "mouseWheel");

    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event) =>
          typeof event.params.deltaX === "number" &&
          typeof event.params.deltaY === "number",
      ),
    ).toBe(true);
  });
});

describe("pinch gain", () => {
  it("sums pinch wheel deltas to -K * ln(scaleFactor)", () => {
    for (const scaleFactor of [20, 0.05]) {
      const events = planEvents(
        {
          name: "Pan across the whole canvas at zoom 1.0",
          setup: { dataset: "reference" },
          steps: [
            { kind: "pinch", x: 10, y: 20, scaleFactor, durationMs: 100 },
          ],
          durationMs: 100,
        },
        120,
      );
      const sum = events.reduce(
        (total, event) =>
          total +
          (typeof event.params.deltaY === "number" ? event.params.deltaY : 0),
        0,
      );
      const expected = -PINCH_WHEEL_DELTA_PER_LN_SCALE * Math.log(scaleFactor);
      expect(Math.abs(sum - expected)).toBeLessThan(1e-9);
    }
  });

  it("keeps each pinch wheel delta within the product's maximum zoom step", () => {
    const events = planEvents(
      {
        name: "Pan across the whole canvas at zoom 1.0",
        setup: { dataset: "reference" },
        steps: [
          { kind: "pinch", x: 10, y: 20, scaleFactor: 20, durationMs: 5_000 },
        ],
        durationMs: 5_000,
      },
      120,
    );
    const maxDeltaY = PINCH_WHEEL_DELTA_PER_LN_SCALE * MAX_ZOOM_STEP_LN;

    expect(
      events.every(
        (event) =>
          typeof event.params.deltaY !== "number" ||
          Math.abs(event.params.deltaY) <= maxDeltaY,
      ),
    ).toBe(true);
  });
});

describe("gesture dispatch", () => {
  it("paces CDP dispatch through a high-resolution clock", async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const { clock, now } = createRecordingClock();
    const cdp = {
      send: (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        return Promise.resolve();
      },
    };

    const wallTimeMs = await runEvents(
      cdp as unknown as CDPSession,
      [
        { atMs: 0, stepKind: "wait", method: "wait", params: { ms: 10 } },
        {
          atMs: 20,
          stepKind: "pan",
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseWheel" },
        },
      ],
      clock,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("Input.dispatchMouseEvent");
    expect(now()).toBe(20);
    expect(wallTimeMs).toBe(20);
  });

  it("dispatches every event at its planned time without waiting for its ack", async () => {
    const sent: { method: string; atMs: number }[] = [];
    const { clock, now } = createRecordingClock();
    const pendingAcks: (() => void)[] = [];
    const cdp = {
      send: (method: string) => {
        sent.push({ method, atMs: now() });
        return new Promise<void>((resolve) => {
          pendingAcks.push(resolve);
        });
      },
    };
    const events: DriverEvent[] = [
      {
        atMs: 0,
        stepKind: "pan",
        method: "Input.dispatchMouseEvent",
        params: {},
      },
      {
        atMs: 10,
        stepKind: "pan",
        method: "Input.dispatchMouseEvent",
        params: {},
      },
    ];

    const runPromise = runEvents(cdp as unknown as CDPSession, events, clock);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual([
      { method: "Input.dispatchMouseEvent", atMs: 0 },
      { method: "Input.dispatchMouseEvent", atMs: 10 },
    ]);

    pendingAcks.forEach((resolve) => {
      resolve();
    });
    await expect(runPromise).resolves.toEqual(expect.any(Number));
  });
});

describe("gesture ack failures", () => {
  it("rejects the run when an ack rejects", async () => {
    const clock: DriverClock = {
      now: () => 0,
      sleep: () => Promise.resolve(),
    };
    const cdp = { send: () => Promise.reject(new Error("boom")) };
    const events: DriverEvent[] = [
      {
        atMs: 0,
        stepKind: "pan",
        method: "Input.dispatchMouseEvent",
        params: {},
      },
    ];

    await expect(
      runEvents(cdp as unknown as CDPSession, events, clock),
    ).rejects.toThrow("boom");
  });

  it("fails the run when an ack never resolves within the cap", async () => {
    vi.useFakeTimers();
    try {
      const clock: DriverClock = {
        now: () => 0,
        sleep: () => Promise.resolve(),
      };
      const cdp = { send: () => new Promise<void>(() => undefined) };
      const events: DriverEvent[] = [
        {
          atMs: 0,
          stepKind: "pan",
          method: "Input.dispatchMouseEvent",
          params: {},
        },
      ];

      const runPromise = runEvents(cdp as unknown as CDPSession, events, clock);
      const assertion = expect(runPromise).rejects.toThrow(
        GestureCapExceededError,
      );
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
