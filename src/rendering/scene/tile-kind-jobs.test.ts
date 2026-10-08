import { describe, expect, it } from "vitest";

import { encodeRasterCells } from "../text/raster-job";
import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  TileRecords,
  type TileRecordSource,
} from "./widget-tile-set";
import { writeTileKindJob, type TileContentSource } from "./tile-kind-jobs";

const sourceRecord: TileRecordSource = {
  fileId: "file-a",
  filePath: "src/a.ts",
  contentVersion: 3,
  highlighted: true,
  contentWidth: 1024,
  contentHeight: 2048,
  label: {
    identity: "label-a",
    x: 40,
    y: 72,
    width: 120,
    height: 20,
  },
};

const contentCells = encodeRasterCells([]);
const headerCells = encodeRasterCells([]);
const source: TileContentSource = {
  ...sourceRecord,
  hasText: true,
  palette: ["#text"],
  baseline: 15,
  lineHeight: 20,
  backgroundColor: "body",
  headerBackgroundColor: "header",
  cellsFor: () => contentCells,
  headerCellsFor: () => headerCells,
  label: {
    identity: "label-a",
    x: 40,
    y: 72,
    width: 120,
    height: 20,
    jobFor: () => ({
      cells: [],
      font: "16px Menlo",
      baseline: 15,
      lineHeight: 20,
      originY: 72,
      backgroundColor: "transparent",
      palette: ["#label"],
      outlineColor: "outline",
      outlineWidth: 1,
    }),
  },
};

function newJob() {
  return {
    tileKey: "tile",
    contentVersion: 0,
    rasterScale: 1,
    backgroundColor: "",
    palette: [] as readonly string[],
    font: "16px Menlo",
    baseline: 0,
    lineHeight: 0,
    originY: 0,
    outlineColor: "",
    outlineWidth: 0,
    width: 0,
    height: 0,
    cells: encodeRasterCells([]),
  };
}

function recordFor(kind: number): { records: TileRecords; record: number } {
  const records = new TileRecords(4);
  records.setContentSource(sourceRecord, 1);
  records.setHeaderHeight(24);
  const record = records.ensureRecord(kind, 1, 2, 3);
  return { records, record };
}

describe("tile kind jobs", () => {
  it.each([
    {
      kind: CONTENT_KIND,
      backgroundColor: "body",
      originY: 1536,
      width: 512,
      height: 512,
    },
    {
      kind: HEADER_KIND,
      backgroundColor: "header",
      originY: 0,
      width: 512,
      height: 32,
    },
    {
      kind: LABEL_KIND,
      backgroundColor: "transparent",
      originY: 72,
      width: 512,
      height: 32,
    },
  ])(
    "writes the background, origin, and size class for kind %s",
    ({ kind, backgroundColor, originY, width, height }) => {
      const { records, record } = recordFor(kind);
      const job = newJob();

      expect(writeTileKindJob(source, records, record, job)).toBe(true);
      expect(job.backgroundColor).toBe(backgroundColor);
      expect(job.originY).toBe(originY);
      expect(job.width).toBe(width);
      expect(job.height).toBe(height);
    },
  );
});
