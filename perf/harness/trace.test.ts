import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { expect, it } from "vitest";

import {
  classifyTrace,
  recordTrace,
  TRACE_CATEGORIES,
  type InvalidMeasurement,
  type TraceClassification,
  type TraceClassifierOptions,
  type TraceEvent,
  type TraceEvents,
  type TraceMetrics,
} from "./trace";

const mainThreadMetadata: TraceEvent = {
  name: "thread_name",
  ph: "M",
  ts: 0,
  pid: 1,
  tid: 3,
  args: { name: "CrRendererMain" },
};

const frame = (index: number, state: string, category = "cc"): TraceEvent[] => {
  const timestamp = index * 8_000;
  return [
    {
      name: "PipelineReporter",
      cat: category,
      ph: "b",
      ts: timestamp,
      dur: 0,
      pid: 1,
      tid: 2,
      id: String(index),
      args: { frame_reporter: { state } },
    },
    {
      name: "PipelineReporter",
      cat: category,
      ph: "e",
      ts: timestamp + 4_000,
      dur: 0,
      pid: 1,
      tid: 2,
      id: String(index),
      args: { frame_reporter: { state } },
    },
  ];
};

const task = (
  timestamp: number,
  duration: number,
  url: string,
  tid = 3,
): TraceEvent => ({
  name: "RunTask",
  cat: "toplevel",
  ph: "X",
  ts: timestamp,
  dur: duration,
  pid: 1,
  tid,
  args: { data: { url } },
});

const inputDispatch = (timestamp: number, type: string): TraceEvent => ({
  name: "EventDispatch",
  cat: "devtools.timeline",
  ph: "X",
  ts: timestamp,
  dur: 1,
  pid: 1,
  tid: 3,
  args: { data: { type } },
});

const traceForStates = (
  states: readonly string[],
  tasks: readonly TraceEvent[] = [
    task(0, 1_000, "https://app.test/assets/main.js"),
  ],
  category = "cc",
): TraceEvents => [
  mainThreadMetadata,
  ...states.flatMap((state, index) => frame(index, state, category)),
  ...tasks,
];

const classifierOptions: TraceClassifierOptions = {
  applicationMarkers: ["app.test"],
};

const classify = async (events: TraceEvents): Promise<TraceMetrics> => {
  const result = await classifyTrace(events, classifierOptions);
  if (!result.valid) throw new Error(`expected valid trace: ${result.reason}`);
  return result;
};

it("counts presented frames", async () => {
  const metrics = await classify(
    traceForStates(["STATE_PRESENTED_ALL", "STATE_PRESENTED_ALL"]),
  );

  expect(metrics.frames.presented).toBe(2);
});

it("counts partially presented frames", async () => {
  const metrics = await classify(
    traceForStates(["STATE_PRESENTED_PARTIAL", "STATE_PRESENTED_ALL"]),
  );

  expect(metrics.frames.partiallyPresented).toBe(1);
});

it("counts dropped frames", async () => {
  const metrics = await classify(
    traceForStates(["STATE_DROPPED", "STATE_PRESENTED_ALL"]),
  );

  expect(metrics.frames.dropped).toBe(1);
});

it("ignores idle frames when measuring presentation intervals", async () => {
  const metrics = await classify(
    traceForStates([
      "STATE_PRESENTED_ALL",
      "STATE_PRESENTED_NO_DAMAGE",
      "STATE_PRESENTED_ALL",
    ]),
  );

  expect(metrics.frames.idle).toBe(1);
  expect(metrics.intervalsMs.max).toBe(16);
  expect(metrics.intervalsOver12_5Ms).toBe(1);
});

it("keeps the whole trace when there are no input dispatch events", async () => {
  const metrics = await classify(
    traceForStates(["STATE_PRESENTED_ALL", "STATE_PRESENTED_ALL"]),
  );

  expect(metrics.frames.total).toBe(2);
});

it("excludes presented frames before the first input event and after its tail", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    task(0, 1_000, "https://app.test/assets/main.js"),
    ...frame(0, "STATE_PRESENTED_ALL"), // ts 0: idle time before the gesture
    inputDispatch(100_000, "wheel"),
    ...frame(20, "STATE_PRESENTED_ALL"), // ts 160,000: inside the window
    ...frame(21, "STATE_PRESENTED_ALL"), // ts 168,000: inside the window
    inputDispatch(168_000, "wheel"),
    ...frame(40, "STATE_PRESENTED_ALL"), // ts 320,000: past the 100 ms tail
  ]);

  expect(metrics.frames.total).toBe(2);
  expect(metrics.frames.presented).toBe(2);
});

it("counts whole-trace frames separately from interaction-window frames", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    task(0, 1_000, "https://app.test/assets/main.js"),
    ...frame(0, "STATE_PRESENTED_ALL"), // before the first input
    inputDispatch(100_000, "wheel"),
    ...frame(20, "STATE_PRESENTED_PARTIAL"), // inside the window
    ...frame(21, "STATE_DROPPED"), // inside the window
    inputDispatch(168_000, "wheel"),
    ...frame(30, "STATE_PRESENTED_ALL"), // inside the tail
    ...frame(40, "STATE_PRESENTED_NO_DAMAGE"), // after the tail
  ]);

  expect(metrics.traceFrames).toEqual({
    total: 5,
    presented: 2,
    partiallyPresented: 1,
    dropped: 1,
    idle: 1,
  });
  expect(metrics.frames).toEqual({
    total: 3,
    presented: 1,
    partiallyPresented: 1,
    dropped: 1,
    idle: 0,
  });
});

it("still counts a long interval between two presented frames inside the window", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    task(0, 1_000, "https://app.test/assets/main.js"),
    inputDispatch(0, "wheel"),
    ...frame(0, "STATE_PRESENTED_ALL"), // ts 0
    ...frame(5, "STATE_PRESENTED_ALL"), // ts 40,000: a 40 ms gap
  ]);

  expect(metrics.intervalsMs.max).toBe(40);
  expect(metrics.intervalsOver12_5Ms).toBe(1);
});

it("counts a main-thread task that runs before the interaction window", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    task(0, 9_000, "https://app.test/assets/main.js"),
    inputDispatch(50_000, "wheel"),
    ...frame(10, "STATE_PRESENTED_ALL"), // ts 80,000: inside the window
  ]);

  expect(metrics.longestApplicationTaskMs).toBe(9);
});

it("attributes long application and browser tasks on the renderer main thread", async () => {
  const metrics = await classify(
    traceForStates(
      ["STATE_PRESENTED_ALL", "STATE_PRESENTED_ALL"],
      [
        task(0, 9_000, "https://app.test/assets/main.js"),
        task(20_000, 12_000, "chrome://browser/browser.js"),
      ],
    ),
  );

  expect(metrics.longestApplicationTaskMs).toBe(9);
  expect(metrics.longestBrowserTaskMs).toBe(12);
  expect(metrics.maxMainThreadTaskMs).toBe(12);
  expect(metrics.tasksOver8_33Ms).toBe(2);
});

it("does not count a worker task as a renderer main-thread task", async () => {
  const metrics = await classify(
    traceForStates(
      ["STATE_PRESENTED_ALL", "STATE_PRESENTED_ALL"],
      [
        task(0, 1_000, "https://app.test/assets/main.js"),
        task(20_000, 20_000, "https://app.test/assets/worker.js", 4),
      ],
    ),
  );

  expect(metrics.mainThreadTasks).toBe(1);
  expect(metrics.applicationTaskCount).toBe(1);
  expect(metrics.longestApplicationTaskMs).toBe(1);
});

it("counts only MinorGC and MajorGC main-thread pauses", async () => {
  const metrics = await classify([
    ...traceForStates(["STATE_PRESENTED_ALL", "STATE_PRESENTED_ALL"]),
    {
      name: "MinorGC",
      cat: "devtools.timeline",
      ph: "X",
      ts: 40_000,
      dur: 3_000,
      pid: 1,
      tid: 3,
    },
    {
      name: "MajorGC",
      cat: "devtools.timeline",
      ph: "X",
      ts: 50_000,
      dur: 5_000,
      pid: 1,
      tid: 3,
    },
    {
      name: "V8.GC_MINOR_MARK",
      cat: "disabled-by-default-v8.gc",
      ph: "X",
      ts: 60_000,
      dur: 7_000,
      pid: 1,
      tid: 3,
    },
  ]);

  expect(metrics.gc).toEqual({
    count: 2,
    totalDurationMs: 8,
    maxPauseMs: 5,
  });
});

it("returns invalid measurement for an empty trace", async () => {
  const result: TraceClassification = await classifyTrace([]);

  expect(result).toEqual({ valid: false, reason: "zero-main-thread-tasks" });
  expect((result as InvalidMeasurement).valid).toBe(false);
});

it("returns invalid measurement when cc PipelineReporter events are absent", async () => {
  const result = await classifyTrace(
    traceForStates(
      ["STATE_PRESENTED_ALL"],
      [task(0, 1_000, "https://app.test/assets/main.js")],
      "devtools.timeline",
    ),
  );

  expect(result).toEqual({ valid: false, reason: "zero-pipeline-frames" });
});

// Main-thread task metrics (below) are a whole-trace measurement, matching
// spike C's own analyzer (spikes/c/analyze-traces.mjs) run on this file:
// longest RunTask over all threads 9.261 ms. The table in docs/spikes/c.md is
// from another run of that spike.
// Frame counts (harness R3) are windowed to the interaction instead: this
// golden trace has 5 keydown EventDispatch events clustered early, so only
// the frames from the first to the last of them, plus a 100 ms tail, count —
// 13 of the trace's 187 pipeline frames, with the idle time before and after
// typing correctly excluded.
it("reproduces the paste-500-lines golden trace counts", async () => {
  const startedAt = performance.now();
  const compressed = readFileSync(
    "perf/harness/fixtures/paste-500-lines.json.gz",
  );
  const decoded = JSON.parse(gunzipSync(compressed).toString("utf8")) as {
    traceEvents: TraceEvent[];
  };
  const metrics = await classify(decoded.traceEvents);
  const durationMs = performance.now() - startedAt;
  process.stdout.write(`golden trace duration: ${durationMs.toFixed(1)} ms\n`);

  expect(metrics.frames).toMatchObject({
    total: 13,
    presented: 12,
    dropped: 1,
    partiallyPresented: 0,
    idle: 0,
  });
  expect(metrics.maxMainThreadTaskMs).toBeLessThanOrEqual(9.261);
  expect(metrics.tasksOver8_33Ms).toBeLessThanOrEqual(2);
  expect(durationMs).toBeLessThan(2_000);
});

it("records a CDP trace with the required categories", async () => {
  const sent: string[] = [];
  let complete: (() => void) | undefined;
  const cdp = {
    on: () => cdp,
    off: () => cdp,
    once: (_event: string, listener: () => void) => {
      complete = listener;
      return cdp;
    },
    send: (method: string) => {
      sent.push(method);
      if (method === "Tracing.end") complete?.();
      return Promise.resolve();
    },
  };

  const events = await recordTrace(
    cdp as unknown as import("@playwright/test").CDPSession,
    () => Promise.resolve(),
  );

  expect(events).toEqual([]);
  expect(sent).toEqual(["Tracing.start", "Tracing.end"]);
  expect(TRACE_CATEGORIES).toContain("cc");
  expect(TRACE_CATEGORIES).toContain(
    "disabled-by-default-devtools.timeline.frame",
  );
});
