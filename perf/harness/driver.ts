import type { CDPSession } from "@playwright/test";

import { PINCH_WHEEL_DELTA_PER_LN_SCALE } from "../../src/performance/bridge";
import type { Scenario, ScenarioStep } from "../scenarios/schema";

const WAIT_METHOD = "wait";
// A rejected/never-resolving ack must still fail the run instead of hanging
// the harness forever; 3x the planned duration gives slow-but-real gestures
// room, and the +5s padding covers short scenarios.
const ACK_CAP_DURATION_MULTIPLIER = 3;
const ACK_CAP_PADDING_MS = 5_000;

export class GestureCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GestureCapExceededError";
  }
}

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

// Sends every planned event at its scheduled time without awaiting its CDP
// acknowledgement in line: awaiting each ack serialized gestures at ~45ms per
// event in spike H2 (5x the plan), which made frame numbers look better than
// they are. Acks are collected and awaited together, capped so a rejected or
// hung ack fails the run instead of blocking it forever. Returns the
// gesture's wall time: first planned event to last ack.
export async function runEvents(
  cdp: CDPSession,
  events: readonly DriverEvent[],
  clock: DriverClock = systemClock,
): Promise<number> {
  const plannedDurationMs = events.reduce(
    (max, event) => Math.max(max, event.atMs),
    0,
  );
  const startedAt = clock.now();
  const acks: Promise<unknown>[] = [];
  for (const event of events) {
    const targetTime = startedAt + event.atMs;
    const remaining = targetTime - clock.now();
    if (remaining > 0) await clock.sleep(remaining);
    if (event.method === WAIT_METHOD) {
      await clock.sleep(readWaitMilliseconds(event));
      continue;
    }
    acks.push(sendEvent(cdp, event));
  }
  await awaitAcksWithCap(
    acks,
    ACK_CAP_DURATION_MULTIPLIER * plannedDurationMs + ACK_CAP_PADDING_MS,
  );
  return clock.now() - startedAt;
}

async function awaitAcksWithCap(
  acks: readonly Promise<unknown>[],
  capMs: number,
): Promise<void> {
  if (acks.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(acks),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new GestureCapExceededError(
              `gesture acks did not resolve within the ${String(capMs)} ms cap ` +
                `(${String(ACK_CAP_DURATION_MULTIPLIER)}x planned duration + ${String(ACK_CAP_PADDING_MS)} ms)`,
            ),
          );
        }, capMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  if (step.kind === "paste") {
    appendPasteEvent(events, step, startMs);
    return;
  }
  if (step.kind === "key") {
    appendKeyEvents(events, step, startMs);
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
    {
      kind: "wait" | "type" | "paste" | "key" | "dblclick" | "drag" | "resize";
    }
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
    {
      kind: "wait" | "type" | "paste" | "key" | "dblclick" | "drag" | "resize";
    }
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
    // Chrome turns a trackpad pinch into ctrl+wheel with
    // deltaY = -K * ln(scale); matching that here is what lets the runner's
    // honesty check compare the final camera against the planned one.
    deltaY:
      (-PINCH_WHEEL_DELTA_PER_LN_SCALE * Math.log(step.scaleFactor)) / count,
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
    const keyDownParams =
      character === "\n"
        ? {
            type: "keyDown",
            key,
            code: "Enter",
            windowsVirtualKeyCode: 13,
            text: "\r",
            unmodifiedText: "\r",
          }
        : {
            type: "keyDown",
            key,
            text: character,
            unmodifiedText: character,
          };
    events.push({
      atMs,
      stepKind: step.kind,
      method: "Input.dispatchKeyEvent",
      params: keyDownParams,
    });
    const keyUpParams =
      character === "\n"
        ? { type: "keyUp", key, code: "Enter", windowsVirtualKeyCode: 13 }
        : { type: "keyUp", key };
    events.push({
      atMs,
      stepKind: step.kind,
      method: "Input.dispatchKeyEvent",
      params: keyUpParams,
    });
  });
}

function appendPasteEvent(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "paste" }>,
  startMs: number,
): void {
  events.push({
    atMs: startMs,
    stepKind: step.kind,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) throw new Error("no focused element to paste into");
  const data = new DataTransfer();
  data.setData("text/plain", ${JSON.stringify(step.text)});
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
})()`,
    },
  });
}

function appendKeyEvents(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "key" }>,
  startMs: number,
): void {
  const params = {
    key: step.key,
    code: step.code,
    windowsVirtualKeyCode: step.keyCode,
    ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
  };
  events.push(
    {
      atMs: startMs,
      stepKind: step.kind,
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", ...params },
    },
    {
      atMs: startMs,
      stepKind: step.kind,
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", ...params },
    },
  );
}

function appendDoubleClick(
  events: DriverEvent[],
  step: Extract<ScenarioStep, { kind: "dblclick" }>,
  startMs: number,
): void {
  for (const clickCount of [1, 2]) {
    const params = {
      x: step.x,
      y: step.y,
      button: "left",
      clickCount,
    };
    events.push(
      {
        atMs: startMs,
        stepKind: step.kind,
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", buttons: 1, ...params },
      },
      {
        atMs: startMs,
        stepKind: step.kind,
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", buttons: 0, ...params },
      },
    );
  }
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
  if (step.kind === "paste" || step.kind === "key") return 0;
  return step.durationMs;
}

function sendEvent(cdp: CDPSession, event: DriverEvent): Promise<unknown> {
  const ack = cdp.send(event.method as Parameters<CDPSession["send"]>[0], {
    ...event.params,
  });
  if (event.method !== "Runtime.evaluate") return ack;
  return ack.then((result) => {
    if (hasExceptionDetails(result)) {
      throw new Error("Runtime.evaluate returned exceptionDetails");
    }
    return result;
  });
}

function hasExceptionDetails(ack: unknown): boolean {
  return (
    typeof ack === "object" &&
    ack !== null &&
    Object.prototype.hasOwnProperty.call(ack, "exceptionDetails")
  );
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
