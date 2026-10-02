import type { CodeTextMetrics } from "./text-metrics";
import type {
  RasterJob,
  RasterResult,
  RasterWorkerRequest,
  RasterWorkerResponse,
} from "./raster-job";
import { transferListFor } from "./raster-job";
import { RasterResultQueue } from "./raster-result-queue";

// A font mismatch of more than this many CSS px between a worker's own
// `measureText` and Text Metrics' narrow advance means the worker's engine
// silently substituted a different font (D6 "Raster workers"): the app
// stops drawing text rather than show glyphs at the wrong metrics.
const FONT_CHECK_TOLERANCE_CSS_PX = 0.01;

// A pool of module workers separate from the Tokenizer's pool (D6), so a
// ~18 ms tokenization chunk never delays a visible tile.
const DEFAULT_POOL_SIZE = 2;

export class RasterWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new RasterResultQueue<RasterResult>();
  private nextWorker = 0;
  private rasterErrorMessage: string | undefined;
  private resultCallback: (() => void) | undefined;

  constructor(
    metrics: Pick<CodeTextMetrics, "narrowAdvance">,
    poolSize = DEFAULT_POOL_SIZE,
  ) {
    for (let index = 0; index < poolSize; index += 1) {
      const worker = new Worker(
        new URL("./raster.worker.ts", import.meta.url),
        {
          type: "module",
        },
      );
      worker.onmessage = (event: MessageEvent<RasterWorkerResponse>) => {
        this.handleMessage(event.data, metrics.narrowAdvance);
      };
      worker.onerror = (event) => {
        this.recordError(event.message || "Raster worker failed.");
      };
      this.workers.push(worker);
    }
  }

  post(job: RasterJob): void {
    if (this.workers.length === 0) return;
    const worker = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker += 1;
    const request: RasterWorkerRequest = { type: "raster", job };
    worker?.postMessage(request, transferListFor(job.cells));
  }

  // The worker's message handler only queues the result (D7 "GpuUploader":
  // "a worker's message handler only queues the result"); the GL upload
  // happens when the caller drains this within its own time budget.
  drainResults(): RasterResult[] {
    return this.pending.drain();
  }

  rasterError(): string | undefined {
    return this.rasterErrorMessage;
  }

  // The FrameLoop only ticks while dirty or gesturing (design D8): a worker
  // reply arrives asynchronously, outside any tick, so without this the loop
  // can go idle with a result sitting in `pending` forever. Called on every
  // message (`rasterResult` and `fontCheck` alike) to schedule the next tick
  // that will actually drain and draw it — scheduling only, no GL or upload
  // work happens here (D7 "a worker's message handler only queues the
  // result").
  onResult(callback: () => void): void {
    this.resultCallback = callback;
    if (this.rasterErrorMessage) callback();
  }

  dispose(): void {
    this.workers.forEach((worker) => {
      worker.terminate();
    });
    this.workers.length = 0;
    this.pending.clear();
  }

  private handleMessage(
    message: RasterWorkerResponse,
    expectedNarrowAdvance: number,
  ): void {
    if (message.type === "fontCheck") {
      this.checkFont(message.measuredNarrowAdvance, expectedNarrowAdvance);
      return;
    }
    if (message.type === "rasterError") {
      this.recordError(message.message);
      return;
    }
    this.pending.push(message.result);
    this.resultCallback?.();
  }

  private checkFont(measured: number, expected: number): void {
    const delta = Math.abs(measured - expected);
    if (delta > FONT_CHECK_TOLERANCE_CSS_PX) {
      this.recordError(
        `Raster worker font mismatch: measured ${String(measured)} px, ` +
          `expected ${String(expected)} px (Δ${String(delta)} px). Text is not drawn.`,
      );
    }
  }

  private recordError(message: string): void {
    if (this.rasterErrorMessage) return;
    this.rasterErrorMessage = message;
    this.resultCallback?.();
  }
}
