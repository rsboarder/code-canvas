import { minimumHeight, type BoardMetrics } from "./board-metrics";
import type { BoardFile } from "./board-file";
import type { WidgetPlacement } from "./widget-placement";

export function gridLayout(
  files: readonly BoardFile[],
  metrics: BoardMetrics,
  originX: number,
  originY: number,
): WidgetPlacement[] {
  const sorted = [...files].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  const columns = Math.ceil(Math.sqrt(sorted.length));
  const placements: WidgetPlacement[] = [];
  let rowY = originY;

  for (let rowStart = 0; rowStart < sorted.length; rowStart += columns) {
    const rowEnd = Math.min(sorted.length, rowStart + columns);
    const rowHeight = tallestRow(sorted, rowStart, rowEnd, metrics);
    for (let index = rowStart; index < rowEnd; index += 1) {
      const file = sorted[index];
      if (file === undefined) continue;
      placements.push({
        fileId: file.fileId,
        path: file.path,
        lineCount: file.lineCount,
        x:
          originX +
          (index - rowStart) * (metrics.columnWidth + metrics.gridGap),
        y: rowY,
        width: metrics.columnWidth,
        height: widgetHeight(file.lineCount, metrics),
        contentScroll: 0,
      });
    }
    rowY += rowHeight + metrics.gridGap;
  }

  return placements;
}

function tallestRow(
  files: readonly BoardFile[],
  start: number,
  end: number,
  metrics: BoardMetrics,
): number {
  let tallest = minimumHeight(metrics);
  for (let index = start; index < end; index += 1) {
    const file = files[index];
    if (file !== undefined) {
      tallest = Math.max(tallest, widgetHeight(file.lineCount, metrics));
    }
  }
  return tallest;
}

function widgetHeight(lineCount: number, metrics: BoardMetrics): number {
  const contentHeight =
    metrics.headerHeight + lineCount * metrics.baseLineHeight;
  return Math.min(
    metrics.maximumHeight,
    Math.max(minimumHeight(metrics), contentHeight),
  );
}
