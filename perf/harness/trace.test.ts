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

interface FrameOptions {
  readonly modelState?: string;
  readonly affectsSmoothness?: boolean;
  readonly beginFrameSubtype?: "MISSED" | "NORMAL";
  readonly modelTimestamp?: number;
}

const frame = (
  index: number,
  state: string,
  category = "cc",
  options: FrameOptions = {},
): TraceEvent[] => {
  const timestamp = index * 8_000;
  const modelTimestamp = options.modelTimestamp ?? timestamp + 10_000;
  const modelState = options.modelState ?? state;
  const reporter =
    options.affectsSmoothness === undefined
      ? { state }
      : { state, affects_smoothness: options.affectsSmoothness };
  return [
    ...(options.beginFrameSubtype === undefined
      ? []
      : [
          {
            name: "Scheduler::BeginImplFrame",
            cat: "cc",
            ph: "X",
            ts: modelTimestamp,
            dur: 0,
            pid: 1,
            tid: 2,
            args: {
              args: {
                subtype: options.beginFrameSubtype,
                frame_time_us: modelTimestamp,
                sequence_number: index + 1,
              },
            },
          },
        ]),
    {
      name: "PipelineReporter",
      cat: category,
      ph: "b",
      ts: timestamp,
      dur: 0,
      pid: 1,
      tid: 2,
      id: String(index),
      args: { frame_reporter: reporter },
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
      args: { frame_reporter: reporter },
    },
    ...modelFrameEvents(modelTimestamp, index + 1, modelState),
  ];
};

const modelFrameEvents = (
  timestamp: number,
  sequence: number,
  state: string,
): TraceEvent[] => {
  const modelEvents: TraceEvent[] = [
    {
      name: "SetLayerTreeId",
      cat: "",
      ph: "I",
      ts: 0,
      pid: 1,
      tid: 2,
      args: { data: { frame: "", layerTreeId: 7 } },
    },
    {
      name: "BeginFrame",
      cat: "disabled-by-default-devtools.timeline.frame",
      ph: "I",
      ts: timestamp,
      pid: 1,
      tid: 2,
      args: { layerTreeId: 7, frameSeqId: sequence },
    },
  ];
  if (state === "STATE_DROPPED" || state === "STATE_PRESENTED_PARTIAL") {
    modelEvents.push({
      name: "DroppedFrame",
      cat: "disabled-by-default-devtools.timeline.frame",
      ph: "I",
      ts: timestamp + 1_000,
      pid: 1,
      tid: 2,
      args: {
        layerTreeId: 7,
        frameSeqId: sequence,
        hasPartialUpdate: state === "STATE_PRESENTED_PARTIAL",
      },
    });
  }
  if (
    state !== "STATE_PRESENTED_ALL" &&
    state !== "STATE_PRESENTED_PARTIAL" &&
    state !== "STATE_DROPPED"
  ) {
    modelEvents.push({
      name: "NeedsBeginFrameChanged",
      cat: "disabled-by-default-devtools.timeline.frame",
      ph: "I",
      ts: timestamp + 1_000,
      pid: 1,
      tid: 2,
      args: { layerTreeId: 7, data: { needsBeginFrame: 1 } },
    });
  }
  modelEvents.push({
    name: "DrawFrame",
    cat: "disabled-by-default-devtools.timeline.frame",
    ph: "I",
    ts: timestamp + 4_000,
    pid: 1,
    tid: 2,
    args: { layerTreeId: 7, frameSeqId: sequence },
  });
  return modelEvents;
};

const modelFrame = (
  index: number,
  state = "STATE_PRESENTED_ALL",
): TraceEvent[] => modelFrameEvents(index * 8_000 + 10_000, index + 1, state);

const pipelineReporterFrames = (events: TraceEvents): TraceEvent[] =>
  events
    .filter(
      (event) =>
        event.name === "PipelineReporter" &&
        event.ph === "b" &&
        event.cat?.split(",").includes("cc"),
    )
    .slice()
    .sort((left, right) => left.ts - right.ts);

const pipelineState = (event: TraceEvent): string => {
  const reporter = event.args?.frame_reporter;
  if (typeof reporter !== "object" || reporter === null) {
    return "STATE_PRESENTED_ALL";
  }
  return "state" in reporter ? String(reporter.state) : "STATE_PRESENTED_ALL";
};

const modelEventsForPipelineFrames = (
  pipelineFrames: readonly TraceEvent[],
): TraceEvent[] => {
  const modelEvents = pipelineFrames.flatMap((event, index) =>
    modelFrameEvents(event.ts + 1_000, index + 1, pipelineState(event)),
  );
  const last = pipelineFrames[pipelineFrames.length - 1];
  if (
    last &&
    ["STATE_DROPPED", "STATE_PRESENTED_PARTIAL"].includes(pipelineState(last))
  ) {
    modelEvents.push(
      ...modelFrameEvents(
        last.ts + 9_000,
        pipelineFrames.length + 1,
        "STATE_PRESENTED_ALL",
      ),
    );
  }
  return modelEvents;
};

interface FrameModelFixtureContext {
  readonly pid: number;
  readonly mainThreadId: number;
  readonly compositorThreadId: number;
  readonly layerTreeId: unknown;
  readonly frameId: unknown;
}

const frameModelFixtureContext = (
  events: TraceEvents,
): FrameModelFixtureContext => {
  const layerTreeEvent = events.find(
    (event) => event.name === "SetLayerTreeId",
  );
  const compositorThread = events.find(
    (event) =>
      event.name === "thread_name" &&
      event.args?.name === "Compositor" &&
      event.pid === layerTreeEvent?.pid,
  );
  const data = layerTreeEvent?.args?.data;
  const layerTreeData = typeof data === "object" && data !== null ? data : {};
  return {
    pid: layerTreeEvent?.pid ?? 1,
    mainThreadId: layerTreeEvent?.tid ?? 2,
    compositorThreadId: compositorThread?.tid ?? 2,
    layerTreeId: "layerTreeId" in layerTreeData ? layerTreeData.layerTreeId : 7,
    frameId: "frame" in layerTreeData ? layerTreeData.frame : "",
  };
};

const adaptModelEvent = (
  event: TraceEvent,
  context: FrameModelFixtureContext,
): TraceEvent => ({
  ...event,
  pid: context.pid,
  tid:
    event.name === "SetLayerTreeId"
      ? context.mainThreadId
      : context.compositorThreadId,
  args:
    event.name === "SetLayerTreeId"
      ? { data: { frame: context.frameId, layerTreeId: context.layerTreeId } }
      : { ...event.args, layerTreeId: context.layerTreeId },
});

const withFrameModelEvents = (events: TraceEvents): TraceEvents => {
  const pipelineFrames = pipelineReporterFrames(events);
  const context = frameModelFixtureContext(events);
  const modelEvents = modelEventsForPipelineFrames(pipelineFrames);
  return [
    ...events,
    ...modelEvents.map((event) => adaptModelEvent(event, context)),
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
  affectsSmoothness: readonly (boolean | undefined)[] = [],
): TraceEvents => [
  mainThreadMetadata,
  ...states.flatMap((state, index) => {
    const smoothness = affectsSmoothness[index];
    return frame(
      index,
      state,
      category,
      smoothness === undefined ? {} : { affectsSmoothness: smoothness },
    );
  }),
  ...(states[states.length - 1] === "STATE_DROPPED" ||
  states[states.length - 1] === "STATE_PRESENTED_PARTIAL"
    ? modelFrame(states.length)
    : []),
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
  expect(metrics.pipelineFrames?.partiallyPresented).toBe(1);
});

it("counts dropped frames", async () => {
  const metrics = await classify(
    traceForStates(["STATE_DROPPED", "STATE_PRESENTED_ALL"]),
  );

  expect(metrics.frames.dropped).toBe(1);
});

it("sets aside a dropped frame whose begin-frame was missed", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    ...frame(-1, "STATE_PRESENTED_ALL"),
    ...frame(0, "STATE_DROPPED", "cc", { beginFrameSubtype: "MISSED" }),
    ...frame(1, "STATE_PRESENTED_ALL"),
    task(0, 1_000, "https://app.test/assets/main.js"),
  ]);

  expect(metrics.frames.dropped).toBe(0);
  expect(metrics.frames.partiallyPresented).toBe(0);
  expect(metrics.frames.wakeUp).toBe(1);
});

it("counts a dropped frame with a normal begin-frame", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    ...frame(-1, "STATE_PRESENTED_ALL"),
    ...frame(0, "STATE_DROPPED", "cc", { beginFrameSubtype: "NORMAL" }),
    ...frame(1, "STATE_PRESENTED_ALL"),
    task(0, 1_000, "https://app.test/assets/main.js"),
  ]);

  expect(metrics.frames.dropped).toBe(1);
  expect(metrics.frames.wakeUp).toBe(0);
});

it("uses the frame model when PipelineReporter says a frame was dropped", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    ...frame(0, "STATE_DROPPED", "cc", {
      modelState: "STATE_PRESENTED_ALL",
    }),
    task(0, 1_000, "https://app.test/assets/main.js"),
  ]);

  expect(metrics.frames.dropped).toBe(0);
  expect(metrics.pipelineFrames?.dropped).toBe(1);
});

it("does not count a gap of idle frames as a presentation interval", async () => {
  const metrics = await classify(
    traceForStates([
      "STATE_PRESENTED_ALL",
      "STATE_PRESENTED_ALL",
      "STATE_NO_UPDATE_DESIRED",
      "STATE_NO_UPDATE_DESIRED",
      "STATE_PRESENTED_ALL",
    ]),
  );

  expect(metrics.frames.idle).toBe(2);
  expect(metrics.intervalsMs.max).toBe(8);
  expect(metrics.intervalsOver12_5Ms).toBe(0);
});

it("counts a gap that holds a dropped frame", async () => {
  const metrics = await classify(
    traceForStates([
      "STATE_PRESENTED_ALL",
      "STATE_NO_UPDATE_DESIRED",
      "STATE_DROPPED",
      "STATE_PRESENTED_ALL",
    ]),
  );

  expect(metrics.frames.dropped).toBe(1);
  expect(metrics.intervalsMs.max).toBe(24);
  expect(metrics.intervalsOver12_5Ms).toBe(1);
});

it("skips a gap whose dropped frame does not affect smoothness", async () => {
  const metrics = await classify(
    traceForStates(
      [
        "STATE_PRESENTED_ALL",
        "STATE_PRESENTED_ALL",
        "STATE_NO_UPDATE_DESIRED",
        "STATE_DROPPED",
        "STATE_PRESENTED_ALL",
      ],
      undefined,
      "cc",
      [undefined, undefined, undefined, false, undefined],
    ),
  );

  expect(metrics.intervalsOver12_5Ms).toBe(0);
});

it("counts a gap whose dropped frame affects smoothness", async () => {
  const metrics = await classify(
    traceForStates(
      [
        "STATE_PRESENTED_ALL",
        "STATE_PRESENTED_ALL",
        "STATE_NO_UPDATE_DESIRED",
        "STATE_DROPPED",
        "STATE_PRESENTED_ALL",
      ],
      undefined,
      "cc",
      [undefined, undefined, undefined, true, undefined],
    ),
  );

  expect(metrics.intervalsOver12_5Ms).toBe(1);
});

it("skips a gap whose dropped frame had a missed begin-frame", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    ...frame(0, "STATE_PRESENTED_ALL"),
    ...frame(1, "STATE_PRESENTED_ALL"),
    ...frame(2, "STATE_NO_UPDATE_DESIRED"),
    ...frame(3, "STATE_DROPPED", "cc", {
      affectsSmoothness: true,
      beginFrameSubtype: "MISSED",
      modelTimestamp: 3 * 8_000,
    }),
    ...frame(4, "STATE_PRESENTED_ALL"),
    task(0, 1_000, "https://app.test/assets/main.js"),
  ]);

  expect(metrics.intervalsOver12_5Ms).toBe(0);
});

it("does not use a presented wake-up frame as an interval endpoint", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    ...frame(-1, "STATE_NO_UPDATE_DESIRED"),
    ...frame(0, "STATE_PRESENTED_ALL"),
    ...frame(1, "STATE_PRESENTED_ALL", "cc", {
      beginFrameSubtype: "MISSED",
      modelTimestamp: 8_000,
    }),
    ...frame(2, "STATE_PRESENTED_ALL"),
    ...frame(3, "STATE_PRESENTED_ALL"),
    task(0, 1_000, "https://app.test/assets/main.js"),
  ]);

  expect(metrics.intervalsOver12_5Ms).toBe(0);
});

it("skips interval pairs adjacent to a presented wake-up frame", async () => {
  const metrics = await classify([
    mainThreadMetadata,
    ...frame(0, "STATE_PRESENTED_ALL"),
    ...frame(1, "STATE_NO_UPDATE_DESIRED"),
    ...frame(2, "STATE_NO_UPDATE_DESIRED"),
    ...frame(3, "STATE_PRESENTED_ALL", "cc", {
      beginFrameSubtype: "MISSED",
      modelTimestamp: 24_000,
    }),
    ...frame(4, "STATE_DROPPED", "cc", { affectsSmoothness: true }),
    ...frame(5, "STATE_PRESENTED_ALL"),
    ...frame(6, "STATE_PRESENTED_ALL"),
    task(0, 1_000, "https://app.test/assets/main.js"),
  ]);

  expect(metrics.intervalsOver12_5Ms).toBe(0);
  expect(metrics.intervalsMs.max).toBeLessThan(12.5);
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

  expect(metrics.pipelineFrames).toEqual({
    total: 3,
    presented: 1,
    partiallyPresented: 1,
    dropped: 1,
    idle: 0,
  });
  expect(metrics.traceFrames).toEqual({
    total: 5,
    presented: 2,
    partiallyPresented: 1,
    dropped: 1,
    idle: 1,
    wakeUp: 0,
  });
  expect(metrics.frames).toEqual({
    total: 3,
    presented: 0,
    partiallyPresented: 1,
    dropped: 1,
    idle: 1,
    wakeUp: 0,
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
  const metrics = await classify(withFrameModelEvents(decoded.traceEvents));
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
