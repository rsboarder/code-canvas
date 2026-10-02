import { describe, expect, it } from "vitest";

import {
  decodeRasterCells,
  encodeRasterCells,
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
});
