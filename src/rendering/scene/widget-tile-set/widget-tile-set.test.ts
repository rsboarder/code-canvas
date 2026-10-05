import { describe, expect, it } from "vitest";

import { encodeRasterCells } from "../../text/raster-job";
import { Camera } from "../../../board/index";
import { CONTENT_KIND, WidgetTiles, coarseRasterScale } from "./index";

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
  widget.visibleWindow.right = 512;
  widget.visibleWindow.bottom = 512;
  widget.setContentSource(SOURCE);
  return widget;
}

function prepareWidget(
  widget: WidgetTiles,
  gestureActive: boolean,
  cameraScale: number,
  settledZoom: number,
): void {
  const input = widget.prepareInput;
  input.camera = new Camera({ x: 0, y: 0 }, cameraScale);
  input.viewport.width = 512;
  input.viewport.height = 512;
  input.viewport.devicePixelRatio = 2;
  input.bodyTop = 0;
  input.contentScroll = 0;
  input.minimapActive = false;
  input.textWanted = true;
  input.zoomGestureActive = gestureActive;
  input.textPrefetchActive = false;
  input.textPrefetchZoom = 0;
  input.zoomFocusX = 256;
  input.zoomFocusY = 256;
  input.zoomOut = false;
  input.document = false;
  input.settledZoom = settledZoom;
  widget.prepare(input);
}

describe("WidgetTiles entry point", () => {
  it("uses the camera scale during a gesture and settled zoom otherwise", () => {
    const widget = preparedWidget();

    prepareWidget(widget, false, 1.7, 1.25);
    expect(widget.requestedScale).toBe(2.5);

    prepareWidget(widget, true, 1.7, 1.25);
    expect(widget.requestedScale).toBe(coarseRasterScale(1.7, 2));
  });

  it("accepts a result only while its tile remains requested", () => {
    const widget = preparedWidget();
    prepareWidget(widget, false, 1, 1);
    const stale = widget.ensureRecord(CONTENT_KIND, 1, 0, 0);
    widget.setRequestedContentVersion(stale, SOURCE.contentVersion);

    expect(
      widget.isResultCurrent(stale, {
        rasterScale: 1,
        contentVersion: SOURCE.contentVersion,
      }),
    ).toBe(false);

    const requested = widget.ensureRecord(CONTENT_KIND, 2, 0, 0);
    widget.setRequestedContentVersion(requested, SOURCE.contentVersion);
    expect(
      widget.isResultCurrent(requested, {
        rasterScale: 2,
        contentVersion: SOURCE.contentVersion,
      }),
    ).toBe(true);
  });
});
