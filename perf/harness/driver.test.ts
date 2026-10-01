import { describe, expect, it } from "vitest";

import {
  planEvents,
  runEvents,
  type DriverClock,
  type DriverEvent,
} from "./driver";
import type { Scenario } from "../scenarios/schema";

const scenario: Scenario = {
  name: "Pan across the whole canvas at zoom 1.0",
  setup: { dataset: "reference" },
  steps: [
    { kind: "pan", x: 400, y: 300, dx: 80, dy: -40, durationMs: 100 },
    { kind: "type", text: "abc", charsPerSecond: 10 },
  ],
  durationMs: 300,
};

describe("gesture driver", () => {
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

  it("paces CDP dispatch through a high-resolution clock", async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    let currentTime = 0;
    const clock: DriverClock = {
      now: () => currentTime,
      sleep: (milliseconds) => {
        currentTime += milliseconds;
        return Promise.resolve();
      },
    };
    const cdp = {
      send: (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        return Promise.resolve();
      },
    };

    await runEvents(
      cdp as unknown as import("@playwright/test").CDPSession,
      [
        {
          atMs: 0,
          stepKind: "wait",
          method: "wait",
          params: { ms: 10 },
        },
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
    expect(currentTime).toBe(20);
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
