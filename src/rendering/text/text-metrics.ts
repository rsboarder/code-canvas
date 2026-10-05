import type { LineMetrics } from "../../code-view/index";
import { LineNumberGutter } from "../../code-view/index";
import type { FontDefinition } from "../../shared/font";

export interface CodeTextMetrics extends LineMetrics {
  readonly lineNumberGutter: LineNumberGutter;
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
const DIGITS = "0123456789";

// The character Text Metrics measures its narrow advance from (D6 "Text
// Metrics"); each raster worker measures the same character with the same
// font at start-up and compares against this module's narrowAdvance, so a
// font substitution the worker's engine made silently is caught instead of
// drawing with a fallback font (D6 "Raster workers").
export const PROBE_CHARACTER = "0";

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
  probe.textContent = PROBE_CHARACTER.repeat(NARROW_PROBE_LENGTH);
  documentRef.body.append(probe);
  const narrowAdvance = roundMetric(
    probe.getBoundingClientRect().width / NARROW_PROBE_LENGTH,
  );
  probe.remove();

  configureCanvasFont(context, font);
  const bounds = context.measureText(PROBE_CHARACTER);
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
  const widestDigitAdvance = Math.max(
    ...Array.from(DIGITS, (digit) => advanceFor(digit)),
  );
  return {
    narrowAdvance,
    lineNumberGutter: new LineNumberGutter(widestDigitAdvance),
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

// Satisfied by both CanvasRenderingContext2D and
// OffscreenCanvasRenderingContext2D, so the raster worker (D6 "Raster
// workers") configures its font identically to this module's own
// measurement context for the start-up font check.
interface FontConfigurableContext {
  font: string;
}

export function configureCanvasFont(
  context: FontConfigurableContext,
  font: FontDefinition,
): void {
  context.font = `${String(font.size)}px ${font.family}`;
  const configurable = context as FontConfigurableContext & {
    fontKerning?: CanvasFontKerning;
    letterSpacing?: string;
  };
  configurable.fontKerning = "normal";
  configurable.letterSpacing = `${String(font.letterSpacing)}px`;
}
