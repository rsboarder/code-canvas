import { describe, expect, it } from "vitest";

import type {
  GrammarState,
  LineGrammar,
  TokenizationEngineOptions,
} from "./tokenization-engine";
import {
  SynchronousTokenizer,
  type SynchronousTokenizerOptions,
} from "./synchronous-tokenizer";
import type { TokenizedLines } from "../application/document-residency/index";

class FakeState implements GrammarState {
  constructor(readonly inComment: boolean) {}

  equals(other: GrammarState): boolean {
    return other instanceof FakeState && other.inComment === this.inComment;
  }
}

class CountingGrammar implements LineGrammar {
  tokenizeLine2(
    line: string,
    state: GrammarState | null,
  ): { readonly tokens: Uint32Array; readonly ruleStack: GrammarState } {
    const inComment = state instanceof FakeState && state.inComment;
    const firstWord = line.split(/\s+/u).find(Boolean) ?? "";
    return {
      tokens: new Uint32Array([
        0,
        inComment || firstWord.includes("/*") ? 7 : colorOf(firstWord),
      ]),
      ruleStack: new FakeState(
        (inComment || line.includes("/*")) && !line.includes("*/"),
      ),
    };
  }
}

function colorOf(word: string): number {
  return ((word.codePointAt(0) ?? 0) % 6) + 1;
}

function sourceLines(count: number, prefix = "line"): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index)}`,
  );
}

function tokenizerFor(
  options: Partial<SynchronousTokenizerOptions> = {},
): SynchronousTokenizer {
  const engineOptions: TokenizationEngineOptions = {
    grammarFor: () => new CountingGrammar(),
    foregroundOf: (metadata) => metadata,
    ...options,
  };
  return new SynchronousTokenizer({ ...engineOptions });
}

function text(lines: readonly string[]): string {
  return lines.join("\n");
}

function required(result: TokenizedLines | undefined): TokenizedLines {
  if (!result) throw new Error("Expected a tokenization result.");
  return result;
}

describe("SynchronousTokenizer", () => {
  it("flushes cold files in chunks and delivers the minimap on completion", () => {
    const tokenizer = tokenizerFor({ chunkLines: 100 });
    const results: TokenizedLines[] = [];
    tokenizer.subscribe((result) => results.push(result));
    tokenizer.contentChanged("cold.ts", 1, text(sourceLines(250)));

    expect(tokenizer.flush()).toBe(3);
    expect(results.map((result) => result.lineRange)).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 250 },
    ]);
    expect(results[0]?.minimap).toBeUndefined();
    expect(results[1]?.minimap).toBeUndefined();
    expect(results[2]?.minimap).toHaveLength(256 * 250);
    expect(tokenizer.flush()).toBe(0);
  });

  it("replaces the ranking only with wanted calls since the previous step", () => {
    const tokenizer = tokenizerFor({ chunkLines: 100 });
    tokenizer.contentChanged("A", 1, text(sourceLines(150, "a")));
    tokenizer.contentChanged("B", 1, text(sourceLines(160, "b")));

    tokenizer.wanted("B", [{ start: 0, end: 160 }]);
    expect(required(tokenizer.step()).fileId).toBe("B");

    tokenizer.wanted("A", [{ start: 0, end: 150 }]);
    expect(required(tokenizer.step()).fileId).toBe("A");
  });

  it("delivers only when requested and preserves subscription order", () => {
    const tokenizer = tokenizerFor();
    tokenizer.contentChanged("one.ts", 1, "one");
    const events: string[] = [];
    const first = tokenizer.subscribe(() => events.push("first"));
    tokenizer.subscribe(() => events.push("second"));

    const result = required(tokenizer.step());
    expect(events).toEqual([]);
    tokenizer.deliver(result);
    expect(events).toEqual(["first", "second"]);

    first();
    tokenizer.deliver(result);
    expect(events).toEqual(["first", "second", "second"]);
  });

  it("delivers a stepped stale result unchanged", () => {
    const tokenizer = tokenizerFor();
    tokenizer.contentChanged("stale.ts", 1, "old");
    const result = required(tokenizer.step());
    const received: TokenizedLines[] = [];
    tokenizer.subscribe((value) => received.push(value));

    tokenizer.contentChanged("stale.ts", 2, "new");
    tokenizer.deliver(result);

    expect(received).toEqual([result]);
    expect(received[0]?.contentVersion).toBe(1);
  });
});
