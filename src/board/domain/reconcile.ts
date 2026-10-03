import type { SourceFileId } from "../../shared/domain";

import { type BoardFile } from "./board-file";
import { type BoardMetrics } from "./board-metrics";
import { gridLayout } from "./grid-layout";
import { type SavedCamera, type SavedLayout } from "./saved-layout";
import { Widget } from "./widget";
import type { WidgetPlacement } from "./widget-placement";

export interface ReconciledLayout {
  readonly camera: SavedCamera | undefined;
  readonly widgets: readonly WidgetPlacement[];
}

export function reconcile(
  saved: SavedLayout | undefined,
  discovered: readonly BoardFile[],
  metrics: BoardMetrics,
): ReconciledLayout {
  const discoveredById = indexDiscovered(discovered);
  if (saved === undefined) {
    return {
      camera: undefined,
      widgets: gridLayout(discovered, metrics, 0, 0),
    };
  }

  const kept: WidgetPlacement[] = [];
  const savedIds = new Set<SourceFileId>();
  for (const savedWidget of saved.widgets) {
    if (savedIds.has(savedWidget.fileId)) {
      throw new RangeError("Saved layout cannot contain duplicate ids.");
    }
    savedIds.add(savedWidget.fileId);
    const file = discoveredById.get(savedWidget.fileId);
    if (file === undefined) continue;
    kept.push(savedPlacement(savedWidget, file, metrics));
  }

  const newFiles = discovered.filter((file) => !savedIds.has(file.fileId));
  const origin = placementOrigin(kept, metrics.gridGap);
  return {
    camera: saved.camera,
    widgets: kept.concat(gridLayout(newFiles, metrics, origin.x, origin.y)),
  };
}

function indexDiscovered(
  files: readonly BoardFile[],
): Map<SourceFileId, BoardFile> {
  const indexed = new Map<SourceFileId, BoardFile>();
  for (const file of files) {
    if (indexed.has(file.fileId)) {
      throw new RangeError("Discovered files cannot contain duplicate ids.");
    }
    indexed.set(file.fileId, file);
  }
  return indexed;
}

function savedPlacement(
  saved: SavedLayout["widgets"][number],
  file: BoardFile,
  metrics: BoardMetrics,
): WidgetPlacement {
  const widget = new Widget(file.fileId, file.path, file.lineCount, {
    frame: {
      x: saved.x,
      y: saved.y,
      width: saved.width,
      height: saved.height,
    },
    metrics,
  });
  widget.scrollTo(saved.contentScroll);
  return {
    fileId: widget.id,
    path: widget.path,
    lineCount: widget.lineCount,
    x: widget.x,
    y: widget.y,
    width: widget.width,
    height: widget.height,
    contentScroll: widget.contentScroll,
  };
}

function placementOrigin(
  placements: readonly WidgetPlacement[],
  gap: number,
): { x: number; y: number } {
  if (placements.length === 0) return { x: 0, y: 0 };
  let right = -Infinity;
  let top = Infinity;
  for (const placement of placements) {
    right = Math.max(right, placement.x + placement.width);
    top = Math.min(top, placement.y);
  }
  return { x: right + gap, y: top };
}
