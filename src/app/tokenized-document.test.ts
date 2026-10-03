import { describe, expect, it } from "vitest";

import { TokenizedDocument, type PackedTokenRuns } from "../code-view";
import { sourceFileId, type SourceFileId } from "../shared/domain";

const FILE_ID = sourceFileId("src/app/main.ts");

function packed(
  firstLine: number,
  runs: Uint32Array,
  lineRunOffsets: Uint32Array,
): PackedTokenRuns {
  return { firstLine, runs, lineRunOffsets };
}

function validPacked(firstLine = 10): PackedTokenRuns {
  return packed(
    firstLine,
    new Uint32Array([0, 1, 4, 2, 9, 3, 0, 4, 0, 5, 2, 6, 6, 7]),
    new Uint32Array([0, 6, 8, 14]),
  );
}

type InvalidCase = readonly [string, SourceFileId, number, PackedTokenRuns];

const invalidCases: readonly InvalidCase[] = [
  [
    "empty line offsets",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0, 1]), new Uint32Array()),
  ],
  [
    "line offsets not starting at zero",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0, 1]), new Uint32Array([2, 2])),
  ],
  [
    "decreasing line offset",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0, 1]), new Uint32Array([0, 4, 2])),
  ],
  [
    "odd line offset",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0, 1]), new Uint32Array([0, 1, 2])),
  ],
  [
    "last line offset does not match runs",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0, 1]), new Uint32Array([0, 0])),
  ],
  [
    "odd run array length",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0]), new Uint32Array([0, 2])),
  ],
  ["negative first line", FILE_ID, 1, validPacked(-1)],
  [
    "line with no runs",
    FILE_ID,
    1,
    packed(0, new Uint32Array(), new Uint32Array([0, 0])),
  ],
  [
    "line whose first run does not start at zero",
    FILE_ID,
    1,
    packed(0, new Uint32Array([1, 1]), new Uint32Array([0, 2])),
  ],
  [
    "non-increasing offsets within a line",
    FILE_ID,
    1,
    packed(0, new Uint32Array([0, 1, 0, 2]), new Uint32Array([0, 4])),
  ],
];

describe("TokenizedDocument", () => {
  it("looks up colors across token runs with binary-search semantics", () => {
    const document = new TokenizedDocument(FILE_ID, 7, validPacked());

    expect(document.colorAt(10, 0)).toBe(1);
    expect(document.colorAt(10, 4)).toBe(2);
    expect(document.colorAt(10, 6)).toBe(2);
    expect(document.colorAt(10, 100)).toBe(3);
    expect(document.colorAt(11, 0)).toBe(4);
    expect(document.colorAt(11, 100)).toBe(4);
    expect(document.colorAt(12, 2)).toBe(6);
  });

  it("reports the line and run ranges", () => {
    const document = new TokenizedDocument(FILE_ID, 7, validPacked());

    expect(document.lineCount).toBe(3);
    expect(document.endLine).toBe(13);
    expect(document.runCount(10)).toBe(3);
    expect(document.runCount(11)).toBe(1);
    expect(document.runCount(12)).toBe(3);
  });

  it("keeps the supplied typed arrays unchanged", () => {
    const packedRuns = validPacked();
    const originalRuns = [...packedRuns.runs];
    const originalLineRunOffsets = [...packedRuns.lineRunOffsets];

    new TokenizedDocument(FILE_ID, 7, packedRuns);

    expect([...packedRuns.runs]).toEqual(originalRuns);
    expect([...packedRuns.lineRunOffsets]).toEqual(originalLineRunOffsets);
  });

  it.each(invalidCases)(
    "%s rejects invalid packed data",
    (_name, fileId, contentVersion, packedRuns) => {
      expect(
        () => new TokenizedDocument(fileId, contentVersion, packedRuns),
      ).toThrow(RangeError);
    },
  );

  it("rejects lines outside its range", () => {
    const document = new TokenizedDocument(FILE_ID, 7, validPacked());

    expect(() => document.runCount(9)).toThrow(RangeError);
    expect(() => document.colorAt(13, 0)).toThrow(RangeError);
  });
});
