import { FrameStats } from "./frame-stats";

const UPDATE_INTERVAL_MS = 500;
const LABEL_WIDTH = 18;
const VALUE_WIDTH = 12;

type OverlayMode = "hidden" | "compact" | "detailed";

export class MetricsOverlay {
  private readonly element: HTMLDivElement;
  private timer: number | undefined;
  private mode: OverlayMode = "hidden";

  constructor(
    root: HTMLElement,
    private readonly frameStats: FrameStats,
  ) {
    this.element = document.createElement("div");
    this.element.dataset.testid = "metrics-overlay";
    this.element.hidden = true;
    this.element.style.position = "fixed";
    this.element.style.top = "16px";
    this.element.style.right = "16px";
    this.element.style.zIndex = "3";
    this.element.style.padding = "8px 10px";
    this.element.style.background = "rgba(14, 18, 27, 0.9)";
    this.element.style.color = "#d4d4d4";
    this.element.style.fontFamily = "monospace";
    this.element.style.fontSize = "13px";
    this.element.style.lineHeight = "1.35";
    this.element.style.fontVariantNumeric = "tabular-nums";
    this.element.style.whiteSpace = "pre";
    this.element.style.pointerEvents = "none";
    root.append(this.element);
  }

  toggle(): void {
    const nextMode = nextOverlayMode(this.mode);
    if (nextMode === "hidden") {
      this.hide();
      return;
    }
    this.mode = nextMode;
    this.element.hidden = false;
    this.update();
    this.timer ??= window.setInterval(() => {
      this.update();
    }, UPDATE_INTERVAL_MS);
  }

  private hide(): void {
    this.mode = "hidden";
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.element.hidden = true;
  }

  private update(): void {
    if (this.mode === "hidden") return;
    const now = performance.now();
    const metrics = this.frameStats.overlayMetrics(now);
    const lines = compactLines(metrics);
    if (this.mode === "detailed") lines.push(...detailedLines(metrics));
    this.element.textContent = lines.join("\n");
    this.element.dataset.updatedAt = String(now);
  }
}

function nextOverlayMode(mode: OverlayMode): OverlayMode {
  if (mode === "hidden") return "compact";
  if (mode === "compact") return "detailed";
  return "hidden";
}

function compactLines(
  metrics: ReturnType<FrameStats["overlayMetrics"]>,
): string[] {
  return [
    metricLine("FPS", metrics.framesPerSecond),
    metricLine(
      "p50/p99 (ms)",
      `${formatMetric(metrics.p50IntervalMs)}/${formatMetric(metrics.p99IntervalMs)}`,
    ),
    metricLine("dropped", metrics.droppedFrames),
    metricLine("worst tick (ms)", formatMetric(metrics.worstTickMs)),
    metricLine(
      "Visible widgets",
      `${formatMetric(metrics.visibleWidgetCount)}/${formatMetric(metrics.totalWidgetCount)}`,
    ),
    metricLine(
      "Detail Level",
      `${metrics.detailLevel} w=${formatMetric(metrics.textWeight)}`,
    ),
  ];
}

function detailedLines(
  metrics: ReturnType<FrameStats["overlayMetrics"]>,
): string[] {
  const lines: string[] = [metricLine("stages p95/max", "ms")];
  for (const [name, stage] of Object.entries(metrics.stages)) {
    lines.push(
      metricLine(name, `${formatMetric(stage.p95)}/${formatMetric(stage.max)}`),
    );
  }
  lines.push(
    metricLine(
      "Tile pool",
      `${formatMetric(metrics.tilePoolSlotsInUse)}/${formatMetric(metrics.tilePoolCapacity)} ${formatMiB(metrics.tileMemoryBytes)}MiB`,
    ),
    metricLine(
      "raster",
      `${formatMetric(metrics.rasterJobsInFlight)} in ${formatMetric(metrics.rasterJobsPostedPerSecond)}/s`,
    ),
    metricLine(
      "tiles",
      `${formatMetric(metrics.drawnTileCount)}/${formatMetric(metrics.drawnFallbackTileCount)} fb`,
    ),
    metricLine("sharp", `${formatMetric(metrics.timeToSharpMs)}ms`),
    metricLine("tokens", metrics.residencyBacklog),
    metricLine("zoom", metrics.cameraZoom),
  );
  return lines;
}

function metricLine(label: string, value: number | string): string {
  return `${label.padEnd(LABEL_WIDTH)}${String(value).padStart(VALUE_WIDTH)}`;
}

function formatMetric(value: number | "unavailable"): string {
  if (value === "unavailable") return "n/a";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMiB(value: number | "unavailable"): string {
  if (value === "unavailable") return "n/a";
  return (value / (1024 * 1024)).toFixed(2);
}
