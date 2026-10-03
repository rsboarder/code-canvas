import type {
  LineRange,
  TokenizedLines,
  Tokenizer,
} from "../application/document-residency/index";
import {
  TokenizationEngine,
  type TokenizationEngineOptions,
  type WantedLines,
} from "./tokenization-engine";

export type SynchronousTokenizerOptions = TokenizationEngineOptions;

export class SynchronousTokenizer implements Tokenizer {
  private readonly engine: TokenizationEngine;
  private readonly listeners = new Set<(result: TokenizedLines) => void>();
  private pendingRanking: WantedLines[] = [];

  constructor(options: SynchronousTokenizerOptions) {
    this.engine = new TokenizationEngine(options);
  }

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    this.engine.contentChanged(fileId, contentVersion, text);
  }

  wanted(fileId: string, lineRanges: readonly LineRange[]): void {
    this.pendingRanking.push({ fileId, lineRanges });
  }

  subscribe(listener: (result: TokenizedLines) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  step(): TokenizedLines | undefined {
    this.applyPendingRanking();
    const result = this.engine.step();
    return result;
  }

  deliver(result: TokenizedLines): void {
    this.listeners.forEach((listener) => {
      listener(result);
    });
  }

  flush(): number {
    let count = 0;
    let result = this.step();
    while (result) {
      this.deliver(result);
      count += 1;
      result = this.step();
    }
    return count;
  }

  private applyPendingRanking(): void {
    if (this.pendingRanking.length === 0) return;
    this.engine.rank(this.pendingRanking);
    this.pendingRanking = [];
  }
}
