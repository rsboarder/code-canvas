import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import process from "node:process";
import { Console } from "node:console";
import {
  Helpers,
  TraceModel,
} from "@paulirish/trace_engine/models/trace/trace.js";

const defaultTraces = [
  "spikes/a/results/idle-noise-floor.json.gz",
  "spikes/a/results/attribution-busy-loop.json.gz",
];
const output = new Console(process.stdout, process.stderr);
const tracePaths = process.argv.slice(2).map((path) => resolve(path));

const isApplicationEvent = (event) => {
  const details = JSON.stringify(event.args ?? {});
  return details.includes("/spikes/a/") || details.includes("main.ts");
};

const getFrames = (events) => {
  const pipelineEvents = events.filter(
    (event) => event.name === "PipelineReporter",
  );
  const paired =
    Helpers.Trace.createMatchedSortedSyntheticEvents(pipelineEvents);
  const frames = paired
    .map((frame) => frame.rawSourceEvent)
    .filter(Boolean)
    .sort((left, right) => left.ts - right.ts);
  const state = (frame) =>
    frame.args?.frame_reporter?.state ??
    frame.args?.chrome_frame_reporter?.state;
  const presented = frames.filter(
    (frame) => state(frame) === "STATE_PRESENTED_ALL",
  );
  let intervalsOver12_5Ms = 0;
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index].ts - frames[index - 1].ts > 12_500) {
      intervalsOver12_5Ms += 1;
    }
  }
  return {
    traceEngineFrames: frames.length,
    presented: presented.length,
    partiallyPresented: frames.filter(
      (frame) => state(frame) === "STATE_PRESENTED_PARTIAL",
    ).length,
    dropped: frames.filter((frame) => state(frame) === "STATE_DROPPED").length,
    intervalsOver12_5Ms,
  };
};

const getAttribution = (events) => {
  const tasks = events.filter(
    (event) =>
      ["RunTask", "Task", "FunctionCall", "EvaluateScript"].includes(
        event.name,
      ) && event.dur > 0,
  );
  const application = tasks.filter(isApplicationEvent);
  const applicationSet = new Set(application);
  const hasApplicationChild = (event) =>
    ["RunTask", "Task"].includes(event.name) &&
    application.some(
      (child) =>
        child.pid === event.pid &&
        child.tid === event.tid &&
        child.ts >= event.ts &&
        child.ts + child.dur <= event.ts + event.dur &&
        child !== event,
    );
  const browser = tasks.filter(
    (event) => !applicationSet.has(event) && !hasApplicationChild(event),
  );
  const longest = (items) =>
    items.length ? Math.max(...items.map((event) => event.dur)) / 1000 : null;
  return {
    applicationTasks: application.length,
    browserTasks: browser.length,
    longestApplicationTaskMs: longest(application),
    longestBrowserTaskMs: longest(browser),
    excludedBrowserParents: tasks.filter(
      (event) => !applicationSet.has(event) && hasApplicationChild(event),
    ).length,
  };
};

const analyze = async (path) => {
  const trace = JSON.parse(gunzipSync(await readFile(path), "utf8"));
  const events = trace.traceEvents ?? trace;
  const model = TraceModel.Model.createWithAllHandlers();
  await model.parse(events);
  const parsed = model.parsedTrace();
  return {
    trace: path,
    parsedByTraceEngine: parsed !== null,
    legacyFrames: parsed?.data.Frames.frames.length ?? 0,
    ...getFrames(events),
    ...getAttribution(events),
  };
};

for (const path of tracePaths.length
  ? tracePaths
  : defaultTraces.map((path) => resolve(path))) {
  output.log(`[spike-a] offline analysis ${path}`);
  output.log(JSON.stringify(await analyze(path)));
}
