import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import process from "node:process";
import { Console } from "node:console";
import {
  Helpers,
  TraceModel,
} from "@paulirish/trace_engine/models/trace/trace.js";

const output = new Console(process.stdout, process.stderr);

function isContained(child, parent) {
  return (
    child !== parent &&
    child.pid === parent.pid &&
    child.tid === parent.tid &&
    child.ts >= parent.ts &&
    child.ts + (child.dur ?? 0) <= parent.ts + (parent.dur ?? 0) &&
    (parent.dur ?? 0) >= (child.dur ?? 0)
  );
}

export function mainThreadTasks(events) {
  const tasks = events.filter(
    (event) => event.name === "RunTask" && (event.dur ?? 0) > 0,
  );
  const roots = tasks.filter(
    (task) => !tasks.some((candidate) => isContained(task, candidate)),
  );
  const durations = roots.map((task) => task.dur / 1000);
  return {
    mainThreadTasks: roots.length,
    maxMainThreadTaskMs: Math.max(...durations, 0),
    tasksOver8_33Ms: durations.filter((duration) => duration > 8.33).length,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

export function eventTiming(events) {
  const starts = new Map();
  const durations = [];
  for (const event of events) {
    if (event.name !== "EventTiming" || !event.id) continue;
    if (event.ph === "b") {
      starts.set(event.id, event.ts);
      continue;
    }
    if (event.ph === "e") {
      const started = starts.get(event.id);
      if (started !== undefined) durations.push((event.ts - started) / 1000);
    }
  }
  return {
    eventTimingCount: durations.length,
    eventTimingMaxMs: Math.max(...durations, 0),
    eventTimingP95Ms: percentile(durations, 0.95),
  };
}

// Frame presentation state lives on PipelineReporter async events; pairing the
// begin/end/step legs by hand is fragile (spike C round 2 got 0 frames for 3 of
// 4 actions this way). Reuse trace_engine's own matcher — the same one spike A
// uses successfully — instead of re-deriving it.
export function frames(events) {
  const pipelineEvents = events.filter(
    (event) => event.name === "PipelineReporter",
  );
  const paired =
    Helpers.Trace.createMatchedSortedSyntheticEvents(pipelineEvents);
  const frameEvents = paired
    .map((frame) => frame.rawSourceEvent)
    .filter(Boolean)
    .sort((left, right) => left.ts - right.ts);
  const state = (frame) =>
    frame.args?.frame_reporter?.state ??
    frame.args?.chrome_frame_reporter?.state;
  return {
    frameSource: "PipelineReporter",
    framesPresented: frameEvents.filter(
      (frame) => state(frame) === "STATE_PRESENTED_ALL",
    ).length,
    framesDropped: frameEvents.filter(
      (frame) => state(frame) === "STATE_DROPPED",
    ).length,
    framesPartiallyPresented: frameEvents.filter(
      (frame) => state(frame) === "STATE_PRESENTED_PARTIAL",
    ).length,
    framesTotal: frameEvents.length,
  };
}

/**
 * Parses one decoded Chrome trace and fails loudly instead of returning a
 * silent 0 when the capture itself is broken (wrong tracing categories, an
 * action too short to hit the main thread, etc.) — 0 must never be reported
 * as "no work happened" without the caller seeing why.
 */
export async function analyzeTraceEvents(events, label) {
  const model = TraceModel.Model.createWithAllHandlers();
  await model.parse(events);
  const parsed = model.parsedTrace();
  const tasks = mainThreadTasks(events);
  const frameStats = frames(events);
  const timing = eventTiming(events);
  output.log(
    `[spike-c] trace "${label}": eventCount=${events.length} mainThreadTasks=${tasks.mainThreadTasks} framesTotal=${frameStats.framesTotal} (presented=${frameStats.framesPresented} dropped=${frameStats.framesDropped} partial=${frameStats.framesPartiallyPresented})`,
  );
  if (tasks.mainThreadTasks === 0) {
    throw new Error(
      `[spike-c] trace analysis found ZERO main-thread tasks for "${label}" (eventCount=${events.length}) — this is a capture/category bug, never report 0 as "no data"`,
    );
  }
  if (frameStats.framesTotal === 0) {
    throw new Error(
      `[spike-c] trace analysis found ZERO frames for "${label}" (eventCount=${events.length}) — this is a capture/category bug, never report 0 as "no data"`,
    );
  }
  return {
    action: label,
    parsedByTraceEngine: parsed !== null,
    traceEngineFrames: parsed?.data.Frames.frames.length ?? 0,
    eventCount: events.length,
    ...tasks,
    ...frameStats,
    ...timing,
  };
}

export async function loadTraceEvents(path) {
  const trace = JSON.parse(gunzipSync(await readFile(path)).toString("utf8"));
  return trace.traceEvents ?? trace;
}
