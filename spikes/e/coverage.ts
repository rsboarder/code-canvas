export interface CoverageRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface CoverageWidget {
  readonly index: number;
  readonly body: CoverageRect;
  readonly lineHeight: number;
  readonly lineCount: number;
}

export interface WidgetCoverage {
  readonly index: number;
  readonly visibleFraction: number;
  readonly lineBandCoverage: number;
  readonly wideLineCoverage: number;
}

export interface WidgetCoverageSummary {
  readonly widgets: number;
  readonly qualifyingWidgets: number;
  readonly lineBandCoverage: number;
  readonly wideLineCoverage: number;
  readonly perWidget: readonly WidgetCoverage[];
}

interface Interval {
  readonly left: number;
  readonly right: number;
}

const MIN_VISIBLE_FRACTION = 0.25;
const MIN_LINE_BAND_COVERAGE = 0.6;
const MIN_WIDE_LINE_COVERAGE = 0.5;

function subtractIntervals(
  source: Interval,
  blockers: readonly Interval[],
): Interval[] {
  let remaining = [source];
  for (const blocker of blockers) {
    const next: Interval[] = [];
    for (const interval of remaining) {
      if (blocker.right <= interval.left || blocker.left >= interval.right) {
        next.push(interval);
        continue;
      }
      if (blocker.left > interval.left)
        next.push({ left: interval.left, right: blocker.left });
      if (blocker.right < interval.right)
        next.push({ left: blocker.right, right: interval.right });
    }
    remaining = next;
  }
  return remaining.filter((interval) => interval.right > interval.left);
}

function visibleIntervalsAt(
  widget: CoverageWidget,
  widgets: readonly CoverageWidget[],
  viewport: CoverageRect,
  y: number,
): Interval[] {
  if (
    y < widget.body.top ||
    y >= widget.body.bottom ||
    y < viewport.top ||
    y >= viewport.bottom
  )
    return [];
  const left = Math.max(widget.body.left, viewport.left);
  const right = Math.min(widget.body.right, viewport.right);
  if (right <= left) return [];
  const blockers = widgets
    .filter(
      (candidate) =>
        candidate.index < widget.index &&
        y >= candidate.body.top &&
        y < candidate.body.bottom,
    )
    .map((candidate) => ({
      left: Math.max(left, candidate.body.left),
      right: Math.min(right, candidate.body.right),
    }))
    .filter((blocker) => blocker.right > blocker.left);
  return subtractIntervals({ left, right }, blockers);
}

function visibleArea(
  widget: CoverageWidget,
  widgets: readonly CoverageWidget[],
  viewport: CoverageRect,
): number {
  const boundaries = [
    widget.body.top,
    widget.body.bottom,
    viewport.top,
    viewport.bottom,
  ];
  for (const candidate of widgets) {
    if (candidate.index >= widget.index) continue;
    boundaries.push(candidate.body.top, candidate.body.bottom);
  }
  const sorted = [...new Set(boundaries)].sort((left, right) => left - right);
  let area = 0;
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const top = sorted[index] ?? 0;
    const bottom = sorted[index + 1] ?? top;
    const intervals = visibleIntervalsAt(
      widget,
      widgets,
      viewport,
      (top + bottom) / 2,
    );
    for (const interval of intervals)
      area += (interval.right - interval.left) * (bottom - top);
  }
  return area;
}

function lineCoverage(
  widget: CoverageWidget,
  widgets: readonly CoverageWidget[],
  viewport: CoverageRect,
  foregroundAt: (x: number, y: number) => boolean,
): { readonly lineBandCoverage: number; readonly wideLineCoverage: number } {
  let visibleBands = 0;
  let bandsWithForeground = 0;
  let wideBands = 0;
  for (let line = 0; line < widget.lineCount; line += 1) {
    const top = widget.body.top + line * widget.lineHeight;
    const bottom = Math.min(widget.body.bottom, top + widget.lineHeight);
    const y = (top + bottom) / 2;
    const intervals = visibleIntervalsAt(widget, widgets, viewport, y);
    if (intervals.length === 0) continue;
    visibleBands += 1;
    let bandHasForeground = false;
    let bandIsWide = false;
    for (const interval of intervals) {
      let first = interval.right;
      let last = interval.left;
      const step = Math.max(2, (interval.right - interval.left) / 80);
      for (let x = interval.left; x <= interval.right; x += step) {
        if (!foregroundAt(x, y)) continue;
        bandHasForeground = true;
        first = Math.min(first, x);
        last = Math.max(last, x);
      }
      if (last - first >= (interval.right - interval.left) * 0.5)
        bandIsWide = true;
    }
    if (bandHasForeground) bandsWithForeground += 1;
    if (bandIsWide) wideBands += 1;
  }
  return {
    lineBandCoverage: visibleBands ? bandsWithForeground / visibleBands : 0,
    wideLineCoverage: visibleBands ? wideBands / visibleBands : 0,
  };
}

export function measureWidgetCoverage(
  widget: CoverageWidget,
  widgets: readonly CoverageWidget[],
  viewport: CoverageRect,
  foregroundAt: (x: number, y: number) => boolean,
): WidgetCoverage {
  const fullArea =
    (widget.body.right - widget.body.left) *
    (widget.body.bottom - widget.body.top);
  const lines = lineCoverage(widget, widgets, viewport, foregroundAt);
  return {
    index: widget.index,
    visibleFraction: fullArea
      ? visibleArea(widget, widgets, viewport) / fullArea
      : 0,
    ...lines,
  };
}

export function summarizeWidgetCoverage(
  perWidget: readonly WidgetCoverage[],
): WidgetCoverageSummary {
  const eligible = perWidget.filter(
    (coverage) => coverage.visibleFraction >= MIN_VISIBLE_FRACTION,
  );
  const qualifying = eligible.filter(
    (coverage) =>
      coverage.lineBandCoverage >= MIN_LINE_BAND_COVERAGE &&
      coverage.wideLineCoverage >= MIN_WIDE_LINE_COVERAGE,
  );
  return {
    widgets: eligible.length,
    qualifyingWidgets: qualifying.length,
    lineBandCoverage: average(
      eligible.map((coverage) => coverage.lineBandCoverage),
    ),
    wideLineCoverage: average(
      eligible.map((coverage) => coverage.wideLineCoverage),
    ),
    perWidget,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function textCoverageGuardFails(
  coverage: WidgetCoverageSummary,
): boolean {
  return (
    coverage.widgets === 0 ||
    coverage.qualifyingWidgets < coverage.widgets ||
    coverage.lineBandCoverage < MIN_LINE_BAND_COVERAGE ||
    coverage.wideLineCoverage < MIN_WIDE_LINE_COVERAGE
  );
}
