import { describe, expect, it } from "vitest";

import { encodeRasterCells } from "../../text/raster-job";
import type { RasterJob, RasterResult } from "../../text/raster-job";
import { Camera } from "../../../board/index";
import type { SlotAcquireResult } from "../tile-slot-allocator";
import { TileLifecycle } from "../tile-lifecycle";
import { CONTENT_KIND, HEADER_KIND, WidgetTiles } from "./index";
import { gestureStepRasterScale } from "./text-tile-raster-scale-rule";

class FakePool {
  private readonly keys = new Set<string>();

  touch(): void {
    return;
  }

  setPinned(): void {
    return;
  }

  isPinned(): boolean {
    return false;
  }

  acquire(key: string): SlotAcquireResult {
    this.keys.add(key);
    return { slot: 0, evictedKey: undefined };
  }

  release(key: string): void {
    this.keys.delete(key);
  }

  upload(key: string, bitmap: ImageBitmap): boolean {
    return bitmap.width > 0 && this.keys.has(key);
  }
}

class FakeQueue {
  readonly jobs: RasterJob[] = [];

  readonly results: RasterResult[] = [];

  readonly inFlightCount = 0;

  get postedTotal(): number {
    return this.jobs.length;
  }

  beginFrame(): void {
    return;
  }

  canPost(): boolean {
    return true;
  }

  post(job: RasterJob): void {
    this.jobs.push({ ...job });
  }

  drainResults(out: RasterResult[]): number {
    out.length = this.results.length;
    for (let index = 0; index < this.results.length; index += 1) {
      const result = this.results[index];
      if (result) out[index] = result;
    }
    const count = this.results.length;
    this.results.length = 0;
    return count;
  }

  dispose(): void {
    return;
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
};

function preparedWidget(): WidgetTiles {
  const widget = new WidgetTiles("file-a", 32);
  widget.frame.width = 512;
  widget.frame.height = 512;
  widget.visibleWindow.right = 512;
  widget.visibleWindow.bottom = 512;
  widget.setContentSource(SOURCE);
  return widget;
}

function prepareWidget(
  widget: WidgetTiles,
  gestureActive: boolean,
  cameraScale: number,
  settledZoom: number,
): void {
  const input = widget.prepareInput;
  input.camera = new Camera({ x: 0, y: 0 }, cameraScale);
  input.viewport.width = 512;
  input.viewport.height = 512;
  input.viewport.devicePixelRatio = 2;
  input.bodyTop = 42;
  input.contentScroll = 0;
  input.minimapActive = false;
  input.textWanted = true;
  input.zoomGestureActive = gestureActive;
  input.textPrefetchActive = false;
  input.textPrefetchZoom = 0;
  input.zoomFocusX = 256;
  input.zoomFocusY = 256;
  input.zoomOut = false;
  input.document = false;
  input.settledZoom = settledZoom;
  widget.prepare(input);
}

function resultFor(job: RasterJob): RasterResult {
  return {
    tileKey: job.tileKey,
    contentVersion: job.contentVersion,
    rasterScale: job.rasterScale,
    bitmap: { width: 512, height: 512, close: () => undefined },
  };
}

describe("WidgetTiles entry point", () => {
  it("uses the camera scale during a gesture and settled zoom otherwise", () => {
    const widget = preparedWidget();

    prepareWidget(widget, false, 1.7, 1.25);
    expect(widget.requestScale(CONTENT_KIND)).toBe(2.5);

    prepareWidget(widget, true, 1.7, 1.25);
    expect(widget.requestScale(CONTENT_KIND)).toBe(
      gestureStepRasterScale(1.7, 2),
    );
  });
});

describe("WidgetTiles header draw outcome", () => {
  it("draws the step-scale header during a zoom gesture", () => {
    const widget = preparedWidget();
    prepareWidget(widget, true, 1.3, 1);
    const atRestScale = 2;
    const stepScale = gestureStepRasterScale(1.3, 2);
    const atRest = widget.tileRecords.ensureRecord(
      HEADER_KIND,
      atRestScale,
      0,
      0,
    );
    const step = widget.tileRecords.ensureRecord(HEADER_KIND, stepScale, 0, 0);
    widget.tileRecords.setState(atRest, "ready", true);
    widget.tileRecords.setState(step, "ready", true);

    prepareWidget(widget, true, 1.3, 1);

    expect(
      Array.from(
        widget.drawSet.drawHeaderCurrent.slice(
          0,
          widget.drawSet.drawHeaderCurrentCount,
        ),
      ),
    ).toContain(step);
  });

  it("draws the at-rest header when the zoom gesture is inactive", () => {
    const widget = preparedWidget();
    prepareWidget(widget, false, 1.3, 1);
    const atRestScale = widget.requestScale(HEADER_KIND);
    const atRest = widget.tileRecords.ensureRecord(
      HEADER_KIND,
      atRestScale,
      0,
      0,
    );
    const step = widget.tileRecords.ensureRecord(
      HEADER_KIND,
      gestureStepRasterScale(1.3, 2),
      0,
      0,
    );
    widget.tileRecords.setState(atRest, "ready", true);
    widget.tileRecords.setState(step, "ready", true);

    prepareWidget(widget, false, 1.3, 1);

    expect(
      Array.from(
        widget.drawSet.drawHeaderCurrent.slice(
          0,
          widget.drawSet.drawHeaderCurrentCount,
        ),
      ),
    ).toEqual([atRest]);
  });
});

describe("WidgetTiles lifecycle", () => {
  it("accepts a result only while its tile remains requested", () => {
    const widget = preparedWidget();
    prepareWidget(widget, false, 1, 1);
    const pool = new FakePool();
    const queue = new FakeQueue();
    const lifecycle = new TileLifecycle({
      pool,
      jobQueue: queue,
      rasterFont: "16px Code",
    });
    lifecycle.attach(widget);
    widget.plan.requestHeaderCount = 0;
    widget.plan.requestLabel = false;
    widget.plan.requestCount = 1;
    widget.plan.requestScales[0] = 1;
    widget.plan.requestColumns[0] = 0;
    widget.plan.requestRows[0] = 0;
    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    const staleJob = queue.jobs[0];
    if (!staleJob) throw new Error("Expected a stale raster job.");

    widget.plan.requestScales[0] = 2;
    expect(staleJob.rasterScale).toBe(1);
    expect(widget.plan.isRequested(1, 0, 0, widget.epoch)).toBe(false);
    queue.results.push(resultFor(staleJob));
    expect(lifecycle.drainResults()).toBe(0);

    lifecycle.beginFrame(Number.POSITIVE_INFINITY);
    lifecycle.request(widget);
    const currentJob = queue.jobs[1];
    if (!currentJob) throw new Error("Expected a current raster job.");
    queue.results.push(resultFor(currentJob));
    expect(lifecycle.drainResults()).toBe(1);
  });
});
