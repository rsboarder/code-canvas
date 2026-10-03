import { describe, expect, it } from "vitest";

import {
  createLineGeometry,
  LineLayout,
  type LineMetrics,
} from "../code-view/domain/line-layout";

const metrics: LineMetrics = {
  narrowAdvance: 8,
  tabSize: 4,
  baseline: 15,
  lineHeight: 20,
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

describe("LineLayout geometry", () => {
  it.each([
    ["😀\tx", 20],
    ["é\tx", 20],
    ["a\tx", 30],
  ] as const)(
    "counts UTF-16 code units before a tab in %s (advance %d)",
    (text, expectedTabAdvance) => {
      const layout = new LineLayout(text, {
        ...metrics,
        narrowAdvance: 10,
      });
      const tab = layout.cells(0)[1];

      expect(tab?.advance).toBe(expectedTabAdvance);
    },
  );

  it("uses visible full-width columns before a tab ending at x=37", () => {
    const layout = new LineLayout("界\tx", {
      ...metrics,
      narrowAdvance: 10,
      advanceFor: (cluster) => (cluster === "界" ? 17 : 10),
    });
    const geometry = createLineGeometry();

    layout.layoutLine(0, geometry);

    expect(Array.from(geometry.xs.slice(0, geometry.clusterCount + 1))).toEqual(
      [0, 17, 37, 47],
    );
  });

  it("reuses and grows a line geometry for a 317-cluster line", () => {
    const layout = new LineLayout("x".repeat(317), metrics);
    const geometry = createLineGeometry(1);

    expect(layout.layoutLine(0, geometry)).toBe(geometry);
    expect(geometry.clusterCount).toBe(317);
    expect(geometry.utf16Starts[geometry.clusterCount]).toBe(317);
    expect(geometry.utf16Starts.length).toBeGreaterThan(317);
  });

  it("round-trips cluster boundaries and maps surrogate offsets to their cluster", () => {
    const layout = new LineLayout("a😀b", metrics);
    const geometry = createLineGeometry();

    layout.layoutLine(0, geometry);

    expect(layout.xAtOffset(0, 0)).toBe(0);
    expect(layout.xAtOffset(0, 1)).toBe(10);
    expect(layout.xAtOffset(0, 2)).toBe(10);
    expect(layout.xAtOffset(0, 3)).toBe(30);
    expect(layout.xAtOffset(0, 4)).toBe(40);
    expect(layout.offsetAtX(0, 0)).toBe(0);
    expect(layout.offsetAtX(0, 10)).toBe(1);
    expect(layout.offsetAtX(0, 30)).toBe(3);
    expect(layout.offsetAtX(0, 40)).toBe(4);
  });

  it("clamps positionAt and uses the right-half midpoint rule", () => {
    const layout = new LineLayout("ab\ncd", {
      ...metrics,
      advanceFor: () => 10,
    });

    expect(layout.positionAt(0, -1)).toEqual({ lineNumber: 1, column: 1 });
    expect(layout.positionAt(0, 100)).toEqual({ lineNumber: 2, column: 1 });
    expect(layout.positionAt(6, 10)).toEqual({ lineNumber: 1, column: 2 });
  });
});

describe("LineLayout ASCII fast path", () => {
  it("uses code units for ASCII tabs and graphemes for non-ASCII lines", () => {
    const asciiLayout = new LineLayout("a\tbc", metrics);
    const asciiGeometry = createLineGeometry();

    asciiLayout.layoutLine(0, asciiGeometry);

    expect(asciiGeometry.clusterCount).toBe(4);
    expect(Array.from(asciiGeometry.utf16Starts.slice(0, 5))).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(Array.from(asciiGeometry.xs.slice(0, 5))).toEqual([
      0, 10, 34, 44, 54,
    ]);

    const nonAsciiLayout = new LineLayout("👍🏽x", metrics);

    expect(nonAsciiLayout.cells(0).map((cell) => cell.text)).toEqual([
      "👍🏽",
      "x",
    ]);
  });
});
