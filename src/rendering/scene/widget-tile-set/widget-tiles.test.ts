import { describe, expect, it } from "vitest";

import { encodeRasterCells } from "../../text/raster-job";
import { Camera } from "../../../board/index";
import { CONTENT_KIND, WidgetTiles } from "./index";

class FakePool {
  readonly released: string[] = [];

  release(key: string): void {
    this.released.push(key);
  }

  isPinned(): boolean {
    return false;
  }
}

const SOURCE = {
  fileId: "file-a",
  filePath: "src/a.ts",
  hasText: true,
  contentVersion: 1,
  highlighted: false,
  contentWidth: 1024,
  contentHeight: 1024,
  palette: ["#fff"],
  baseline: 14,
  lineHeight: 18,
  backgroundColor: "#000",
  headerBackgroundColor: "#111",
  cellsFor: () => encodeRasterCells([]),
  headerCellsFor: () => encodeRasterCells([]),
};

function preparedWidget(): WidgetTiles {
  const widget = new WidgetTiles("file-a", new FakePool(), 32);
  widget.frame.width = 512;
  widget.frame.height = 512;
  widget.setContentSource(SOURCE);
  return widget;
}

function prepareWidget(
  widget: WidgetTiles,
  contentScroll: number,
  visibleBottom = 512,
  zoomGestureActive = false,
): void {
  widget.visibleWindow.left = 0;
  widget.visibleWindow.top = contentScroll;
  widget.visibleWindow.right = 512;
  widget.visibleWindow.bottom = contentScroll + visibleBottom;
  const input = widget.prepareInput;
  input.camera = new Camera({ x: 0, y: 0 }, 1);
  input.viewport.width = 512;
  input.viewport.height = visibleBottom;
  input.viewport.devicePixelRatio = 1;
  input.bodyTop = 0;
  input.contentScroll = contentScroll;
  input.minimapActive = false;
  input.textWanted = true;
  input.zoomGestureActive = zoomGestureActive;
  input.textPrefetchActive = false;
  input.textPrefetchZoom = 0;
  input.zoomFocusX = 0;
  input.zoomFocusY = 0;
  input.zoomOut = false;
  input.document = false;
  input.settledZoom = 1;
  widget.prepare(input);
}

function readyTile(
  widget: WidgetTiles,
  rasterScale: number,
  column: number,
  row: number,
): void {
  const record = widget.ensureRecord(CONTENT_KIND, rasterScale, column, row);
  widget.setRecordReady(record, true);
}

describe("WidgetTiles readiness", () => {
  it("accepts lower-scale current tiles that cover the visible window", () => {
    const widget = preparedWidget();
    prepareWidget(widget, 0, 512, true);
    readyTile(widget, 0.5, 0, 0);
    prepareWidget(widget, 0, 512, true);

    expect(widget.exitViewCovered(SOURCE.contentVersion, 0)).toBe(true);
  });

  it("rejects a visible gap in the current tile coverage", () => {
    const widget = preparedWidget();
    prepareWidget(widget, 0, 1024);
    readyTile(widget, 1, 0, 0);
    prepareWidget(widget, 0, 1024);

    expect(widget.exitViewCovered(SOURCE.contentVersion, 0)).toBe(false);
  });

  it("rejects a plan made for a different Content Scroll", () => {
    const widget = preparedWidget();
    prepareWidget(widget, 0);
    readyTile(widget, 0.5, 0, 0);
    prepareWidget(widget, 200);

    expect(widget.exitViewCovered(SOURCE.contentVersion, 0)).toBe(false);
  });

  it("rejects tiles from an older content version", () => {
    const widget = preparedWidget();
    prepareWidget(widget, 0);
    readyTile(widget, 0.5, 0, 0);
    prepareWidget(widget, 0);
    widget.setContentSource({ ...SOURCE, contentVersion: 2 });
    prepareWidget(widget, 0);

    expect(widget.exitViewCovered(2, 0)).toBe(false);
  });
});
