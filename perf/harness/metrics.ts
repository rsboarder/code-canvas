import {
  UNAVAILABLE,
  type PerfBridge,
  type Statistic,
} from "../../src/performance/bridge";

export interface BridgeStageMetrics {
  readonly p50: Statistic;
  readonly p95: Statistic;
  readonly p99: Statistic;
  readonly max: Statistic;
}

export interface BridgeMetrics {
  readonly stages: Readonly<Record<string, BridgeStageMetrics>>;
  readonly residencyBacklog: Statistic;
  readonly gpuTimeMs: Statistic;
}

export function collectBridgeMetrics(bridge: PerfBridge): BridgeMetrics {
  return bridgeMetricsFromSnapshot(bridge.snapshot());
}

export function bridgeMetricsFromSnapshot(snapshot: unknown): BridgeMetrics {
  if (!isRecord(snapshot)) return unavailableMetrics();
  return {
    stages: readStages(snapshot.stages),
    residencyBacklog: readStatistic(
      snapshot.residencyBacklog ?? snapshot.residencyBacklogDepth,
    ),
    gpuTimeMs: readStatistic(snapshot.gpuTimeMs ?? snapshot.gpuTime),
  };
}

function readStages(
  value: unknown,
): Readonly<Record<string, BridgeStageMetrics>> {
  if (!isRecord(value)) return {};
  const stages: Record<string, BridgeStageMetrics> = {};
  for (const [name, stage] of Object.entries(value)) {
    if (!isRecord(stage)) continue;
    stages[name] = {
      p50: readStatistic(stage.p50),
      p95: readStatistic(stage.p95),
      p99: readStatistic(stage.p99),
      max: readStatistic(stage.max),
    };
  }
  return stages;
}

function readStatistic(value: unknown): Statistic {
  if (value === UNAVAILABLE) return UNAVAILABLE;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : UNAVAILABLE;
}

function unavailableMetrics(): BridgeMetrics {
  return {
    stages: {},
    residencyBacklog: UNAVAILABLE,
    gpuTimeMs: UNAVAILABLE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
