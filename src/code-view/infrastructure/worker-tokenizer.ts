import type {
  LineRange,
  TokenizedLines,
  Tokenizer,
} from "../application/document-residency";

interface TokenResponse extends TokenizedLines {
  readonly type: "tokens";
}

export class WorkerTokenizer implements Tokenizer {
  private readonly worker: Worker;
  private readonly listeners = new Set<(result: TokenizedLines) => void>();

  constructor() {
    this.worker = new Worker(
      new URL("./tokenizer.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (event: MessageEvent<TokenResponse>) => {
      this.listeners.forEach((listener) => {
        listener(event.data);
      });
    };
  }

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    this.worker.postMessage({
      type: "contentChanged",
      fileId,
      contentVersion,
      text,
    });
  }

  wanted(fileId: string, lineRanges: readonly LineRange[]): void {
    this.worker.postMessage({ type: "wanted", fileId, lineRanges });
  }

  subscribe(listener: (result: TokenizedLines) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.worker.terminate();
    this.listeners.clear();
  }
}
