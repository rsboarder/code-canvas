import { describe, expect, it } from "vitest";

import type { FrameSample } from "../shared/frame";
import { FrameStats } from "./frame-stats";

function sample(
  frameStartTime: number,
  input: number,
  draw: number,
): FrameSample {
  return {
    frameStartTime,
    stageTimings: [
      { name: "input", durationMs: input },
      { name: "draw", durationMs: draw },
    ],
  };
}

describe("FrameStats", () => {
  it("keeps a fixed-size ring of intervals", () => {
    const stats = new FrameStats(3);

    stats.record(sample(0, 1, 2));
    stats.record(sample(10, 2, 3));
    stats.record(sample(22.5, 3, 4));
    stats.record(sample(40, 4, 5));

    expect(stats.snapshot()).toMatchObject({
      p50: 12.5,
      p95: 17.5,
      p99: 17.5,
      max: 17.5,
      longIntervalCount: 1,
      frameCount: 4,
    });
  });

  it("reports nearest-rank statistics for each stage", () => {
    const stats = new FrameStats(10);

    stats.record(sample(0, 1, 4));
    stats.record(sample(8, 3, 6));
    stats.record(sample(16, 5, 8));

    expect(stats.snapshot().stages).toEqual({
      input: { p50: 3, p95: 5, p99: 5, max: 5 },
      draw: { p50: 6, p95: 8, p99: 8, max: 8 },
    });
  });

  it("resets without retaining samples", () => {
    const stats = new FrameStats();
    stats.record(sample(0, 1, 2));
    stats.record(sample(8, 1, 2));

    stats.reset();

    expect(stats.snapshot().frameCount).toBe(0);
    expect(stats.snapshot().p50).toBe("unavailable");
  });
});

describe("FrameStats tile metrics", () => {
  it("reports the latest tile memory and counts missing-tile frames", () => {
    const stats = new FrameStats();
    stats.record({
      ...sample(0, 1, 2),
      tileMemoryBytes: 1024,
      missingTile: true,
    });
    stats.record({
      ...sample(8, 1, 2),
      tileMemoryBytes: 2048,
      missingTile: false,
    });
    stats.record(sample(16, 1, 2));

    const snapshot = stats.snapshot();
    expect(snapshot.tileMemoryBytes).toBe(2048);
    expect(snapshot.missingTileFrameCount).toBe(1);
  });

  it("reports unavailable tile metrics and no missing-tile frames by default", () => {
    const stats = new FrameStats();
    stats.record(sample(0, 1, 2));

    const snapshot = stats.snapshot();
    expect(snapshot.tileMemoryBytes).toBe("unavailable");
    expect(snapshot.missingTileFrameCount).toBe(0);
    expect(snapshot.timeToSharpMs).toBe("unavailable");
  });

  it("reports the latest time to sharp, a one-shot value from a zoom settle", () => {
    const stats = new FrameStats();
    stats.record(sample(0, 1, 2));
    stats.record({ ...sample(8, 1, 2), timeToSharpMs: 42 });
    stats.record(sample(16, 1, 2));

    expect(stats.snapshot().timeToSharpMs).toBe(42);
  });

  it("ignores a NaN time to sharp when no settle completed", () => {
    const stats = new FrameStats();
    stats.record({ ...sample(0, 1, 2), timeToSharpMs: 42 });
    stats.record({ ...sample(8, 1, 2), timeToSharpMs: Number.NaN });

    expect(stats.snapshot().timeToSharpMs).toBe(42);
  });

  it("ignores NaN tile memory when no memory value was reported", () => {
    const stats = new FrameStats();
    stats.record({ ...sample(0, 1, 2), tileMemoryBytes: 1024 });
    stats.record({ ...sample(8, 1, 2), tileMemoryBytes: Number.NaN });

    expect(stats.snapshot().tileMemoryBytes).toBe(1024);
  });

  it("clears tile metrics on reset", () => {
    const stats = new FrameStats();
    stats.record({
      ...sample(0, 1, 2),
      tileMemoryBytes: 1024,
      missingTile: true,
    });

    stats.reset();

    const snapshot = stats.snapshot();
    expect(snapshot.tileMemoryBytes).toBe("unavailable");
    expect(snapshot.missingTileFrameCount).toBe(0);
  });
});

describe("FrameStats residency metrics", () => {
  it("reports the largest residency backlog, unavailable without one, and clears it on reset", () => {
    const stats = new FrameStats();

    expect(stats.snapshot().residencyBacklog).toBe("unavailable");
    stats.record({ ...sample(0, 1, 2), residencyBacklogDepth: Number.NaN });
    stats.record({ ...sample(8, 1, 2), residencyBacklogDepth: 4 });
    stats.record({ ...sample(16, 1, 2), residencyBacklogDepth: 9 });
    stats.record({ ...sample(24, 1, 2), residencyBacklogDepth: 3 });

    expect(stats.snapshot().residencyBacklog).toBe(9);

    stats.reset();

    expect(stats.snapshot().residencyBacklog).toBe("unavailable");
  });
});

describe("FrameStats text switch metrics", () => {
  it("reports lag from the first pending frame to the first text frame", () => {
    const stats = new FrameStats();

    stats.record({
      ...sample(0, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: true,
    });
    stats.record({
      ...sample(24, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: true,
    });
    stats.record({
      ...sample(40, 1, 2),
      detailLevel: "text",
      textSwitchPending: false,
    });

    expect(stats.snapshot().textSwitchLagMs).toBe(40);
  });

  it("keeps the largest lag across pending runs", () => {
    const stats = new FrameStats();

    stats.record({
      ...sample(0, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: true,
    });
    stats.record({
      ...sample(10, 1, 2),
      detailLevel: "text",
      textSwitchPending: false,
    });
    stats.record({
      ...sample(20, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: true,
    });
    stats.record({
      ...sample(60, 1, 2),
      detailLevel: "text",
      textSwitchPending: false,
    });

    expect(stats.snapshot().textSwitchLagMs).toBe(40);
  });

  it("does not record a pending run that returns to minimap", () => {
    const stats = new FrameStats();

    stats.record({
      ...sample(0, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: true,
    });
    stats.record({
      ...sample(20, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: false,
    });

    expect(stats.snapshot().textSwitchLagMs).toBe("unavailable");
  });
});

describe("FrameStats text switch reset", () => {
  it("clears text switch metrics on reset", () => {
    const stats = new FrameStats();

    stats.record({
      ...sample(0, 1, 2),
      detailLevel: "minimap",
      textSwitchPending: true,
    });
    stats.record({
      ...sample(20, 1, 2),
      detailLevel: "text",
      textSwitchPending: false,
    });
    stats.reset();

    expect(stats.snapshot().textSwitchLagMs).toBe("unavailable");
  });

  it("reports unavailable without a completed text switch", () => {
    const stats = new FrameStats();

    stats.record(sample(0, 1, 2));

    expect(stats.snapshot().textSwitchLagMs).toBe("unavailable");
  });
});

describe("FrameStats direct text switch metrics", () => {
  it("reports zero lag for a direct minimap to text switch", () => {
    const stats = new FrameStats();

    stats.record({ ...sample(0, 1, 2), detailLevel: "minimap" });
    stats.record({ ...sample(8, 1, 2), detailLevel: "text" });

    expect(stats.snapshot().textSwitchLagMs).toBe(0);
  });

  it("does not record a text sample after text", () => {
    const stats = new FrameStats();

    stats.record({ ...sample(0, 1, 2), detailLevel: "minimap" });
    stats.record({ ...sample(8, 1, 2), detailLevel: "text" });
    stats.record({ ...sample(16, 1, 2), detailLevel: "text" });

    expect(stats.snapshot().textSwitchLagMs).toBe(0);
  });
});

describe("FrameStats overlay metrics", () => {
  it("does not include an idle gap in the p99 interval", () => {
    const stats = new FrameStats();

    stats.record(sample(0, 1, 2));
    stats.record(sample(16, 1, 2));
    stats.record({ ...sample(2000, 1, 2), afterIdle: true });
    stats.record(sample(2016, 1, 2));

    expect(stats.overlayMetrics(2016)).toMatchObject({
      p99IntervalMs: 16,
    });
  });

  it("counts recent samples and reports the latest view state", () => {
    const stats = new FrameStats();

    stats.record({
      ...sample(0, 1, 2),
      detailLevel: "minimap",
      visibleWidgetCount: 1,
    });
    stats.record({
      ...sample(400, 1, 2),
      detailLevel: "text",
      visibleWidgetCount: 2,
    });
    stats.record({
      ...sample(1100, 1, 2),
      detailLevel: "minimap",
      visibleWidgetCount: 3,
    });
    stats.record({
      ...sample(1500, 1, 2),
      detailLevel: "text",
      visibleWidgetCount: 4,
    });

    expect(stats.overlayMetrics(1600)).toEqual({
      framesPerSecond: 2,
      p99IntervalMs: 700,
      visibleWidgetCount: 4,
      detailLevel: "text",
    });
  });
});
