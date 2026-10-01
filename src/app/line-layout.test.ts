import { describe, expect, it } from "vitest";

import { LineLayout, type LineMetrics } from "../code-view/domain/line-layout";

const metrics: LineMetrics = {
  narrowAdvance: 8,
  tabSize: 4,
  baseline: 15,
  advanceFor: (cluster) => cluster.length * 10,
};

describe("LineLayout grapheme clusters", () => {
  it("keeps emoji sequences, combining marks, flags, and VS16 together", () => {
    const clusters = ["👩‍👩‍👧‍👦", "é", "🇦🇲", "❤️", "x"];
    const layout = new LineLayout(clusters.join(""), metrics);
    const cells = layout.cells(0);

    expect(cells.map((cell) => cell.text)).toEqual(clusters);
    expect(cells.map((cell) => cell.utf16Length)).toEqual(
      clusters.map((cluster) => cluster.length),
    );
    expect(cells[1]?.utf16Offset).toBe(clusters[0]?.length);
    expect(cells[4]?.utf16Offset).toBe(
      clusters
        .slice(0, 4)
        .reduce((offset, cluster) => offset + cluster.length, 0),
    );
  });

  it("maps clicks to cluster start columns", () => {
    const layout = new LineLayout("👩‍👩‍👧‍👦éx", metrics);
    const cells = layout.cells(0);
    const combiningStart = cells[1]?.utf16Offset ?? 0;
    const finalStart = cells[2]?.utf16Offset ?? 0;

    expect(layout.columnAtX(0, (cells[0]?.advance ?? 0) / 2 - 1)).toBe(1);
    expect(layout.columnAtX(0, (cells[0]?.advance ?? 0) + 1)).toBe(
      combiningStart + 1,
    );
    expect(
      layout.columnAtX(0, (cells[1]?.x ?? 0) + (cells[1]?.advance ?? 0) + 1),
    ).toBe(finalStart + 1);
  });
});
