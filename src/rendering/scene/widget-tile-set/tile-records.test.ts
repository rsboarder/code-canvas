import { describe, expect, it } from "vitest";

import {
  CONTENT_KIND,
  HEADER_KIND,
  LABEL_KIND,
  TileRecords,
  type TileRecordSource,
} from "./tile-records";

const SOURCE: TileRecordSource = {
  fileId: "file-a",
  filePath: "src/a.ts",
  contentVersion: 7,
  highlighted: true,
  contentWidth: 1024,
  contentHeight: 1024,
};

describe("TileRecords", () => {
  it("ensures and finds records by kind, scale, column, and row", () => {
    const records = new TileRecords(8);
    records.setContentSource(SOURCE, 3);
    records.setHeaderHeight(32);

    const content = records.ensureRecord(CONTENT_KIND, 2, 1, 2);
    const header = records.ensureRecord(HEADER_KIND, 2, 1, 0);

    expect(content).toBeGreaterThanOrEqual(0);
    expect(header).toBeGreaterThanOrEqual(0);
    expect(records.findRecord(CONTENT_KIND, 2, 1, 2)).toBe(content);
    expect(records.findRecord(HEADER_KIND, 2, 1, 0)).toBe(header);
    expect(records.findRecordByKey(records.keys[content] ?? "")).toBe(content);
    expect(records.records.kind[content]).toBe(CONTENT_KIND);
    expect(records.records.kind[header]).toBe(HEADER_KIND);
  });

  it("uses the file id to keep identical tiles from different widgets unique", () => {
    const first = new TileRecords(8);
    const second = new TileRecords(8);
    first.setContentSource(SOURCE, 1);
    second.setContentSource(
      { ...SOURCE, fileId: "file-b", filePath: "src/b.ts" },
      1,
    );

    const firstRecord = first.ensureRecord(CONTENT_KIND, 2, 1, 2);
    const secondRecord = second.ensureRecord(CONTENT_KIND, 2, 1, 2);

    expect(first.keys[firstRecord]).not.toBe(second.keys[secondRecord]);
  });

  it("keeps old header records for lifecycle eviction", () => {
    const records = new TileRecords(8);
    records.setContentSource(SOURCE, 1);
    records.setHeaderHeight(32);
    const oldHeader = records.ensureRecord(HEADER_KIND, 1, 0, 0);
    const oldKey = records.keys[oldHeader];

    records.setContentSource({ ...SOURCE, filePath: "src/b.ts" }, 2);

    expect(oldKey).toBeDefined();
    expect(records.findRecord(HEADER_KIND, 1, 0, 0)).toBe(-1);
    const newHeader = records.ensureRecord(HEADER_KIND, 1, 0, 0);
    expect(records.keys[newHeader]).not.toBe(oldKey);
  });

  it("does not evict an active record when capacity is exhausted", () => {
    const records = new TileRecords(1);
    records.setContentSource(SOURCE, 1);
    records.ensureRecord(CONTENT_KIND, 1, 0, 0);
    const second = records.ensureRecord(CONTENT_KIND, 1, 1, 0);

    expect(second).toBe(-1);
  });
});

describe("TileRecords label lifecycle", () => {
  it("copies a body-space label rect instead of centring on document content", () => {
    const records = new TileRecords(8);
    const label = {
      identity: "src/a.ts\u0000a.ts\u000018",
      x: 380,
      y: 420,
      width: 120,
      height: 18,
    };
    records.setContentSource({ ...SOURCE, contentHeight: 40000, label }, 1);
    const record = records.ensureRecord(LABEL_KIND, 1, 0, 0);

    expect(records.records.localX[record]).toBe(label.x);
    expect(records.records.localY[record]).toBe(label.y);
    expect(records.records.width[record]).toBe(label.width);
    expect(records.records.height[record]).toBe(label.height);
  });

  it("keeps the label record through a content change", () => {
    const records = new TileRecords(8);
    const label = {
      identity: "src/a.ts\u0000a.ts\u000018",
      x: 380,
      y: 420,
      width: 120,
      height: 18,
    };
    records.setContentSource({ ...SOURCE, label }, 1);
    const record = records.ensureRecord(LABEL_KIND, 1, 0, 0);
    const key = records.keys[record];

    records.setContentSource({ ...SOURCE, contentVersion: 8, label }, 2);

    expect(records.findRecord(LABEL_KIND, 1, 0, 0)).toBe(record);
    expect(records.keys[record]).toBe(key);
  });

  it("keeps the previous label when its settled layout changes", () => {
    const records = new TileRecords(8);
    const oldLabel = {
      identity: "src/a.ts\u0000a.ts\u000018",
      x: 380,
      y: 420,
      width: 120,
      height: 18,
    };
    records.setContentSource({ ...SOURCE, label: oldLabel }, 1);
    const oldRecord = records.ensureRecord(LABEL_KIND, 1, 0, 0);
    const oldKey = records.keys[oldRecord];

    records.setContentSource(
      {
        ...SOURCE,
        label: { ...oldLabel, identity: "src/a.ts\u0000a.ts\u000012" },
      },
      2,
    );
    const newRecord = records.ensureRecord(LABEL_KIND, 1, 0, 0);

    expect(records.findRecordByKey(oldKey ?? "")).toBe(oldRecord);
    expect(newRecord).not.toBe(oldRecord);
  });
});
