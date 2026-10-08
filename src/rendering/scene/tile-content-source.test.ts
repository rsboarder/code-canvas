import { expect, it } from "vitest";

import { LineNumberGutter, type LineWindow } from "../../code-view/index";
import { DEFAULT_CODE_FONT } from "../../shared/font";
import type { Rect } from "../../shared/geometry/geometry";
import { decodeRasterCells } from "../text/raster-job";
import type { CodeTextMetrics } from "../text/text-metrics";
import { TileContentSourceBuilder } from "./tile-content-source";

const metrics: CodeTextMetrics = {
  narrowAdvance: 10,
  tabSize: 4,
  baseline: 15,
  lineHeight: 20,
  advanceFor: (cluster) => cluster.length * 10,
  lineNumberGutter: new LineNumberGutter(10),
};

const sourceBuilder = new TileContentSourceBuilder({
  metrics,
  font: DEFAULT_CODE_FONT,
  palette: ["#text", "#token", "#line"],
  lineNumberColorIndex: 2,
  baseline: metrics.baseline,
  lineHeight: metrics.lineHeight,
  backgroundColor: "#body",
  headerBackgroundColor: "#header",
});

it("places cells at a non-integer raster scale", () => {
  const source = createSource(
    makeWindow(["A"], [{ line: 0, start: 0, end: 1, x: 12, color: 1 }]),
  );

  const cells = decodeRasterCells(source.cellsFor(0, 0, 1.37));

  const codeCells = cells.filter((cell) => cell.colorIndex === 1);
  expect(codeCells).toHaveLength(1);
  expect(codeCells[0]).toMatchObject({
    cluster: "A",
    line: 0,
    colorIndex: 1,
  });
  expect(codeCells[0]?.x).toBeCloseTo(60);
});

it("keeps the one-line and one-tile margins at a tile edge", () => {
  const rasterScale = 1.5;
  const size = 512 / rasterScale;
  const lines = Array.from({ length: 40 }, () => "A");
  const gutter = metrics.lineNumberGutter.codeLeft(lines.length);
  const source = createSource(
    makeWindow(lines, [
      { line: 16, start: 0, end: 1, x: 0, color: 1 },
      { line: 35, start: 0, end: 1, x: 0, color: 1 },
      {
        line: 20,
        start: 0,
        end: 1,
        x: 3 * size - gutter - 0.1,
        color: 1,
      },
      {
        line: 20,
        start: 0,
        end: 1,
        x: 3 * size - gutter + 0.1,
        color: 1,
      },
    ]),
  );

  const cells = decodeRasterCells(source.cellsFor(1, 1, rasterScale));

  expect(cells.filter((cell) => cell.line === 16)).toHaveLength(1);
  expect(cells.filter((cell) => cell.line === 35)).toHaveLength(1);
  expect(cells.filter((cell) => cell.line === 20)).toHaveLength(1);
});

it("right-aligns line numbers after the gutter offset", () => {
  const source = createSource(
    makeWindow(
      Array.from({ length: 10 }, () => ""),
      [],
      12_345,
    ),
  );

  const cells = decodeRasterCells(source.cellsFor(0, 0, 1));
  const lineTen = cells.filter((cell) => cell.line === 9);

  expect(lineTen.map((cell) => cell.cluster)).toEqual(["1", "0"]);
  expect(lineTen.map((cell) => cell.x)).toEqual([30, 40]);
  expect(lineTen.every((cell) => cell.colorIndex === 2)).toBe(true);
});

it("builds header cells with tile offsets and drops whitespace clusters", () => {
  const source = createSource(makeWindow([""], []), "\t src/a.ts");

  const cells = decodeRasterCells(source.headerCellsFor(1, 2));
  const visible = cells.map((cell) => cell.cluster).join("");

  expect(visible).toBe("src/a.ts");
  expect(cells[0]?.x).toBeCloseTo(16 + 50 - 512 / 2);
  expect(cells.some((cell) => /^\s+$/u.test(cell.cluster))).toBe(false);
});

it("keeps tabs and whitespace-only clusters out of a body window", () => {
  const source = createSource(
    makeWindow(
      ["\t \u00a0A\t"],
      [{ line: 0, start: 3, end: 4, x: 24, color: 1 }],
    ),
  );

  const cells = decodeRasterCells(source.cellsFor(0, 0, 1));

  expect(
    cells.filter((cell) => cell.colorIndex === 1).map((cell) => cell.cluster),
  ).toEqual(["A"]);
});

it("creates the minimap label source through its public interface", () => {
  const frame: Rect = { x: 0, y: 0, width: 320, height: 240 };
  const source = sourceBuilder.labelSourceFor("src/a.ts", frame, 1);

  expect(source.identity).toContain("src/a.ts");
  expect(source.jobFor(1).cells).toHaveLength(1);
});

interface CellSpec {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly x: number;
  readonly color: number;
}

function makeWindow(
  lines: readonly string[],
  cells: readonly CellSpec[],
  lineCount = lines.length,
): LineWindow {
  const ordered = [...cells].sort((left, right) => left.line - right.line);
  const lineCellOffsets = new Uint32Array(lines.length + 1);
  const cellStarts = new Uint32Array(ordered.length);
  const cellEnds = new Uint32Array(ordered.length);
  const cellXs = new Float32Array(ordered.length);
  const cellColors = new Uint8Array(ordered.length);
  let cursor = 0;
  for (let line = 0; line < lines.length; line += 1) {
    for (const cell of ordered) {
      if (cell.line !== line) continue;
      cellStarts[cursor] = cell.start;
      cellEnds[cursor] = cell.end;
      cellXs[cursor] = cell.x;
      cellColors[cursor] = cell.color;
      cursor += 1;
    }
    lineCellOffsets[line + 1] = cursor;
  }
  return {
    fileId: "file-a",
    contentVersion: 3,
    lineCount,
    firstLine: 0,
    highlighted: true,
    lines,
    lineCellOffsets,
    cellStarts,
    cellEnds,
    cellXs,
    cellColors,
  };
}

function createSource(window: LineWindow, filePath = "src/a.ts") {
  return sourceBuilder.contentSourceFor({
    fileId: window.fileId,
    filePath,
    contentVersion: window.contentVersion,
    highlighted: window.highlighted,
    contentWidth: 640,
    contentHeight: window.lineCount * metrics.lineHeight,
    window,
  });
}
