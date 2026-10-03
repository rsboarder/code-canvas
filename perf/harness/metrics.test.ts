import { describe, expect, it } from "vitest";

import { bridgeMetricsFromSnapshot, collectBridgeMetrics } from "./metrics";

describe("bridge metrics", () => {
  it("normalizes application metrics from the application snapshot", () => {
    const snapshot = {
      stages: { draw: { p50: 1, p95: 2, p99: 3, max: 4 } },
      residencyBacklogDepth: 5,
      gpuTimeMs: 6,
      tileMemoryBytes: 7,
      missingTileFrameCount: 8,
      timeToSharpMs: 9,
    };

    expect(bridgeMetricsFromSnapshot(snapshot)).toEqual({
      stages: { draw: { p50: 1, p95: 2, p99: 3, max: 4 } },
      residencyBacklog: 5,
      gpuTimeMs: 6,
      tileMemoryBytes: 7,
      missingTileFrameCount: 8,
      timeToSharpMs: 9,
      textSwitchLagMs: "unavailable",
    });
    expect(collectBridgeMetrics({ snapshot: () => snapshot } as never)).toEqual(
      bridgeMetricsFromSnapshot(snapshot),
    );
  });
});
