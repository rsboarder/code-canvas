import type { FontDefinition } from "../../shared/font";

export interface CodeTextMetrics {
  readonly narrowAdvance: number;
  readonly tabSize: number;
  readonly baseline: number;
  readonly lineHeight: number;
  readonly advanceFor: (cluster: string) => number;
}

export interface TextMetricsProbeLine {
  readonly cluster: string;
  readonly x: number;
}

export interface TextMetricsProbe {
  readonly baseline: number;
  readonly lines: readonly (readonly TextMetricsProbeLine[])[];
}

const METRIC_PRECISION = 1000;
const NARROW_PROBE_LENGTH = 256;

export function roundMetric(value: number): number {
  return Math.round(value * METRIC_PRECISION) / METRIC_PRECISION;
}

export function isWhitespaceCluster(cluster: string): boolean {
  return /^\s+$/u.test(cluster);
}

export function calculateBaseline(
  lineHeight: number,
  fontBoundingBoxAscent: number,
  fontBoundingBoxDescent: number,
): number {
  return (
    Math.floor(
      (lineHeight - (fontBoundingBoxAscent + fontBoundingBoxDescent)) / 2,
    ) + fontBoundingBoxAscent
  );
}

export function createAdvanceCache(
  measure: (cluster: string) => number,
): (cluster: string) => number {
  const cache = new Map<string, number>();
  return (cluster) => {
    const cached = cache.get(cluster);
    if (cached !== undefined) return cached;
    const measured = roundMetric(measure(cluster));
    cache.set(cluster, measured);
    return measured;
  };
}

export function createTextMetrics(
  font: FontDefinition,
  documentRef: Document = document,
): CodeTextMetrics {
  const context = documentRef.createElement("canvas").getContext("2d");
  if (!context) throw new Error("TextMetrics: 2D context unavailable");
  const style = configureFontStyle(font);
  const probe = documentRef.createElement("span");
  Object.assign(probe.style, style);
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.textContent = "0".repeat(NARROW_PROBE_LENGTH);
  documentRef.body.append(probe);
  const narrowAdvance = roundMetric(
    probe.getBoundingClientRect().width / NARROW_PROBE_LENGTH,
  );
  probe.remove();

  configureCanvasFont(context, font);
  const bounds = context.measureText("0");
  const baseline = roundMetric(
    calculateBaseline(
      font.lineHeight,
      bounds.fontBoundingBoxAscent,
      bounds.fontBoundingBoxDescent,
    ),
  );
  const advanceFor = createAdvanceCache(
    (cluster) => context.measureText(cluster).width,
  );
  return {
    narrowAdvance,
    tabSize: font.tabSize,
    baseline,
    lineHeight: font.lineHeight,
    advanceFor,
  };
}

function configureFontStyle(font: FontDefinition): Record<string, string> {
  return {
    fontFamily: font.family,
    fontSize: `${String(font.size)}px`,
    lineHeight: `${String(font.lineHeight)}px`,
    fontFeatureSettings: font.fontFeatureSettings,
    letterSpacing: `${String(font.letterSpacing)}px`,
  };
}

function configureCanvasFont(
  context: CanvasRenderingContext2D,
  font: FontDefinition,
): void {
  context.font = `${String(font.size)}px ${font.family}`;
  const configurable = context as CanvasRenderingContext2D & {
    fontKerning?: CanvasFontKerning;
    letterSpacing?: string;
  };
  configurable.fontKerning = "normal";
  configurable.letterSpacing = `${String(font.letterSpacing)}px`;
}
