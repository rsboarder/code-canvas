import type { RasterJob, RasterResult } from "../text/raster-job";
import { RasterWorkerPool } from "../text/raster-worker-pool";
import type { CodeTextMetrics } from "../text/text-metrics";

const MAX_JOBS_PER_FRAME = 4;

export class TileJobQueue {
  private readonly workerPool: RasterWorkerPool;
  private jobsPosted = 0;
  private deadline = 0;
  private jobsInFlight = 0;
  private postedTotalValue = 0;

  constructor(metrics: Pick<CodeTextMetrics, "narrowAdvance">) {
    this.workerPool = new RasterWorkerPool(metrics);
  }

  beginFrame(deadline: number): void {
    this.jobsPosted = 0;
    this.deadline = deadline;
  }

  canPost(): boolean {
    if (this.jobsPosted >= MAX_JOBS_PER_FRAME) return false;
    return this.jobsPosted === 0 || performance.now() < this.deadline;
  }

  post(job: RasterJob): void {
    this.workerPool.post(job);
    this.jobsPosted += 1;
    this.jobsInFlight += 1;
    this.postedTotalValue += 1;
  }

  drainResults(out: RasterResult[]): number {
    const results = this.workerPool.drainResults();
    this.jobsInFlight = Math.max(0, this.jobsInFlight - results.length);
    out.length = results.length;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result) out[index] = result;
    }
    return results.length;
  }

  get inFlightCount(): number {
    return this.jobsInFlight;
  }

  get postedTotal(): number {
    return this.postedTotalValue;
  }

  rasterError(): string | undefined {
    return this.workerPool.rasterError();
  }

  onResult(callback: () => void): void {
    this.workerPool.onResult(callback);
  }

  dispose(): void {
    this.workerPool.dispose();
  }
}
