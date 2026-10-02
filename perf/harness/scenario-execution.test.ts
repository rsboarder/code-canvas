import { describe, expect, it } from "vitest";

import type { BridgeMetrics } from "./metrics";
import {
  scenarioRunMetricsFromTrace,
  scenarioRunMetricsWithBridge,
} from "./scenario-execution";
import type { TraceMetrics } from "./trace";

describe("scenario execution metrics", () => {
  const bridge = {
    stages: {},
    residencyBacklog: "unavailable",
    gpuTimeMs: "unavailable",
    tileMemoryBytes: 3 * 1024 * 1024,
    missingTileFrameCount: 4,
    timeToSharpMs: 5,
  } satisfies BridgeMetrics;

  it("carries tile values from the run bridge snapshot", () => {
    const metrics = scenarioRunMetricsWithBridge(
      {
        applicationTaskMs: 1,
        p99: 2,
        droppedFrames: 0,
        partiallyPresentedFrames: 0,
        longIntervals: 0,
      },
      bridge,
    );

    expect(metrics).toMatchObject({
      tileMemoryBytes: 3 * 1024 * 1024,
      missingTileFrameCount: 4,
      timeToSharpMs: 5,
    });
  });

  it("carries trace and window frame counts only for full-mode metrics", () => {
    const classified = {
      valid: true,
      frameSource: "PipelineReporter",
      frames: {
        total: 3,
        presented: 1,
        partiallyPresented: 1,
        dropped: 1,
        idle: 0,
      },
      traceFrames: {
        total: 5,
        presented: 2,
        partiallyPresented: 1,
        dropped: 1,
        idle: 1,
      },
      intervalsMs: { p50: 8, p95: 8, p99: 8, max: 8 },
      intervalsOver12_5Ms: 0,
      mainThreadTasks: 1,
      applicationTaskCount: 1,
      browserTaskCount: 0,
      longestApplicationTaskMs: 1,
      longestBrowserTaskMs: "unavailable",
      maxMainThreadTaskMs: 1,
      tasksOver8_33Ms: 0,
      gc: { count: 0, totalDurationMs: 0, maxPauseMs: 0 },
      stages: {},
      residencyBacklog: "unavailable",
      gpuTimeMs: "unavailable",
    } satisfies TraceMetrics;

    expect(scenarioRunMetricsFromTrace(classified, bridge).frames).toEqual({
      trace: classified.traceFrames,
      window: classified.frames,
    });
    expect(scenarioRunMetricsFromTrace(classified, bridge, false).frames).toBe(
      undefined,
    );
  });
});
