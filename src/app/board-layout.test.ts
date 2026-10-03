import { describe, expect, it } from "vitest";

import { type BoardMetrics } from "../board/domain/board-metrics";
import { gridLayout } from "../board/domain/grid-layout";
import { reconcile } from "../board/domain/reconcile";
import type { SavedLayout, SavedWidget } from "../board/domain/saved-layout";
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

function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function savedWidget(
  fileId: string,
  placement: Omit<SavedWidget, "fileId">,
): SavedWidget {
  return {
    fileId: sourceFileId(fileId),
    ...placement,
  };
}

function savedWithNewFiles(): SavedLayout {
  return {
    camera: { x: 12, y: -8, scale: 1.5 },
    widgets: [
      savedWidget("a.ts", {
        x: 100,
        y: 50,
        width: 500,
        height: 500,
        contentScroll: 40,
      }),
      savedWidget("b.ts", {
        x: 700,
        y: 120,
        width: 600,
        height: 600,
        contentScroll: 80,
      }),
      savedWidget("c.ts", {
        x: 30,
        y: 800,
        width: 800,
        height: 700,
        contentScroll: 120,
      }),
    ],
  };
}

function savedWithMissingFile(): SavedLayout {
  return {
    camera: { x: 3, y: 4, scale: 0.8 },
    widgets: [
      savedWidget("gone.ts", {
        x: 0,
        y: 0,
        width: 760,
        height: 900,
        contentScroll: 0,
      }),
      savedWidget("kept.ts", {
        x: 10,
        y: 20,
        width: 760,
        height: 900,
        contentScroll: 99999,
      }),
      savedWidget("last.ts", {
        x: 20,
        y: 30,
        width: 760,
        height: 900,
        contentScroll: 0,
      }),
    ],
  };
}

describe("Grid layout", () => {
  it("First opening of a folder", () => {
    const files = Array.from({ length: 200 }, (_, index) =>
      file(`file-${String(index).padStart(3, "0")}.ts`, index + 1),
    ).reverse();

    const result = reconcile(undefined, files, metrics);

    expect(result.widgets).toHaveLength(200);
    expect(result.camera).toBeUndefined();
    expect(result.widgets.map((item) => item.path)).toEqual(
      files
        .map((item) => item.path)
        .sort((left, right) => left.localeCompare(right, "en")),
    );
    expect(result.widgets.every((item) => item.width === 760)).toBe(true);
    for (let left = 0; left < result.widgets.length; left += 1) {
      for (let right = left + 1; right < result.widgets.length; right += 1) {
        const leftPlacement = result.widgets[left];
        const rightPlacement = result.widgets[right];
        if (leftPlacement === undefined || rightPlacement === undefined) {
          continue;
        }
        expect(overlaps(leftPlacement, rightPlacement)).toBe(false);
      }
    }
  });

  it("Short and long files", () => {
    const result = gridLayout(
      [file("short.ts", 20), file("long.ts", 2000)],
      metrics,
      0,
      0,
    );
    const short = result.find((item) => item.path === "short.ts");
    const long = result.find((item) => item.path === "long.ts");

    expect(short?.height).toBeLessThan(long?.height ?? 0);
    expect(long?.height).toBe(900);
  });
});

describe("Reconcile additions", () => {
  it("New file in the folder", () => {
    const saved = savedWithNewFiles();
    const result = reconcile(
      saved,
      [
        file("a.ts", 100),
        file("b.ts", 100),
        file("c.ts", 100),
        file("d.ts", 20),
        file("e.ts", 20),
      ],
      metrics,
    );

    expect(result.camera).toBe(saved.camera);
    expect(result.widgets.slice(0, 3)).toMatchObject(saved.widgets);
    const keptRight = Math.max(
      ...result.widgets.slice(0, 3).map((item) => item.x + item.width),
    );
    const added = result.widgets.slice(3);
    expect(added.map((item) => item.path)).toEqual(["d.ts", "e.ts"]);
    expect(added.every((item) => item.x >= keptRight + metrics.gridGap)).toBe(
      true,
    );
    expect(
      added.every((item) =>
        result.widgets.slice(0, 3).every((kept) => !overlaps(item, kept)),
      ),
    ).toBe(true);
  });
});

describe("Reconcile restored layout", () => {
  it("drops missing files, preserves stack order, and re-clamps saved scroll", () => {
    const saved = savedWithMissingFile();

    const result = reconcile(
      saved,
      [file("kept.ts", 100), file("last.ts", 2000)],
      metrics,
    );

    expect(result.widgets.map((item) => item.path)).toEqual([
      "kept.ts",
      "last.ts",
    ]);
    expect(result.widgets[0]?.contentScroll).toBe(100 * 20 - (900 - 42));
    expect(result.camera).toBe(saved.camera);
  });

  it("rejects duplicate discovered ids", () => {
    const duplicate = file("same.ts", 10);

    expect(() => reconcile(undefined, [duplicate, duplicate], metrics)).toThrow(
      RangeError,
    );
  });
});
