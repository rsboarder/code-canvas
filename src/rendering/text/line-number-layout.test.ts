import { describe, expect, it } from "vitest";

import { LineLayout } from "../../code-view/index";
import { decodeRasterCells, RasterCellWriter } from "./raster-job";
import { LineNumberLayout } from "./line-number-layout";

describe("line number layout", () => {
  it("places digits where LineLayout does", () => {
    const metrics = {
      narrowAdvance: 8,
      tabSize: 4,
      baseline: 16,
      lineHeight: 20,
      advanceFor: (cluster: string) => 7.25 + 0.5 * Number(cluster),
    };
    const layout = new LineNumberLayout(metrics.advanceFor);
    const numbers = [1, 9, 10, 99, 100, 1234, 2000];

    for (const number of numbers) {
      const expected = new LineLayout(String(number), metrics);
      const writer = new RasterCellWriter();
      const start = { x: 3.5, line: 8, colorIndex: 2 };
      writer.reset();
      layout.write(writer, number, start);

      const cells = decodeRasterCells(writer.finish());
      expect(layout.width(number)).toBe(expected.width(0));
      expect(cells).toHaveLength(expected.cells(0).length);
      expected.cells(0).forEach((cell, index) => {
        expect(cells[index]?.x).toBe(start.x + cell.x);
        expect(cells[index]?.cluster).toBe(cell.text);
        expect(cells[index]?.line).toBe(start.line);
        expect(cells[index]?.colorIndex).toBe(start.colorIndex);
      });
    }
  });
});
