import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { classifyTraceFile, formatTraceClassification } from "./classify-file";
import {
  exitCodeFor,
  parseArguments,
  resolveDefaultReportPath,
  type ReportDirectoryFileSystem,
} from "./cli";
import type { TraceEvent, TraceEvents } from "./trace";

const mainThreadMetadata: TraceEvent = {
  name: "thread_name",
  ph: "M",
  ts: 0,
  pid: 1,
  tid: 3,
  args: { name: "CrRendererMain" },
};

const traceEvents: TraceEvents = [
  mainThreadMetadata,
  {
    name: "PipelineReporter",
    cat: "cc",
    ph: "b",
    ts: 0,
    dur: 0,
    pid: 1,
    tid: 2,
    id: "0",
    args: { frame_reporter: { state: "STATE_PRESENTED_ALL" } },
  },
  {
    name: "PipelineReporter",
    cat: "cc",
    ph: "e",
    ts: 1_000,
    dur: 0,
    pid: 1,
    tid: 2,
    id: "0",
    args: { frame_reporter: { state: "STATE_PRESENTED_ALL" } },
  },
  {
    name: "RunTask",
    cat: "toplevel",
    ph: "X",
    ts: 0,
    dur: 1_000,
    pid: 1,
    tid: 3,
    args: { data: { url: "http://localhost/assets/main.js" } },
  },
];

describe("harness CLI", () => {
  it("parses quick scenario runs and stage timing", () => {
    expect(parseArguments(["run", "--quick", "--scenario", "Typing"])).toEqual({
      command: "run",
      quick: true,
      scenario: "Typing",
      stageTiming: false,
      path: undefined,
    });
    expect(parseArguments(["stages"])).toEqual({
      command: "stages",
      quick: false,
      scenario: undefined,
      stageTiming: true,
      path: undefined,
    });
  });

  it("parses a trace classification path", () => {
    expect(parseArguments(["classify", "x.json.gz"])).toEqual({
      command: "classify",
      quick: false,
      scenario: undefined,
      stageTiming: false,
      path: "x.json.gz",
    });
  });

  it.each([
    ["passed", 0],
    ["failed", 1],
    ["invalid", 2],
    ["stage-passed", 3],
  ] as const)("maps %s to exit code %s", (verdict, code) => {
    expect(exitCodeFor(verdict)).toBe(code);
  });
});

describe("classifyTraceFile", () => {
  it("classifies a gzip object trace", async () => {
    const result = await classifyTraceFile("trace.json.gz", () =>
      Promise.resolve(gzipSync(JSON.stringify({ traceEvents }))),
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.traceFrames.total).toBe(1);
  });

  it("classifies a plain bare-array trace", async () => {
    const result = await classifyTraceFile("trace.json", () =>
      Promise.resolve(Buffer.from(JSON.stringify(traceEvents))),
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.traceFrames.total).toBe(1);
  });

  it("returns an invalid result for non-JSON input", async () => {
    const result = await classifyTraceFile("trace.json", () =>
      Promise.resolve(Buffer.from("not JSON")),
    );

    expect(result).toMatchObject({
      valid: false,
      reason: "trace-parse-failed",
    });
    expect(formatTraceClassification(result)).toContain("invalid:");
  });
});

describe("resolveDefaultReportPath", () => {
  it("picks the lexically newest *-full folder's report.json", async () => {
    const fileSystem: ReportDirectoryFileSystem = {
      readdir: () =>
        Promise.resolve([
          "2026-10-01T19-07-53-032Z-stages",
          "2026-10-01T19-46-57-814Z-full",
          "2026-10-01T20-01-39-481Z-full",
          "2026-10-01T19-19-04-692Z-stages",
        ]),
    };

    const path = await resolveDefaultReportPath(fileSystem, "perf/results");

    expect(path).toBe("perf/results/2026-10-01T20-01-39-481Z-full/report.json");
  });

  it("throws an error naming the results folder when no full report exists", async () => {
    const fileSystem: ReportDirectoryFileSystem = {
      readdir: () => Promise.resolve(["2026-10-01T19-07-53-032Z-stages"]),
    };

    await expect(
      resolveDefaultReportPath(fileSystem, "perf/results"),
    ).rejects.toThrow("perf/results");
  });

  it("throws an error naming the results folder when it does not exist", async () => {
    const fileSystem: ReportDirectoryFileSystem = {
      readdir: () => Promise.reject(new Error("ENOENT")),
    };

    await expect(
      resolveDefaultReportPath(fileSystem, "perf/results"),
    ).rejects.toThrow("perf/results");
  });
});
