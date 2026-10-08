import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import {
  classifyTrace,
  type InvalidMeasurement,
  type TraceClassification,
  type TraceEvent,
  type TraceMetrics,
} from "./trace";
import { isRecord } from "./is-record";

type TraceFileReader = (path: string) => Promise<Uint8Array>;

export async function classifyTraceFile(
  path: string,
  readFile: TraceFileReader,
): Promise<TraceClassification> {
  let events: readonly TraceEvent[];
  try {
    const contents = await readFile(path);
    const decoded = path.endsWith(".gz")
      ? gunzipSync(contents)
      : Buffer.from(contents);
    events = parseEvents(decoded.toString("utf8"));
  } catch (error: unknown) {
    return invalidTraceFile(error);
  }

  try {
    return await classifyTrace(events, {
      applicationMarkers: ["127.0.0.1", "localhost"],
    });
  } catch (error: unknown) {
    return invalidTraceFile(error);
  }
}

export function formatTraceClassification(result: TraceClassification): string {
  if (!result.valid) {
    return `invalid: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`;
  }
  return formatMetrics(result);
}

function parseEvents(text: string): readonly TraceEvent[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as readonly TraceEvent[];
  if (isRecord(parsed) && Array.isArray(parsed.traceEvents)) {
    return parsed.traceEvents as readonly TraceEvent[];
  }
  throw new Error("trace JSON must be an event array or contain traceEvents");
}

function formatMetrics(metrics: TraceMetrics): string {
  return [
    ...formatFrameCounts("whole trace", metrics.traceFrames),
    ...formatFrameCounts("interaction window", metrics.frames),
    `interval p50: ${formatStatistic(metrics.intervalsMs.p50)} ms`,
    `interval p95: ${formatStatistic(metrics.intervalsMs.p95)} ms`,
    `interval p99: ${formatStatistic(metrics.intervalsMs.p99)} ms`,
    `interval max: ${formatStatistic(metrics.intervalsMs.max)} ms`,
    `intervals > 12.5 ms: ${formatStatistic(metrics.intervalsOver12_5Ms)}`,
    `longest application task: ${formatStatistic(metrics.longestApplicationTaskMs)} ms`,
    `longest browser task: ${formatStatistic(metrics.longestBrowserTaskMs)} ms`,
    `GC count: ${String(metrics.gc.count)}`,
    `GC total: ${String(metrics.gc.totalDurationMs)} ms`,
  ].join("\n");
}

function formatFrameCounts(
  scope: string,
  counts: TraceMetrics["frames"],
): string[] {
  return [
    `${scope} frames total: ${String(counts.total)}`,
    `${scope} frames presented: ${String(counts.presented)}`,
    `${scope} frames partially presented: ${String(counts.partiallyPresented)}`,
    `${scope} frames dropped: ${String(counts.dropped)}`,
    `${scope} frames idle: ${String(counts.idle)}`,
  ];
}

function formatStatistic(value: number | "unavailable"): string {
  return typeof value === "number" ? String(value) : value;
}

function invalidTraceFile(error: unknown): InvalidMeasurement {
  return {
    valid: false,
    reason: "trace-parse-failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}
