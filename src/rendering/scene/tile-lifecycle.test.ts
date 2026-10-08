import { describe, expect, it } from "vitest";

import {
  encodeRasterCells,
  type RasterJob,
  type RasterResult,
} from "../text/raster-job";
import type { SlotAcquireResult } from "./tile-slot-allocator";
import { TileLifecycle } from "./tile-lifecycle";
import { CONTENT_KIND, WidgetTiles } from "./widget-tile-set";

class FakePool {
  readonly released: string[] = [];

  private readonly slots = new Map<string, { pinned: boolean; used: number }>();

  private readonly cellKeys = new Set<string>();

  private tick = 0;

  constructor(private readonly capacity: number) {}

  touch(key: string): void {
    const slot = this.slots.get(key);
    if (slot) slot.used = ++this.tick;
  }

  setPinned(key: string, pinned: boolean): void {
    const slot = this.slots.get(key);
    if (slot) slot.pinned = pinned;
  }

  isPinned(key: string): boolean {
    return this.slots.get(key)?.pinned ?? false;
  }

  acquire(key: string, pinned: boolean, cell: boolean): SlotAcquireResult {
    if (cell) this.cellKeys.add(key);
    const existing = this.slots.get(key);
    if (existing) {
      existing.pinned = pinned;
      existing.used = ++this.tick;
      return { slot: 0, evictedKey: undefined };
    }
    if (this.slots.size < this.capacity) {
      this.slots.set(key, { pinned, used: ++this.tick });
      return { slot: this.slots.size - 1, evictedKey: undefined };
    }
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [candidate, slot] of this.slots) {
      if (!slot.pinned && slot.used < oldest) {
        oldestKey = candidate;
        oldest = slot.used;
      }
    }
    if (!oldestKey) return { slot: -1, evictedKey: undefined };
    this.slots.delete(oldestKey);
    this.slots.set(key, { pinned, used: ++this.tick });
    return { slot: 0, evictedKey: oldestKey };
  }

  release(key: string): void {
    this.released.push(key);
    this.slots.delete(key);
    this.cellKeys.delete(key);
  }

  upload(key: string, bitmap: ImageBitmap): boolean {
    return bitmap.width > 0 && this.slots.has(key);
  }
}

class FakeQueue {
  readonly jobs: RasterJob[] = [];

  readonly results: RasterResult[] = [];

  private jobsPosted = 0;

  private inFlight = 0;

  get inFlightCount(): number {
    return this.inFlight;
  }

  get postedTotal(): number {
    return this.jobs.length;
  }

  beginFrame(): void {
    this.jobsPosted = 0;
  }

  canPost(): boolean {
    return this.jobsPosted < 4;
  }

  post(job: RasterJob): void {
    this.jobs.push({ ...job });
    this.jobsPosted += 1;
    this.inFlight += 1;
  }

  drainResults(out: RasterResult[]): number {
    out.length = this.results.length;
    for (let index = 0; index < this.results.length; index += 1) {
      const result = this.results[index];
      if (result) out[index] = result;
    }
    const count = this.results.length;
    this.results.length = 0;
    this.inFlight = Math.max(0, this.inFlight - count);
    return count;
  }

  dispose(): void {
    this.results.length = 0;
  }
}

const SOURCE = {
  fileId: "file-a",
  filePath: "src/a.ts",
  hasText: true,
  contentVersion: 1,
  highlighted: false,
  contentWidth: 1024,
  contentHeight: 1024,
  palette: ["#fff"],
  baseline: 14,
  lineHeight: 18,
  backgroundColor: "#000",
  headerBackgroundColor: "#111",
  cellsFor: () => encodeRasterCells([]),
  headerCellsFor: () => encodeRasterCells([]),
  label: {
    identity: "label-a",
    x: 0,
    y: 0,
    width: 120,
    height: 18,
    jobFor: () => ({
      cells: [],
      font: "16px Menlo",
      baseline: 14,
      lineHeight: 18,
      originY: 0,
      backgroundColor: "transparent",
      palette: ["#fff"],
      outlineColor: "#000",
      outlineWidth: 1,
    }),
  },
};

function createFixture(
  capacity = 4,
  poolCapacity = capacity,
): {
  lifecycle: TileLifecycle;
  widget: WidgetTiles;
  queue: FakeQueue;
  pool: FakePool;
} {
  const pool = new FakePool(poolCapacity);
  const queue = new FakeQueue();
  const lifecycle = new TileLifecycle({
    pool,
    jobQueue: queue,
    rasterFont: "16px Code",
  });
  const widget = new WidgetTiles("file-a", capacity);
  widget.setContentSource(SOURCE);
  lifecycle.attach(widget);
  return { lifecycle, widget, queue, pool };
}

function request(widget: WidgetTiles, column: number): void {
  widget.plan.requestCount = 1;
  widget.plan.requestScales[0] = 1;
  widget.plan.requestColumns[0] = column;
  widget.plan.requestRows[0] = 0;
}

function resultFor(job: RasterJob, close: () => void): RasterResult {
  return {
    tileKey: job.tileKey,
    contentVersion: job.contentVersion,
    rasterScale: job.rasterScale,
    bitmap: { width: 512, height: 512, close },
  };
}

function emitLatest(queue: FakeQueue, close: () => void): void {
  const job = queue.jobs[queue.jobs.length - 1];
  if (!job) throw new Error("Expected a raster job.");
  queue.results.push(resultFor(job, close));
}

describe("TileLifecycle", () => {
  it("acquires a slot, evicts the old key, and releases the current record", () => {
    const { lifecycle, widget, queue } = createFixture(2, 1);
    request(widget, 0);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    const first = widget.tileRecords.findRecord(CONTENT_KIND, 1, 0, 0);
    const firstKey = widget.tileRecords.keys[first];
    emitLatest(queue, () => undefined);
    expect(lifecycle.drainResults()).toBe(1);
    expect(widget.tileRecords.records.ready[first]).toBe(1);

    request(widget, 1);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    expect(widget.tileRecords.findRecordByKey(firstKey ?? "")).toBe(-1);
    const second = widget.tileRecords.findRecord(CONTENT_KIND, 1, 1, 0);
    expect(widget.tileRecords.pending[second]).toBe(1);

    lifecycle.detach(widget);
    expect(widget.tileRecords.records.active[second]).toBe(0);
  });

  it("releases the first available record when record capacity is exhausted", () => {
    const { lifecycle, widget, queue, pool } = createFixture(1);
    request(widget, 0);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    const first = widget.tileRecords.findRecord(CONTENT_KIND, 1, 0, 0);
    const firstKey = widget.tileRecords.keys[first];
    emitLatest(queue, () => undefined);
    lifecycle.drainResults();

    request(widget, 1);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);

    expect(firstKey).toBeDefined();
    expect(pool.released).toContain(firstKey);
    expect(widget.tileRecords.findRecord(CONTENT_KIND, 1, 1, 0)).toBe(0);
  });
});

describe("TileLifecycle pinning", () => {
  it("keeps a pinned visible tile when the pool has no evictable slot", () => {
    const { lifecycle, widget, queue } = createFixture(2, 1);
    request(widget, 0);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    emitLatest(queue, () => undefined);
    lifecycle.drainResults();
    const first = widget.tileRecords.findRecord(CONTENT_KIND, 1, 0, 0);
    widget.drawSet.drawCurrent[0] = first;
    widget.drawSet.drawCurrentCount = 1;
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.pin(widget);

    request(widget, 1);
    lifecycle.request(widget);
    expect(widget.tileRecords.records.ready[first]).toBe(1);
    const second = widget.tileRecords.findRecord(CONTENT_KIND, 1, 1, 0);
    expect(widget.tileRecords.pending[second]).toBe(0);
  });

  it("uploads requested header and label results as current", () => {
    const { lifecycle, widget, queue } = createFixture(4);
    widget.plan.requestLabel = true;
    widget.plan.requestHeaderCount = 1;
    widget.plan.requestHeaderColumns[0] = 0;
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);

    expect(queue.jobs[0]?.font).toBe("16px Menlo");
    for (const job of queue.jobs)
      queue.results.push(resultFor(job, () => undefined));

    expect(lifecycle.drainResults()).toBe(2);
    expect(lifecycle.staleTotal).toBe(0);
    const label = widget.tileRecords.findRecord(2, 1, 0, 0);
    const header = widget.tileRecords.findRecord(1, 1, 0, 0);
    expect(widget.tileRecords.records.ready[label]).toBe(1);
    expect(widget.tileRecords.records.ready[header]).toBe(1);
  });
});

describe("TileLifecycle source changes", () => {
  it("releases a header record when its file path changes", () => {
    const { lifecycle, widget, pool } = createFixture();
    const record = widget.tileRecords.ensureRecord(1, 1, 0, 0);
    const key = widget.tileRecords.keys[record];

    lifecycle.sourceChanged(widget, "src/b.ts", "label-a");

    expect(key).toBeDefined();
    expect(pool.released).toContain(key);
  });

  it("does not release a label record when only content changes", () => {
    const { lifecycle, widget, pool } = createFixture();
    widget.tileRecords.ensureRecord(2, 1, 0, 0);

    lifecycle.sourceChanged(widget, "src/a.ts", "label-a");

    expect(pool.released).toEqual([]);
  });

  it("does not release a label record for a layout identity change on the same path", () => {
    const { lifecycle, widget, pool } = createFixture();
    widget.tileRecords.ensureRecord(2, 1, 0, 0);

    lifecycle.sourceChanged(widget, "src/a.ts", "label-b");

    expect(pool.released).toEqual([]);
  });
});

describe("TileLifecycle results", () => {
  it("moves pending to ready, closes stale results, and uploads current results", () => {
    const { lifecycle, widget, queue } = createFixture();
    request(widget, 0);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    const record = widget.tileRecords.findRecord(CONTENT_KIND, 1, 0, 0);
    expect(widget.tileRecords.pending[record]).toBe(1);
    let closed = 0;
    emitLatest(queue, () => {
      closed += 1;
    });
    expect(lifecycle.drainResults()).toBe(1);
    expect(widget.tileRecords.records.ready[record]).toBe(1);
    expect(widget.tileRecords.pending[record]).toBe(0);
    expect(closed).toBe(1);

    request(widget, 1);
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    const stale = widget.tileRecords.findRecord(CONTENT_KIND, 1, 1, 0);
    widget.setContentSource({ ...SOURCE, contentVersion: 2 });
    let staleClosed = 0;
    emitLatest(queue, () => {
      staleClosed += 1;
    });
    expect(lifecycle.drainResults()).toBe(0);
    expect(staleClosed).toBe(1);
    expect(widget.tileRecords.records.active[stale]).toBe(0);
  });
});
