import type {
  LineRange,
  TokenizedLines,
  Tokenizer,
} from "../application/document-residency/index";
import type { WantedLines } from "./tokenization-engine";

interface ContentChangedRequest {
  readonly type: "contentChanged";
  readonly fileId: string;
  readonly contentVersion: number;
  readonly text: string;
}

interface RankRequest {
  readonly type: "rank";
  readonly wanted: readonly WantedLines[];
}

interface TokenResponse extends TokenizedLines {
  readonly type: "tokens";
}

export interface WorkerTokenizerPoolOptions {
  readonly size: number;
  readonly createWorker: () => Worker;
}

export function tokenizerPoolSize(hardwareConcurrency: number): number {
  return Math.max(1, Math.min(6, hardwareConcurrency - 2));
}

export function createTokenizerWorker(): Worker {
  return new Worker(new URL("./tokenizer.worker.ts", import.meta.url), {
    type: "module",
  });
}

export class WorkerTokenizerPool implements Tokenizer {
  private readonly workers: Worker[];
  private readonly fileWorkers = new Map<string, Worker>();
  private readonly listeners = new Set<(result: TokenizedLines) => void>();
  private readonly pendingWanted = new Map<Worker, WantedLines[]>();
  private nextWorker = 0;
  private rankingScheduled = false;
  private disposed = false;

  constructor(options: WorkerTokenizerPoolOptions) {
    this.workers = Array.from({ length: options.size }, () =>
      options.createWorker(),
    );
    this.workers.forEach((worker) => {
      worker.onmessage = (event: MessageEvent<TokenResponse>) => {
        this.listeners.forEach((listener) => {
          listener(event.data);
        });
      };
    });
  }

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    if (this.disposed) return;
    const worker = this.workerFor(fileId);
    const request: ContentChangedRequest = {
      type: "contentChanged",
      fileId,
      contentVersion,
      text,
    };
    worker.postMessage(request);
  }

  wanted(fileId: string, lineRanges: readonly LineRange[]): void {
    if (this.disposed) return;
    const worker = this.fileWorkers.get(fileId);
    if (!worker) return;
    const wanted = this.pendingWanted.get(worker) ?? [];
    wanted.push({ fileId, lineRanges });
    this.pendingWanted.set(worker, wanted);
    if (this.rankingScheduled) return;
    this.rankingScheduled = true;
    queueMicrotask(() => {
      this.flushRanking();
    });
  }

  subscribe(listener: (result: TokenizedLines) => void): () => void {
    if (this.disposed)
      return () => {
        return;
      };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workers.forEach((worker) => {
      worker.terminate();
    });
    this.listeners.clear();
    this.fileWorkers.clear();
    this.pendingWanted.clear();
  }

  private workerFor(fileId: string): Worker {
    const existing = this.fileWorkers.get(fileId);
    if (existing) return existing;
    const worker = this.workers[this.nextWorker % this.workers.length];
    if (!worker) throw new Error("Tokenizer worker pool is empty.");
    this.nextWorker += 1;
    this.fileWorkers.set(fileId, worker);
    return worker;
  }

  private flushRanking(): void {
    this.rankingScheduled = false;
    this.workers.forEach((worker) => {
      const request: RankRequest = {
        type: "rank",
        wanted: this.pendingWanted.get(worker) ?? [],
      };
      worker.postMessage(request);
    });
    this.pendingWanted.clear();
  }
}
