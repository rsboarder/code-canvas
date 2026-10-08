import type { CDPSession } from "@playwright/test";
import {
  Helpers,
  TraceModel,
  type Types,
} from "@paulirish/trace_engine/models/trace/trace.js";

import {
  countLongIntervals,
  nearestRank,
  UNAVAILABLE,
  type Statistic,
} from "../../src/performance/bridge";
import { type BridgeMetrics, type BridgeStageMetrics } from "./metrics";
import { isRecord } from "./is-record";

export const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "toplevel",
  "blink.user_timing",
  "disabled-by-default-v8.gc",
  "input",
  "cc",
  "viz",
  "gpu",
  "loading",
] as const;

export interface TraceEvent {
  readonly name: string;
  readonly cat?: string;
  readonly ph?: string;
  readonly ts: number;
  readonly dur?: number;
  readonly tid: number;
  readonly pid: number;
  readonly id?: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type TraceEvents = readonly TraceEvent[];

// Chrome has no gesture-end trace event, so the interaction window stays open
// this long past the last input dispatch to also cover the frames that
// present it (D8: the FrameLoop runs while a gesture is in progress).
const INTERACTION_TAIL_MS = 100;

// Renderer-side dispatch of the DOM events the harness driver can send
// (perf/harness/driver.ts): wheel for pan/scroll/ctrl-pinch, the mouse events
// for a pointer drag, and keydown for typing. Chrome emits these as
// "EventDispatch" under the always-on "devtools.timeline" category (verified
// 2026-10-02 against this worktree's acceptance traces), so no extra trace
// category is needed.
const INPUT_DISPATCH_EVENT_TYPES = new Set([
  "wheel",
  "mousedown",
  "mousemove",
  "mouseup",
  "keydown",
]);

export interface TraceClassifierOptions {
  readonly applicationMarkers?: readonly string[];
  readonly bridgeMetrics?: BridgeMetrics;
}

export interface FrameCounts {
  readonly total: number;
  readonly presented: number;
  readonly partiallyPresented: number;
  readonly dropped: number;
  readonly idle: number;
  readonly wakeUp?: number;
}

export interface TraceMetrics {
  readonly valid: true;
  readonly frameSource: "PipelineReporter" | "DevToolsFrameModel";
  readonly frames: FrameCounts;
  readonly traceFrames: FrameCounts;
  readonly pipelineFrames?: FrameCounts;
  readonly intervalsMs: IntervalStatistics;
  readonly intervalsOver12_5Ms: Statistic;
  readonly mainThreadTasks: number;
  readonly applicationTaskCount: number;
  readonly browserTaskCount: number;
  readonly longestApplicationTaskMs: Statistic;
  readonly longestBrowserTaskMs: Statistic;
  readonly maxMainThreadTaskMs: Statistic;
  readonly tasksOver8_33Ms: Statistic;
  readonly gc: {
    readonly count: number;
    readonly totalDurationMs: number;
    readonly maxPauseMs: number;
  };
  readonly stages: Readonly<Record<string, BridgeStageMetrics>>;
  readonly residencyBacklog: Statistic;
  readonly gpuTimeMs: Statistic;
}

export interface IntervalStatistics {
  readonly p50: Statistic;
  readonly p95: Statistic;
  readonly p99: Statistic;
  readonly max: Statistic;
}

export interface InvalidMeasurement {
  readonly valid: false;
  readonly reason:
    | "trace-parse-failed"
    | "zero-main-thread-tasks"
    | "zero-pipeline-frames"
    | "zero-frame-model-frames"
    | "app-bridge-missing"
    | "app-not-settled"
    | "editing-unavailable"
    | "reference-files-missing"
    | "load-finished-before-gesture"
    | "gesture-dispatch-failed"
    | "gesture-wall-time-exceeded"
    | "camera-mismatch"
    | "camera-range-mismatch";
  readonly detail?: string;
}

export type TraceClassification = TraceMetrics | InvalidMeasurement;

interface TraceThread {
  readonly pid: number;
  readonly tid: number;
}

interface ClassifiedTask {
  readonly event: TraceEvent;
  readonly application: boolean;
}

interface OpenTask {
  readonly event: TraceEvent;
  application: boolean;
}

interface MainThreadTaskMetrics {
  readonly tasks: readonly ClassifiedTask[];
  readonly applicationTaskCount: number;
  readonly browserTaskCount: number;
  readonly longestApplicationTaskMs: Statistic;
  readonly longestBrowserTaskMs: Statistic;
  readonly maxMainThreadTaskMs: Statistic;
  readonly tasksOver8_33Ms: Statistic;
}

export async function recordTrace(
  cdp: CDPSession,
  run: () => Promise<void>,
): Promise<TraceEvents> {
  const events: TraceEvent[] = [];
  const onData = (payload: { value: readonly object[] }): void => {
    events.push(...(payload.value as readonly TraceEvent[]));
  };
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", {
    categories: TRACE_CATEGORIES.join(","),
    transferMode: "ReportEvents",
  });
  try {
    await run();
  } finally {
    const complete = new Promise<void>((resolve) => {
      cdp.once("Tracing.tracingComplete", () => {
        resolve();
      });
    });
    await cdp.send("Tracing.end");
    await complete;
    cdp.off("Tracing.dataCollected", onData);
  }
  return events;
}

export async function classifyTrace(
  events: TraceEvents,
  options: TraceClassifierOptions = {},
): Promise<TraceClassification> {
  const parsedTrace = await parseTrace(events);
  if (!parsedTrace) return invalid("trace-parse-failed");

  const mainThread = rendererMainThread(events);
  const taskMetrics = classifyMainThreadTasks(
    events,
    mainThread,
    options.applicationMarkers,
  );
  if (taskMetrics.tasks.length === 0) {
    return invalid("zero-main-thread-tasks");
  }

  const frames = pipelineFrames(events);
  if (frames.length === 0) return invalid("zero-pipeline-frames");

  const modelFrames = parsedTrace.data.Frames.frames;
  if (modelFrames.length === 0) return invalid("zero-frame-model-frames");

  const framesInWindow = framesWithinInteractionWindow(events, frames);
  const modelFramesInWindow = framesWithinInteractionWindow(
    events,
    modelFrames,
  );
  const wakeUpFrameTimes = collectWakeUpFrameTimes(events);
  const intervals = presentedIntervalsMs(framesInWindow, wakeUpFrameTimes);
  const bridge = options.bridgeMetrics ?? unavailableBridgeMetrics();
  return {
    valid: true,
    frameSource: "DevToolsFrameModel",
    frames: frameModelCounts(modelFramesInWindow, wakeUpFrameTimes),
    traceFrames: frameModelCounts(modelFrames, wakeUpFrameTimes),
    pipelineFrames: frameCounts(framesInWindow),
    intervalsMs: intervalStatistics(intervals),
    intervalsOver12_5Ms: countLongIntervals(intervals, 12.5),
    mainThreadTasks: taskMetrics.tasks.length,
    applicationTaskCount: taskMetrics.applicationTaskCount,
    browserTaskCount: taskMetrics.browserTaskCount,
    longestApplicationTaskMs: taskMetrics.longestApplicationTaskMs,
    longestBrowserTaskMs: taskMetrics.longestBrowserTaskMs,
    maxMainThreadTaskMs: taskMetrics.maxMainThreadTaskMs,
    tasksOver8_33Ms: taskMetrics.tasksOver8_33Ms,
    gc: classifyGc(events, mainThread),
    stages: bridge.stages,
    residencyBacklog: bridge.residencyBacklog,
    gpuTimeMs: bridge.gpuTimeMs,
  };
}

async function parseTrace(
  events: TraceEvents,
): Promise<TraceModel.ParsedTrace | null> {
  try {
    const model = TraceModel.Model.createWithAllHandlers();
    await model.parse(events as unknown as Types.Events.Event[]);
    return model.parsedTrace();
  } catch {
    return null;
  }
}

function pipelineFrames(events: TraceEvents): TraceEvent[] {
  const pipelineEvents = events.filter(
    (event) =>
      event.name === "PipelineReporter" && hasCategory(event.cat, "cc"),
  );
  const paired = Helpers.Trace.createMatchedSortedSyntheticEvents(
    pipelineEvents as unknown as Types.Events.PipelineReporter[],
  );
  return paired
    .map((frame): TraceEvent | null => {
      const source: unknown = frame.rawSourceEvent;
      return isTraceEvent(source) ? source : null;
    })
    .filter(isTraceEvent)
    .sort(compareTraceEvents);
}

interface InteractionWindow {
  readonly startTs: number;
  readonly endTs: number;
}

function framesWithinInteractionWindow<
  T extends TraceEvent | Types.Events.LegacyTimelineFrame,
>(events: TraceEvents, frames: readonly T[]): readonly T[] {
  const window = interactionWindow(events);
  if (!window) return frames;
  return frames.filter(
    (frame) =>
      getFrameStartTime(frame) >= window.startTs &&
      getFrameStartTime(frame) <= window.endTs,
  );
}

function getFrameStartTime(
  frame: TraceEvent | Types.Events.LegacyTimelineFrame,
): number {
  return "startTime" in frame ? frame.startTime : frame.ts;
}

function interactionWindow(events: TraceEvents): InteractionWindow | undefined {
  const timestamps = events
    .filter(isInputDispatchEvent)
    .map((event) => event.ts);
  if (timestamps.length === 0) return undefined;
  return {
    startTs: Math.min(...timestamps),
    endTs: Math.max(...timestamps) + INTERACTION_TAIL_MS * 1_000,
  };
}

function isInputDispatchEvent(event: TraceEvent): boolean {
  if (
    event.name !== "EventDispatch" ||
    !hasCategory(event.cat, "devtools.timeline")
  ) {
    return false;
  }
  const data = isRecord(event.args) ? event.args.data : undefined;
  return (
    isRecord(data) &&
    typeof data.type === "string" &&
    INPUT_DISPATCH_EVENT_TYPES.has(data.type)
  );
}

function collectWakeUpFrameTimes(events: TraceEvents): ReadonlySet<number> {
  const frameTimes = new Set<number>();
  for (const event of events) {
    if (
      event.name !== "Scheduler::BeginImplFrame" ||
      event.ph !== "X" ||
      !hasCategory(event.cat, "cc")
    ) {
      continue;
    }
    const eventArgs = isRecord(event.args) ? event.args.args : undefined;
    if (!isRecord(eventArgs) || eventArgs.subtype !== "MISSED") continue;
    const frameTime = eventArgs.frame_time_us;
    if (typeof frameTime === "number" && Number.isFinite(frameTime)) {
      frameTimes.add(frameTime);
    }
  }
  return frameTimes;
}

function frameCounts(frames: readonly TraceEvent[]): TraceMetrics["frames"] {
  const statuses = frames.map(frameState);
  return {
    total: frames.length,
    presented: statuses.filter((state) => state === "STATE_PRESENTED_ALL")
      .length,
    partiallyPresented: statuses.filter(
      (state) => state === "STATE_PRESENTED_PARTIAL",
    ).length,
    dropped: statuses.filter((state) => state === "STATE_DROPPED").length,
    idle: statuses.filter(
      (state) =>
        state !== "STATE_PRESENTED_ALL" &&
        state !== "STATE_PRESENTED_PARTIAL" &&
        state !== "STATE_DROPPED",
    ).length,
  };
}

function frameModelCounts(
  frames: readonly Types.Events.LegacyTimelineFrame[],
  wakeUpFrameTimes: ReadonlySet<number>,
): FrameCounts {
  const counts = {
    total: frames.length,
    presented: 0,
    partiallyPresented: 0,
    dropped: 0,
    idle: 0,
    wakeUp: 0,
  };
  for (const frame of frames) {
    if (wakeUpFrameTimes.has(frame.startTime)) {
      counts.wakeUp += 1;
      continue;
    }
    if (frame.isPartial) {
      counts.partiallyPresented += 1;
      continue;
    }
    if (frame.dropped) {
      counts.dropped += 1;
      continue;
    }
    if (frame.idle) {
      counts.idle += 1;
      continue;
    }
    counts.presented += 1;
  }
  return counts;
}

function presentedIntervalsMs(
  frames: readonly TraceEvent[],
  wakeUpFrameTimes: ReadonlySet<number>,
): number[] {
  // Match spike C: only STATE_PRESENTED_ALL timestamps define presentation
  // intervals, so idle/no-damage pipeline records never become frame gaps.
  const presented = frames.filter(
    (frame) => frameState(frame) === "STATE_PRESENTED_ALL",
  );
  const intervals: number[] = [];
  for (let index = 1; index < presented.length; index += 1) {
    const previous = presented[index - 1];
    const current = presented[index];
    if (!previous || !current) continue;
    if (wakeUpFrameTimes.has(previous.ts) || wakeUpFrameTimes.has(current.ts)) {
      continue;
    }
    if (isIdleGap(frames, previous.ts, current.ts, wakeUpFrameTimes)) {
      continue;
    }
    intervals.push((current.ts - previous.ts) / 1_000);
  }
  return intervals;
}

function isIdleGap(
  frames: readonly TraceEvent[],
  startTs: number,
  endTs: number,
  wakeUpFrameTimes: ReadonlySet<number>,
): boolean {
  let hasIdleFrame = false;
  for (const frame of frames) {
    if (frame.ts <= startTs || frame.ts >= endTs) continue;
    if (
      frameState(frame) !== "STATE_NO_UPDATE_DESIRED" &&
      !frameDoesNotAffectSmoothness(frame) &&
      !wakeUpFrameTimes.has(frame.ts)
    ) {
      return false;
    }
    hasIdleFrame = true;
  }
  return hasIdleFrame;
}

function frameDoesNotAffectSmoothness(event: TraceEvent): boolean {
  const args = event.args;
  if (!args) return false;
  const reporter = args.frame_reporter ?? args.chrome_frame_reporter;
  return isRecord(reporter) && reporter.affects_smoothness === false;
}

function intervalStatistics(values: readonly number[]): IntervalStatistics {
  return {
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    max: values.length > 0 ? Math.max(...values) : UNAVAILABLE,
  };
}

function rendererMainThread(events: TraceEvents): TraceThread | undefined {
  const taskCounts = new Map<string, number>();
  for (const event of events) {
    if (!isTask(event)) continue;
    const key = threadKey(event);
    taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
  }
  const candidates = events.filter(
    (event) =>
      event.name === "thread_name" && event.args?.name === "CrRendererMain",
  );
  let selected: TraceThread | undefined;
  let selectedCount = -1;
  for (const candidate of candidates) {
    const count = taskCounts.get(threadKey(candidate)) ?? 0;
    if (count > selectedCount) {
      selected = { pid: candidate.pid, tid: candidate.tid };
      selectedCount = count;
    }
  }
  return selected;
}

function classifyMainThreadTasks(
  events: TraceEvents,
  mainThread: TraceThread | undefined,
  markers: readonly string[] = ["/assets/", "/src/", "main.js", "monaco"],
): MainThreadTaskMetrics {
  if (!mainThread) return emptyTaskMetrics();
  const sorted = events
    .filter(
      (event) => event.pid === mainThread.pid && event.tid === mainThread.tid,
    )
    .slice()
    .sort(compareTraceEvents);
  const open: OpenTask[] = [];
  const roots: ClassifiedTask[] = [];
  for (const event of sorted) {
    closeFinishedTasks(open, event.ts, roots);
    if (isTask(event)) {
      open.push({ event, application: hasApplicationMarker(event, markers) });
      continue;
    }
    if (hasApplicationMarker(event, markers)) {
      const current = open[open.length - 1];
      if (current) current.application = true;
    }
  }
  closeFinishedTasks(open, Number.POSITIVE_INFINITY, roots);
  return summarizeTasks(roots);
}

function closeFinishedTasks(
  open: OpenTask[],
  timestamp: number,
  roots: ClassifiedTask[],
): void {
  while (open.length > 0) {
    const current = open[open.length - 1];
    if (!current || current.event.ts + (current.event.dur ?? 0) > timestamp) {
      return;
    }
    open.pop();
    const parent = open[open.length - 1];
    if (parent) {
      parent.application ||= current.application;
    } else {
      roots.push({ event: current.event, application: current.application });
    }
  }
}

function summarizeTasks(
  tasks: readonly ClassifiedTask[],
): MainThreadTaskMetrics {
  const application = tasks.filter((task) => task.application);
  const browser = tasks.filter((task) => !task.application);
  const durations = tasks.map((task) => (task.event.dur ?? 0) / 1_000);
  return {
    tasks,
    applicationTaskCount: application.length,
    browserTaskCount: browser.length,
    longestApplicationTaskMs: longestTaskMs(application),
    longestBrowserTaskMs: longestTaskMs(browser),
    maxMainThreadTaskMs:
      durations.length > 0 ? Math.max(...durations) : UNAVAILABLE,
    tasksOver8_33Ms: countLongIntervals(durations, 8.33),
  };
}

function longestTaskMs(tasks: readonly ClassifiedTask[]): Statistic {
  if (tasks.length === 0) return UNAVAILABLE;
  return Math.max(...tasks.map((task) => (task.event.dur ?? 0) / 1_000));
}

function classifyGc(
  events: TraceEvents,
  mainThread: TraceThread | undefined,
): TraceMetrics["gc"] {
  if (!mainThread) return { count: 0, totalDurationMs: 0, maxPauseMs: 0 };
  const pauses = events.filter(
    (event) =>
      event.pid === mainThread.pid &&
      event.tid === mainThread.tid &&
      (event.name === "MinorGC" || event.name === "MajorGC") &&
      hasCategory(event.cat, "devtools.timeline") &&
      (event.dur ?? 0) > 0,
  );
  const durations = pauses.map((event) => (event.dur ?? 0) / 1_000);
  return {
    count: durations.length,
    totalDurationMs: durations.reduce((total, duration) => total + duration, 0),
    maxPauseMs: durations.length > 0 ? Math.max(...durations) : 0,
  };
}

function isTask(event: TraceEvent): boolean {
  return (
    (event.name === "RunTask" || event.name === "Task") && (event.dur ?? 0) > 0
  );
}

function hasApplicationMarker(
  event: TraceEvent,
  markers: readonly string[],
): boolean {
  const text = JSON.stringify(event.args ?? {});
  return markers.some((marker) => text.includes(marker));
}

function compareTraceEvents(left: TraceEvent, right: TraceEvent): number {
  return left.ts - right.ts || (right.dur ?? 0) - (left.dur ?? 0);
}

function threadKey(thread: TraceThread): string {
  return `${String(thread.pid)}:${String(thread.tid)}`;
}

function frameState(event: TraceEvent): unknown {
  const args = event.args;
  if (!args) return undefined;
  const reporter = args.frame_reporter ?? args.chrome_frame_reporter;
  if (!isRecord(reporter)) return undefined;
  return reporter.state;
}

function hasCategory(category: string | undefined, expected: string): boolean {
  return category?.split(",").includes(expected) ?? false;
}

function isTraceEvent(value: unknown): value is TraceEvent {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.ts === "number"
  );
}

function emptyTaskMetrics(): MainThreadTaskMetrics {
  return {
    tasks: [],
    applicationTaskCount: 0,
    browserTaskCount: 0,
    longestApplicationTaskMs: UNAVAILABLE,
    longestBrowserTaskMs: UNAVAILABLE,
    maxMainThreadTaskMs: UNAVAILABLE,
    tasksOver8_33Ms: UNAVAILABLE,
  };
}

function invalid(reason: InvalidMeasurement["reason"]): InvalidMeasurement {
  return { valid: false, reason };
}

function unavailableBridgeMetrics(): BridgeMetrics {
  return {
    stages: {},
    residencyBacklog: UNAVAILABLE,
    gpuTimeMs: UNAVAILABLE,
  };
}
