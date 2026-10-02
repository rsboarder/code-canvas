import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RasterResult,
  RasterWorkerErrorMessage,
  RasterWorkerResponse,
} from "./raster-job";
import { RasterWorkerPool } from "./raster-worker-pool";

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  static postCount = 0;
  static terminateCount = 0;
  onmessage: ((event: MessageEvent<RasterWorkerResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(): void {
    FakeWorker.postCount += 1;
  }

  terminate(): void {
    FakeWorker.terminateCount += 1;
  }

  emit(result: RasterResult): void {
    this.onmessage?.({
      data: { type: "rasterResult", result },
    } as MessageEvent<RasterWorkerResponse>);
  }

  emitWorkerError(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  emitJobFailure(message: string): void {
    this.onmessage?.({
      data: { type: "rasterError", message } satisfies RasterWorkerErrorMessage,
    } as MessageEvent<RasterWorkerResponse>);
  }
}

function result(tileKey: string): RasterResult {
  return {
    tileKey,
    contentVersion: 1,
    rasterScale: 1,
    bitmap: {} as ImageBitmap,
  };
}

describe("RasterWorkerPool", () => {
  afterEach(() => {
    FakeWorker.instances.length = 0;
    FakeWorker.postCount = 0;
    FakeWorker.terminateCount = 0;
    vi.unstubAllGlobals();
  });

  it("drains results in order and clears the previous buffer on reuse", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const pool = new RasterWorkerPool({ narrowAdvance: 8 }, 1);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fake worker was not created");

    worker.emit(result("first"));
    worker.emit(result("second"));
    const firstDrain = pool.drainResults();
    expect(firstDrain.map((item) => item.tileKey)).toEqual(["first", "second"]);

    worker.emit(result("third"));
    const secondDrain = pool.drainResults();
    expect(secondDrain.map((item) => item.tileKey)).toEqual(["third"]);
    expect(firstDrain).toEqual([]);
    pool.dispose();
  });

  it("records a worker error and schedules the next tick", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const onNeedsRedraw = vi.fn();
    const pool = new RasterWorkerPool({ narrowAdvance: 8 }, 1);
    pool.onResult(onNeedsRedraw);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fake worker was not created");

    worker.emitWorkerError("worker stopped");

    expect(pool.rasterError()).toBe("worker stopped");
    expect(onNeedsRedraw).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it("records a worker job failure and schedules the next tick", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const onNeedsRedraw = vi.fn();
    const pool = new RasterWorkerPool({ narrowAdvance: 8 }, 1);
    pool.onResult(onNeedsRedraw);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fake worker was not created");

    worker.emitJobFailure("tile rasterization failed");

    expect(pool.rasterError()).toBe("tile rasterization failed");
    expect(onNeedsRedraw).toHaveBeenCalledTimes(1);
    pool.dispose();
  });
});
