import { describe, expect, it } from "vitest";

import { Board } from "../board/domain/board";
import type { BoardMetrics } from "../board/domain/board-metrics";
import { createHitTestResult } from "../board/domain/hit-test";
import { reconcile, type ReconciledLayout } from "../board/domain/reconcile";
import type { SavedLayout } from "../board/domain/saved-layout";
import { sourceFileId } from "../shared/domain";

const metrics: BoardMetrics = {
  baseLineHeight: 20,
  headerHeight: 42,
  minimumWidth: 240,
  minimumBodyLines: 3,
  columnWidth: 760,
  gridGap: 40,
  maximumHeight: 900,
  edgeGrabScreenPx: 8,
};

function file(path: string, lineCount: number) {
  return { fileId: sourceFileId(path), path, lineCount };
}

function placement(
  path: string,
  frame: { x: number; y: number; width: number; height: number },
  lineCount = 100,
  contentScroll = 0,
) {
  return {
    fileId: sourceFileId(path),
    path,
    lineCount,
    ...frame,
    contentScroll,
  };
}

function layout(
  widgets: ReconciledLayout["widgets"],
  camera?: ReconciledLayout["camera"],
): ReconciledLayout {
  return { camera, widgets };
}

function boardWithOneWidget(scale = 1): Board {
  return Board.fromLayout(
    metrics,
    layout(
      [placement("file.ts", { x: 100, y: 100, width: 300, height: 300 })],
      {
        x: 0,
        y: 0,
        scale,
      },
    ),
  );
}

describe("Board camera and detail level", () => {
  it("Pinch-zoom toward a point", () => {
    const board = boardWithOneWidget();
    board.setCamera(31, -17, 0.8);
    const before = { x: 0, y: 0 };
    board.camera.toBoard({ x: 240, y: 180 }, before);

    board.zoomCameraAt(240, 180, 1.7);

    const after = { x: 0, y: 0 };
    board.camera.toBoard({ x: 240, y: 180 }, after);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("Zoom bounds", () => {
    const board = boardWithOneWidget();
    board.setCamera(31, -17, 1);
    for (let index = 0; index < 100; index += 1) {
      board.zoomCameraAt(240, 180, 0.5);
    }
    const before = { x: board.camera.offsetX, y: board.camera.offsetY };

    expect(board.camera.scale).toBe(0.05);
    board.zoomCameraAt(240, 180, 0.5);
    board.zoomCameraAt(240, 180, 0.5);
    expect(board.camera.scale).toBe(0.05);
    expect(board.camera.offsetX).toBe(before.x);
    expect(board.camera.offsetY).toBe(before.y);
  });

  it("Zooming out to the minimap", () => {
    const board = boardWithOneWidget(1);
    const before = board.widget(sourceFileId("file.ts"));
    if (before === undefined) throw new Error("Expected test widget.");
    const frame = {
      x: before.x,
      y: before.y,
      width: before.width,
      height: before.height,
    };
    board.updateDetailLevel(2, true);
    board.setCamera(0, 0, 0.2);

    expect(board.updateDetailLevel(2, true)).toBe("minimap");
    expect(board.widget(sourceFileId("file.ts"))).toMatchObject(frame);
  });

  it("Oscillation near the threshold", () => {
    const fromText = boardWithOneWidget();
    expect(fromText.updateDetailLevel(1, true)).toBe("text");
    for (const lineHeight of [9.1, 10.9, 9.5, 10.5]) {
      fromText.setCamera(0, 0, lineHeight / 20);
      expect(fromText.updateDetailLevel(1, true)).toBe("text");
    }

    const fromMinimap = boardWithOneWidget();
    fromMinimap.setCamera(0, 0, 8.9 / 20);
    expect(fromMinimap.updateDetailLevel(1, true)).toBe("minimap");
    for (const lineHeight of [9.1, 10.9, 9.5, 10.5]) {
      fromMinimap.setCamera(0, 0, lineHeight / 20);
      expect(fromMinimap.updateDetailLevel(1, true)).toBe("minimap");
    }
  });

  it("Transition without flicker", () => {
    const board = boardWithOneWidget(8 / 20);
    expect(board.updateDetailLevel(1, true)).toBe("minimap");
    board.setCamera(0, 0, 12 / 20);

    expect(board.updateDetailLevel(1, false)).toBe("minimap");
    expect(board.textWanted(1)).toBe(true);
    expect(board.updateDetailLevel(1, true)).toBe("text");
    expect(board.textWanted(1)).toBe(false);
  });
});

describe("Board widget camera jumps", () => {
  it("zooms to a fitting widget at 100% and centers it", () => {
    const board = boardWithOneWidget(0.2);
    const widgetId = sourceFileId("file.ts");

    expect(board.zoomToWidget(widgetId, 800, 600)).toBe(true);

    const widget = board.widget(widgetId);
    if (widget === undefined) throw new Error("Expected test widget.");
    const screen = { x: 0, y: 0 };
    board.camera.toScreen(
      { x: widget.x + widget.width / 2, y: widget.y + widget.height / 2 },
      screen,
    );
    expect(board.camera.scale).toBe(1);
    expect(screen.x).toBe(400);
    expect(screen.y).toBe(300);
  });

  it("places a widget taller than the viewport at the top margin", () => {
    const widgetId = sourceFileId("tall.ts");
    const board = Board.fromLayout(
      metrics,
      layout([
        placement("tall.ts", { x: 100, y: 100, width: 300, height: 600 }),
      ]),
    );

    expect(board.zoomToWidget(widgetId, 800, 600)).toBe(true);

    const widget = board.widget(widgetId);
    if (widget === undefined) throw new Error("Expected test widget.");
    const screen = { x: 0, y: 0 };
    board.camera.toScreen({ x: widget.x, y: widget.y }, screen);
    expect(screen.y).toBe(40);
  });

  it("returns false and leaves the camera unchanged for an unknown widget", () => {
    const board = boardWithOneWidget(0.37);
    board.setCamera(31, -17, 0.8);
    const before = {
      x: board.camera.offsetX,
      y: board.camera.offsetY,
      scale: board.camera.scale,
    };

    expect(board.zoomToWidget(sourceFileId("unknown.ts"), 800, 600)).toBe(
      false,
    );
    expect({
      x: board.camera.offsetX,
      y: board.camera.offsetY,
      scale: board.camera.scale,
    }).toEqual(before);
  });
});

describe("Board widgets", () => {
  it("keeps one widget per Source File", () => {
    const duplicate = placement("same.ts", {
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    });
    expect(() =>
      Board.fromLayout(metrics, layout([duplicate, duplicate])),
    ).toThrow(RangeError);
  });

  it("reads widgets top-most first and rejects unknown command ids", () => {
    const board = Board.fromLayout(
      metrics,
      layout([
        placement("bottom.ts", { x: 0, y: 0, width: 300, height: 300 }),
        placement("top.ts", { x: 0, y: 0, width: 300, height: 300 }),
      ]),
    );
    const unknown = sourceFileId("unknown.ts");

    expect(board.widgetCount).toBe(2);
    expect(board.widgetIdAtFromTop(0)).toBe(sourceFileId("top.ts"));
    expect(board.widget(unknown)).toBeUndefined();
    expect(() => {
      board.panCamera(1, 1);
    }).not.toThrow();
    expect(() => {
      board.zoomCameraAt(1, 1, 1.1);
    }).not.toThrow();
    expect(() => {
      board.setCamera(0, 0, 1);
    }).not.toThrow();
    expect(() => {
      board.moveWidget(unknown, 0, 0);
    }).toThrow(RangeError);
    expect(() => {
      board.resizeWidget(unknown, 1, 1);
    }).toThrow(RangeError);
    expect(() => {
      board.scrollWidget(unknown, 1);
    }).toThrow(RangeError);
    expect(() => {
      board.bringToFront(unknown);
    }).toThrow(RangeError);
    expect(() => {
      board.setLineCount(unknown, 1);
    }).toThrow(RangeError);
  });
});

describe("Board hit-test", () => {
  it("returns top-most widgets, zones, content coordinates, and reusable results", () => {
    const bottomId = sourceFileId("bottom.ts");
    const topId = sourceFileId("top.ts");
    const board = Board.fromLayout(
      metrics,
      layout([
        placement("bottom.ts", { x: 100, y: 100, width: 300, height: 300 }),
        placement(
          "top.ts",
          { x: 100, y: 100, width: 300, height: 300 },
          100,
          20,
        ),
      ]),
    );
    const out = createHitTestResult();

    expect(board.hitTest(200, 200, out)).toBe(out);
    expect(out.widgetId).toBe(topId);
    board.bringToFront(bottomId);
    board.hitTest(200, 200, out);
    expect(out.widgetId).toBe(bottomId);
    board.bringToFront(topId);

    board.hitTest(110, 110, out);
    expect(out.zone).toBe("header");
    board.hitTest(110, 160, out);
    expect(out.zone).toBe("body");
    expect(out.contentX).toBe(10);
    expect(out.contentY).toBe(38);

    board.hitTest(404, 200, out);
    expect(out.zone).toBe("right-edge");
    board.hitTest(200, 404, out);
    expect(out.zone).toBe("bottom-edge");
    board.hitTest(404, 404, out);
    expect(out.zone).toBe("corner");
    board.hitTest(200, 200, out);
    expect(out.zone).toBe("body");

    board.setCamera(0, 0, 0.1);
    board.hitTest(44, 20, out);
    expect(out.zone).toBe("right-edge");
    board.hitTest(20, 44, out);
    expect(out.zone).toBe("bottom-edge");
    board.hitTest(44, 44, out);
    expect(out.zone).toBe("corner");
    board.hitTest(20, 20, out);
    expect(out.zone).toBe("body");

    board.updateDetailLevel(1, true);
    board.hitTest(20, 20, out);
    expect(out.zone).toBe("header");
    board.hitTest(1000, 1000, out);
    expect(out.zone).toBe("empty");
    expect(out.widgetId).toBeUndefined();
  });
});

describe("Board saved layout", () => {
  it("round-trips through reconcile", () => {
    const files = [file("a.ts", 100), file("b.ts", 200)];
    const board = Board.fromLayout(
      metrics,
      layout(
        [
          placement("a.ts", { x: 20, y: 30, width: 400, height: 300 }, 100, 20),
          placement(
            "b.ts",
            { x: 500, y: 60, width: 500, height: 400 },
            200,
            30,
          ),
        ],
        { x: 12, y: -8, scale: 1.5 },
      ),
    );
    board.moveWidget(sourceFileId("a.ts"), 40, 50);
    board.resizeWidget(sourceFileId("b.ts"), 600, 500);
    board.scrollWidget(sourceFileId("a.ts"), 10);
    board.bringToFront(sourceFileId("a.ts"));
    const saved: SavedLayout = board.toSavedLayout();

    const restored = Board.fromLayout(
      metrics,
      reconcile(saved, files, metrics),
    );

    expect(restored.toSavedLayout()).toEqual(saved);
  });
});
