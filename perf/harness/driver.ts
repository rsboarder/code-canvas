import type { CDPSession } from "@playwright/test";

import type { Scenario, ScenarioStep } from "../scenarios/schema";

const WAIT_METHOD = "wait";

export interface DriverEvent {
  readonly atMs: number;
  readonly stepKind: ScenarioStep["kind"];
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface DriverClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const systemClock: DriverClock = {
  now: () => performance.now(),
  sleep: async (milliseconds) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

export function planEvents(
  scenario: Scenario,
  frameRateHz: number,
): readonly DriverEvent[] {
  if (!Number.isFinite(frameRateHz) || frameRateHz <= 0) {
    throw new RangeError("frameRateHz must be positive");
  }
  const periodMs = 1_000 / frameRateHz;
  const events: DriverEvent[] = [];
  let startMs = 0;
  for (const step of scenario.steps) {
    appendStepEvents(events, step, startMs, periodMs);
    startMs += stepDurationMs(step);
  }
  return events;
}

export async function runEvents(
  cdp: CDPSession,
  events: readonly DriverEvent[],
  clock: DriverClock = systemClock,
): Promise<void> {
  const startedAt = clock.now();
  for (const event of events) {
    const targetTime = startedAt + event.atMs;
    const remaining = targetTime - clock.now();
    if (remaining > 0) await clock.sleep(remaining);
    if (event.method === WAIT_METHOD) {
      await clock.sleep(readWaitMilliseconds(event));
      continue;
    }
    await cdp.send(event.method as Parameters<CDPSession["send"]>[0], {
      ...event.params,
    });
  }
}

function appendStepEvents(
  events: DriverEvent[],
  step: ScenarioStep,
  startMs: number,
  periodMs: number,
): void {
  if (step.kind === "wait") {
    events.push({
      atMs: startMs,
      stepKind: step.kind,
      method: WAIT_METHOD,
      params: { ms: step.ms },
    });
    return;
  }
  if (step.kind === "type") {
    appendTypingEvents(events, step, startMs);
    return;
  }
  if (step.kind === "dblclick") {
    appendDoubleClick(events, step, startMs);
    return;
  }
  if (step.kind === "drag") {
    appendDragEvents(events, step, startMs, periodMs);
    return;
  }
  if (step.kind === "resize") {
    appendResizeEvents(events, step, startMs, periodMs);
    return;
  }
  appendContinuousEvents(events, step, startMs, periodMs);
}

function appendContinuousEvents(
  events: DriverEvent[],
  step: Exclude<
    ScenarioStep,
    { kind: "wait" | "type" | "dblclick" | "drag" | "resize" }
  >,
  startMs: number,
  periodMs: number,
): void {
  const count = frameEventCount(step.durationMs, periodMs);
  for (let index = 0; index < count; index += 1) {
    const atMs = startMs + index * periodMs;
    const params = continuousParams(step, count);
    events.push({
      atMs,
      stepKind: step.kind,
      method: "Input.dispatchMouseEvent",
      params,
    });
  }
}

function continuousParams(
  step: Exclude<
    ScenarioStep,
    { kind: "wait" | "type" | "dblclick" | "drag" | "resize" }
  >,
  count: number,
): Record<string, unknown> {
  if (step.kind === "pan") {
    return {
      type: "mouseWheel",
      x: step.x,
      y: step.y,
      deltaX: step.dx / count,
      deltaY: step.dy / count,
    };
  }
  if (step.kind === "scroll") {
    return {
      type: "mouseWheel",
      x: step.x,
      y: step.y,
      deltaX: 0,
      deltaY: step.dy / count,
    };
  }
  return {
    type: "mouseWheel",
    x: step.x,
    y: step.y,
    deltaX: 0,
    deltaY: ((step.scaleFactor - 1) * -100) / count,
    modifiers: 2,
  };
}

function appendDragEvents(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "drag" }>,
  startMs: number,
  periodMs: number,
): void {
  const count = frameEventCount(step.durationMs, periodMs);
  events.push({
    atMs: startMs,
    stepKind: step.kind,
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mousePressed",
      x: step.from.x,
      y: step.from.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    },
  });
  for (let index = 0; index < count; index += 1) {
    const fraction = (index + 1) / count;
    events.push({
      atMs: startMs + index * periodMs,
      stepKind: step.kind,
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseMoved",
        x: interpolate(step.from.x, step.to.x, fraction),
        y: interpolate(step.from.y, step.to.y, fraction),
        button: "left",
        buttons: 1,
      },
    });
  }
  events.push({
    atMs: startMs + step.durationMs,
    stepKind: step.kind,
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mouseReleased",
      x: step.to.x,
      y: step.to.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    },
  });
}

function appendResizeEvents(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "resize" }>,
  startMs: number,
  periodMs: number,
): void {
  appendPointerSequence(events, {
    from: step.from,
    to: step.to,
    durationMs: step.durationMs,
    startMs,
    periodMs,
  });
}

function appendPointerSequence(
  events: DriverEvent[],
  sequence: {
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
    readonly durationMs: number;
    readonly startMs: number;
    readonly periodMs: number;
  },
): void {
  const { from, to, durationMs, startMs, periodMs } = sequence;
  const count = frameEventCount(durationMs, periodMs);
  events.push({
    atMs: startMs,
    stepKind: "resize",
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      buttons: 1,
    },
  });
  for (let index = 0; index < count; index += 1) {
    const fraction = (index + 1) / count;
    events.push({
      atMs: startMs + index * periodMs,
      stepKind: "resize",
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseMoved",
        x: interpolate(from.x, to.x, fraction),
        y: interpolate(from.y, to.y, fraction),
        button: "left",
        buttons: 1,
      },
    });
  }
  events.push({
    atMs: startMs + durationMs,
    stepKind: "resize",
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      buttons: 0,
    },
  });
}

function appendTypingEvents(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "type" }>,
  startMs: number,
): void {
  const characters = Array.from(step.text);
  const intervalMs = 1_000 / step.charsPerSecond;
  characters.forEach((character, index) => {
    const atMs = startMs + index * intervalMs;
    const key = keyName(character);
    events.push({
      atMs,
      stepKind: step.kind,
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key,
        text: character,
        unmodifiedText: character,
      },
    });
    events.push({
      atMs,
      stepKind: step.kind,
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", key },
    });
  });
}

function appendDoubleClick(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "dblclick" }>,
  startMs: number,
): void {
  const params = {
    x: step.x,
    y: step.y,
    button: "left",
    buttons: 1,
    clickCount: 2,
  };
  events.push(
    {
      atMs: startMs,
      stepKind: step.kind,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", ...params },
    },
    {
      atMs: startMs,
      stepKind: step.kind,
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", ...params, buttons: 0 },
    },
  );
}

function frameEventCount(durationMs: number, periodMs: number): number {
  return Math.max(1, Math.ceil(durationMs / periodMs));
}

function stepDurationMs(step: ScenarioStep): number {
  if (step.kind === "wait") return step.ms;
  if (step.kind === "type") {
    return (Array.from(step.text).length * 1_000) / step.charsPerSecond;
  }
  if (step.kind === "dblclick") return 0;
  return step.durationMs;
}

function interpolate(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

function keyName(character: string): string {
  if (character === "\n") return "Enter";
  if (character === "\t") return "Tab";
  return character;
}

function readWaitMilliseconds(event: DriverEvent): number {
  const milliseconds = event.params.ms;
  if (typeof milliseconds !== "number") {
    throw new TypeError("wait event is missing milliseconds");
  }
  return milliseconds;
}
