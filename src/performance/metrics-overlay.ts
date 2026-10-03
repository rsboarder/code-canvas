import { FrameStats } from "./frame-stats";

const UPDATE_INTERVAL_MS = 500;

export class MetricsOverlay {
  private readonly element: HTMLDivElement;
  private timer: number | undefined;
  private visible = false;

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
    this.element.style.whiteSpace = "pre";
    this.element.style.pointerEvents = "none";
    root.append(this.element);
  }

  toggle(): void {
    if (this.visible) {
      this.hide();
      return;
    }
    this.visible = true;
    this.element.hidden = false;
    this.update();
    this.timer = window.setInterval(() => {
      this.update();
    }, UPDATE_INTERVAL_MS);
  }

  private hide(): void {
    this.visible = false;
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.element.hidden = true;
  }

  private update(): void {
    if (!this.visible) return;
    const now = performance.now();
    const metrics = this.frameStats.overlayMetrics(now);
    this.element.textContent = [
      `FPS: ${String(metrics.framesPerSecond)}`,
      `p99 interval: ${formatMetric(metrics.p99IntervalMs)} ms`,
      `Visible widgets: ${formatMetric(metrics.visibleWidgetCount)}`,
      `Detail Level: ${metrics.detailLevel}`,
    ].join("\n");
    this.element.dataset.updatedAt = String(now);
  }
}

function formatMetric(value: number | "unavailable"): string {
  return value === "unavailable" ? value : String(value);
}
