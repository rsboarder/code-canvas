import { describe, expect, it } from "vitest";

import {
  decodeRasterCells,
  encodeRasterCells,
  RasterCellWriter,
  type RasterCellInput,
} from "./raster-job";

describe("raster job cell encoding", () => {
  it("round-trips ASCII, wide and multi-unit grapheme clusters", () => {
    // x uses values exactly representable as float32 (the encoded x offsets
    // are a Float32Array): the round trip should be exact, not merely close.
    const cells: RasterCellInput[] = [
      { cluster: "a", x: 0, line: 0, colorIndex: 1 },
      { cluster: "\t", x: 8.5, line: 0, colorIndex: 0 },
      { cluster: "中", x: 20, line: 0, colorIndex: 2 },
      { cluster: "👩‍👩‍👧‍👦", x: 40, line: 1, colorIndex: 3 },
    ];

    const encoded = encodeRasterCells(cells);
    expect(decodeRasterCells(encoded)).toEqual(cells);
  });

  it("round-trips an empty cell list", () => {
    const encoded = encodeRasterCells([]);
    expect(encoded.cellCount).toBe(0);
    expect(decodeRasterCells(encoded)).toEqual([]);
  });

  it("packs offsets so each cluster's units are contiguous", () => {
    const encoded = encodeRasterCells([
      { cluster: "ab", x: 0, line: 0, colorIndex: 0 },
      { cluster: "c", x: 10, line: 0, colorIndex: 0 },
    ]);
    expect(Array.from(encoded.offsets)).toEqual([0, 2, 3]);
    expect(encoded.units.length).toBe(3);
  });
  it("a cell writer encodes source ranges like encodeRasterCells", () => {
    const source = "a😀👩‍💻z";
    const writer = new RasterCellWriter();
    const placement = { x: 1.25, line: 2, colorIndex: 3 };
    writer.reset();
    writer.appendCluster(source, 0, 1, placement);
    placement.x = 8.5;
    placement.line = 4;
    placement.colorIndex = 5;
    writer.appendCluster(source, 1, 3, placement);
    placement.x = 20;
    placement.line = 6;
    placement.colorIndex = 7;
    writer.appendCluster(source, 3, 8, placement);

    const actual = writer.finish();
    const expected = encodeRasterCells([
      { cluster: source.slice(0, 1), x: 1.25, line: 2, colorIndex: 3 },
      { cluster: source.slice(1, 3), x: 8.5, line: 4, colorIndex: 5 },
      { cluster: source.slice(3, 8), x: 20, line: 6, colorIndex: 7 },
    ]);

    expect(actual).toEqual(expected);
  });

  it("finish returns arrays that later writes do not change", () => {
    const writer = new RasterCellWriter();
    const placement = { x: 2, line: 1, colorIndex: 4 };
    writer.reset();
    writer.appendCluster("first", 0, 5, placement);
    const first = writer.finish();

    writer.reset();
    placement.x = 9;
    placement.line = 3;
    placement.colorIndex = 6;
    writer.appendCluster("second", 0, 6, placement);
    const second = writer.finish();

    expect(first).toEqual(
      encodeRasterCells([{ cluster: "first", x: 2, line: 1, colorIndex: 4 }]),
    );
    expect(second).toEqual(
      encodeRasterCells([{ cluster: "second", x: 9, line: 3, colorIndex: 6 }]),
    );
  });
});
