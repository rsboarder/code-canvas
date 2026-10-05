import { describe, expect, it } from "vitest";

import {
  BoardService,
  createHitTestResult,
  createWidgetRow,
  type BoardMetrics,
  type SavedLayout,
} from "../board";
import { createEventBus } from "../shared/events";
import {
  sourceFileId,
  workspaceFolderId,
  type SourceFileId,
} from "../shared/domain";
import type {
  DiscoveredFile,
  FileContentChanged,
  WorkspaceEvent,
} from "../workspace";
import { filePath } from "../workspace";

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

const viewport = { width: 1600, height: 1000 };

function file(path: string, lineCount: number): DiscoveredFile {
  return { fileId: sourceFileId(path), path: filePath(path), lineCount };
}

function createService() {
  const events = createEventBus<WorkspaceEvent>();
  return { events, service: new BoardService(metrics, events) };
}

function savedLayoutCommands(
  service: BoardService,
  id: SourceFileId,
  folderId: ReturnType<typeof workspaceFolderId>,
): (() => void)[] {
  return [
    () => {
      service.pan(1, 2);
    },
    () => {
      service.zoomAt(100, 100, 1.1);
    },
    () => {
      service.setCamera(10, 20, 0.5);
    },
    () => {
      service.fitAll(viewport.width, viewport.height);
    },
    () => {
      service.zoomTo100(viewport.width, viewport.height);
    },
    () => {
      service.moveWidget(id, 700, 0);
    },
    () => {
      service.resizeWidget(id, 500, 400);
    },
    () => {
      service.scrollWidget(id, 10);
    },
    () => {
      service.bringToFront(id);
    },
    () => {
      service.restoreBoard(folderId, [file("a.ts", 100)], undefined, viewport);
    },
  ];
}

function screenRect(
  service: BoardService,
  id: SourceFileId,
): { x: number; y: number; width: number; height: number } {
  const row = createWidgetRow();
  service.readWidget(id, row);
  const topLeft = service.camera.toScreen(
    { x: row.x, y: row.y },
    { x: 0, y: 0 },
  );
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: row.width * service.camera.scale,
    height: row.height * service.camera.scale,
  };
}

describe("BoardService first opening", () => {
  it("First opening of a folder", () => {
    const { service } = createService();
    const folderId = workspaceFolderId("folder-1");
    service.restoreBoard(
      folderId,
      [file("z.ts", 12), file("a.ts", 20), file("m.ts", 2000)],
      undefined,
      viewport,
    );

    expect(service.folderId).toBe(folderId);
    expect(
      [0, 1, 2].map((index) => service.widgetIdAtFromTop(index)).reverse(),
    ).toEqual([
      sourceFileId("a.ts"),
      sourceFileId("m.ts"),
      sourceFileId("z.ts"),
    ]);
    for (const id of ["a.ts", "m.ts", "z.ts"]) {
      const rect = screenRect(service, sourceFileId(id));
      expect(rect.x).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(40 - 1e-9);
      expect(rect.x + rect.width).toBeLessThanOrEqual(
        viewport.width - 40 + 1e-9,
      );
      expect(rect.y + rect.height).toBeLessThanOrEqual(
        viewport.height - 40 + 1e-9,
      );
    }
  });
});

describe("BoardService fit", () => {
  it("Fit all", () => {
    const { service } = createService();
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 20), file("b.ts", 20)],
      undefined,
      viewport,
    );
    service.moveWidget(sourceFileId("a.ts"), -500, -200);
    service.moveWidget(sourceFileId("b.ts"), 2000, 1300);
    service.fitAll(viewport.width, viewport.height);

    const first = screenRect(service, sourceFileId("a.ts"));
    const second = screenRect(service, sourceFileId("b.ts"));
    expect(first.x).toBeGreaterThanOrEqual(40 - 1e-9);
    expect(first.y).toBeGreaterThanOrEqual(40 - 1e-9);
    expect(second.x + second.width).toBeLessThanOrEqual(
      viewport.width - 40 + 1e-9,
    );
    expect(second.y + second.height).toBeLessThanOrEqual(
      viewport.height - 40 + 1e-9,
    );
    expect(
      (Math.min(first.x, second.x) +
        Math.max(first.x + first.width, second.x + second.width)) /
        2,
    ).toBeCloseTo(viewport.width / 2);

    const empty = createService().service;
    empty.setCamera(10, 20, 0.7);
    const before = {
      x: empty.camera.offsetX,
      y: empty.camera.offsetY,
      scale: empty.camera.scale,
    };
    empty.fitAll(viewport.width, viewport.height);
    expect({
      x: empty.camera.offsetX,
      y: empty.camera.offsetY,
      scale: empty.camera.scale,
    }).toEqual(before);
  });
});

describe("BoardService zoom", () => {
  it("Zoom to 100%", () => {
    const { service } = createService();
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 20)],
      undefined,
      viewport,
    );
    service.setCamera(31, -17, 0.37);
    const before = service.camera.toBoard(
      { x: viewport.width / 2, y: viewport.height / 2 },
      { x: 0, y: 0 },
    );
    service.zoomTo100(viewport.width, viewport.height);
    const after = service.camera.toBoard(
      { x: viewport.width / 2, y: viewport.height / 2 },
      { x: 0, y: 0 },
    );

    expect(service.camera.scale).toBe(1);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe("BoardService reopening", () => {
  it("Reopening", () => {
    const { service } = createService();
    const saved: SavedLayout = {
      camera: { x: 12, y: -8, scale: 1.5 },
      widgets: [
        {
          fileId: sourceFileId("a.ts"),
          x: 40,
          y: 50,
          width: 400,
          height: 400,
          contentScroll: 20,
        },
        {
          fileId: sourceFileId("b.ts"),
          x: 500,
          y: 60,
          width: 500,
          height: 500,
          contentScroll: 30,
        },
      ],
    };
    const view = service.camera;
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 100), file("b.ts", 200)],
      saved,
      viewport,
    );

    expect(service.camera).toBe(view);
    expect(service.camera.offsetX).toBe(saved.camera.x);
    expect(service.camera.offsetY).toBe(saved.camera.y);
    expect(service.camera.scale).toBe(saved.camera.scale);
    const boardPoint = view.toBoard({ x: 100, y: 200 }, { x: 0, y: 0 });
    expect(boardPoint.x).toBeCloseTo(
      (100 - saved.camera.x) / saved.camera.scale,
    );
    expect(boardPoint.y).toBeCloseTo(
      (200 - saved.camera.y) / saved.camera.scale,
    );
    const screenPoint = view.toScreen(boardPoint, { x: 0, y: 0 });
    expect(screenPoint.x).toBeCloseTo(100);
    expect(screenPoint.y).toBeCloseTo(200);
    expect(service.widgetIdAtFromTop(0)).toBe(sourceFileId("b.ts"));
    const row = createWidgetRow();
    service.readWidget(sourceFileId("a.ts"), row);
    expect(row).toMatchObject({ x: 40, y: 50, contentScroll: 20 });
  });
});

describe("BoardService pinch zoom", () => {
  it("Pinch-zoom toward a point", () => {
    const { service } = createService();
    service.setCamera(31, -17, 0.8);
    const before = service.camera.toBoard({ x: 240, y: 180 }, { x: 0, y: 0 });
    service.zoomAt(240, 180, 1.7);
    const after = service.camera.toBoard({ x: 240, y: 180 }, { x: 0, y: 0 });
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe("BoardService dirty widgets", () => {
  it("tracks dirty widgets and reuses the drain array", () => {
    const { service } = createService();
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 100), file("b.ts", 100), file("c.ts", 100)],
      undefined,
      viewport,
    );
    const out = [sourceFileId("stale.ts")];
    expect(service.drainDirtyWidgets(out)).toBe(3);
    expect(out).toHaveLength(3);
    expect(service.drainDirtyWidgets(out)).toBe(0);
    service.moveWidget(sourceFileId("a.ts"), 1, 2);
    service.resizeWidget(sourceFileId("b.ts"), 400, 400);
    expect(service.scrollWidget(sourceFileId("c.ts"), 0)).toBe(0);
    service.bringToFront(sourceFileId("a.ts"));
    expect(service.drainDirtyWidgets(out)).toBe(3);
    service.pan(1, 2);
    service.zoomAt(100, 100, 1.1);
    service.setCamera(0, 0, 1);
    service.updateDetailLevel(1, true);
    expect(service.drainDirtyWidgets(out)).toBe(0);
    const topId = service.widgetIdAtFromTop(0);
    if (topId === undefined) throw new Error("Expected a top widget.");
    service.bringToFront(topId);
    expect(service.drainDirtyWidgets(out)).toBe(0);
  });

  it("clamps absolute content scroll and avoids dirtying when unchanged", () => {
    const { service } = createService();
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 100)],
      undefined,
      viewport,
    );
    const id = sourceFileId("a.ts");
    service.drainDirtyWidgets([]);
    const row = createWidgetRow();
    service.readWidget(id, row);
    const revision = service.savedLayoutRevision;

    const applied = service.setContentScroll(id, Number.MAX_SAFE_INTEGER);
    expect(applied).toBe(row.maxContentScroll);
    expect(service.drainDirtyWidgets([])).toBe(1);
    expect(service.savedLayoutRevision).toBe(revision + 1);

    expect(service.setContentScroll(id, applied)).toBe(applied);
    expect(service.drainDirtyWidgets([])).toBe(0);
    expect(service.savedLayoutRevision).toBe(revision + 1);
  });
});

describe("BoardService content events", () => {
  it("updates line counts from FileContentChanged and stops after dispose", () => {
    const { events, service } = createService();
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 100)],
      undefined,
      viewport,
    );
    const id = sourceFileId("a.ts");
    service.scrollWidget(id, 99999);
    service.drainDirtyWidgets([]);
    const changed: FileContentChanged = {
      type: "FileContentChanged",
      fileId: id,
      contentVersion: 1,
      text: "",
      lineCount: 2,
    };
    events.publish(changed);
    const row = createWidgetRow();
    service.readWidget(id, row);
    expect(row.lineCount).toBe(2);
    expect(row.contentScroll).toBe(0);
    expect(service.drainDirtyWidgets([])).toBe(1);
    service.dispose();
    events.publish({ ...changed, lineCount: 200 });
    service.readWidget(id, row);
    expect(row.lineCount).toBe(2);
    expect(() => {
      events.publish({ ...changed, fileId: sourceFileId("missing.ts") });
    }).not.toThrow();
  });
});

describe("BoardService saved layout revision", () => {
  it("increments for saved-layout commands and applied content changes", () => {
    const { events, service } = createService();
    const folderId = workspaceFolderId("folder-1");
    const id = sourceFileId("a.ts");
    service.restoreBoard(folderId, [file("a.ts", 100)], undefined, viewport);

    const commands = savedLayoutCommands(service, id, folderId);
    let expected = service.savedLayoutRevision;
    for (const command of commands) {
      command();
      expected += 1;
      expect(service.savedLayoutRevision).toBe(expected);
    }

    const beforeZeroScroll = service.savedLayoutRevision;
    service.scrollWidget(id, 0);
    expect(service.savedLayoutRevision).toBe(beforeZeroScroll);

    events.publish({
      type: "FileContentChanged",
      fileId: id,
      contentVersion: 1,
      text: "changed",
      lineCount: 2,
    });
    expect(service.savedLayoutRevision).toBe(beforeZeroScroll + 1);
  });

  it("returns the restored board layout", () => {
    const { service } = createService();
    const saved: SavedLayout = {
      camera: { x: 12, y: -8, scale: 1.5 },
      widgets: [
        {
          fileId: sourceFileId("a.ts"),
          x: 40,
          y: 50,
          width: 400,
          height: 400,
          contentScroll: 20,
        },
      ],
    };

    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 100)],
      saved,
      viewport,
    );

    expect(service.savedLayout()).toEqual(saved);
  });
});

describe("BoardService read model", () => {
  it("reads widgets, hit tests, detail state, and rejects unknown ids", () => {
    const { service } = createService();
    service.restoreBoard(
      workspaceFolderId("folder-1"),
      [file("a.ts", 100)],
      undefined,
      viewport,
    );
    const row = createWidgetRow();
    expect(service.readWidget(sourceFileId("a.ts"), row)).toBe(row);
    expect(row.stackIndex).toBe(0);
    expect(() => {
      service.readWidget(sourceFileId("missing.ts"), row);
    }).toThrow(RangeError);
    expect(() => {
      service.moveWidget(sourceFileId("missing.ts"), 0, 0);
    }).toThrow(RangeError);
    expect(() => {
      service.resizeWidget(sourceFileId("missing.ts"), 1, 1);
    }).toThrow(RangeError);
    expect(() => {
      service.scrollWidget(sourceFileId("missing.ts"), 1);
    }).toThrow(RangeError);
    expect(() => {
      service.bringToFront(sourceFileId("missing.ts"));
    }).toThrow(RangeError);

    const hit = createHitTestResult();
    expect(service.hitTest(50, 50, hit)).toBe(hit);
    expect(service.textThresholdZoom(2)).toBe(11 / 40);
    expect(service.textWanted(2)).toBe(false);
    service.setCamera(0, 0, 0.2);
    expect(service.updateDetailLevel(2, true)).toBe("minimap");
    expect(service.textWanted(2)).toBe(false);
    service.setCamera(0, 0, 0.3);
    expect(service.textWanted(2)).toBe(true);
    expect(service.updateDetailLevel(2, true)).toBe("text");
  });
});
