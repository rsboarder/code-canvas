import { describe, expect, it } from "vitest";

import { EDGE_CASE_FILES } from "./dataset";
import {
  LineLayout,
  createLineGeometry,
  type LineMetrics,
} from "../../src/code-view/domain/line-layout";

const metrics: LineMetrics = {
  narrowAdvance: 10,
  tabSize: 4,
  baseline: 15,
  lineHeight: 20,
  advanceFor: (cluster) => ((cluster.codePointAt(0) ?? 0) >= 0x1100 ? 17 : 10),
};

describe.each(EDGE_CASE_FILES)("LineLayout corpus: $relativePath", (file) => {
  it("matches expected lines and has monotonic UTF-16 geometry", () => {
    const layout = new LineLayout(file.text, metrics);

    expect(layout.lineCount).toBe(file.expected.lineCount);
    expect(layout.lines).toEqual(file.expected.lines);
    for (let lineIndex = 0; lineIndex < layout.lineCount; lineIndex += 1) {
      const line = layout.lines[lineIndex] ?? "";
      const geometry = layout.layoutLine(lineIndex, createLineGeometry());

      expect(geometry.utf16Starts[geometry.clusterCount]).toBe(line.length);
      for (let index = 1; index <= geometry.clusterCount; index += 1) {
        expect(geometry.xs[index]).toBeGreaterThanOrEqual(
          geometry.xs[index - 1] ?? 0,
        );
      }
    }
  });

  it("keeps the corpus tab stops and wide graphemes intact", () => {
    if (file.relativePath === "tabs-at-columns.tsx") {
      const layout = new LineLayout(file.text, metrics);
      for (const [
        lineIndex,
        leadingSpaces,
      ] of file.expected.tabColumns.entries()) {
        const geometry = layout.layoutLine(lineIndex, createLineGeometry());
        const tabOffset = leadingSpaces;
        const tabCluster = Array.from(
          { length: geometry.clusterCount },
          (_, index) => index,
        ).find((index) => geometry.utf16Starts[index] === tabOffset);
        if (tabCluster === undefined)
          throw new Error("Corpus tab cluster is missing");
        expect(geometry.xs[tabCluster + 1]).toBe(
          (Math.floor(leadingSpaces / metrics.tabSize) + 1) *
            metrics.tabSize *
            metrics.narrowAdvance,
        );
      }
    }

    if (file.relativePath === "long-and-wide.ts") {
      const layout = new LineLayout(file.text, metrics);
      const wideCells = layout.cells(0);
      const wideCluster = wideCells.find((cell) => cell.text === "😀‍👩‍💻");
      expect(wideCluster?.utf16Length).toBe("😀‍👩‍💻".length);
    }

    if (file.relativePath === "tabs-after-wide.ts") {
      const layout = new LineLayout(file.text, metrics);
      expect(layout.cells(1).find((cell) => cell.text === "\t")?.advance).toBe(
        30,
      );
      expect(layout.cells(2).find((cell) => cell.text === "\t")?.advance).toBe(
        10,
      );
    }
  });
});
