import { describe, expect, it } from "vitest";

import { TokenizedDocument } from "../domain/tokenized-document";
import { sourceFileId } from "../../shared/domain";
import {
  TokenizationEngine,
  type GrammarState,
  type LineGrammar,
  type TokenizationEngineOptions,
  type WantedLines,
  type ChunkResult,
} from "./tokenization-engine";

class FakeState implements GrammarState {
  constructor(readonly inComment: boolean) {}

  equals(other: GrammarState): boolean {
    return other instanceof FakeState && other.inComment === this.inComment;
  }
}

class CountingGrammar implements LineGrammar {
  calls = 0;

  tokenizeLine2(
    line: string,
    state: GrammarState | null,
  ): { readonly tokens: Uint32Array; readonly ruleStack: GrammarState } {
    this.calls += 1;
    const inComment = state instanceof FakeState && state.inComment;
    const values: number[] = [];
    let offset = 0;
    for (const word of line.split(/\s+/u).filter(Boolean)) {
      offset = line.indexOf(word, offset);
      values.push(offset, inComment || word.includes("/*") ? 7 : colorOf(word));
      offset += word.length;
    }
    if (values.length === 0) values.push(0, inComment ? 7 : 0);
    const opens = line.includes("/*");
    const closes = line.includes("*/");
    return {
      tokens: new Uint32Array(values),
      ruleStack: new FakeState((inComment || opens) && !closes),
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

function text(lines: readonly string[]): string {
  return lines.join("\n");
}

function engineFor(
  grammars = new Map<string, CountingGrammar>(),
  chunkLines = 100,
): TokenizationEngine {
  const options: TokenizationEngineOptions = {
    grammarFor: (fileId) => {
      const grammar = grammars.get(fileId) ?? new CountingGrammar();
      grammars.set(fileId, grammar);
      return grammar;
    },
    foregroundOf: (metadata) => metadata,
    chunkLines,
  };
  return new TokenizationEngine(options);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a tokenization result.");
  return value;
}

function wanted(fileId: string, end = 60): WantedLines {
  return { fileId, lineRanges: [{ start: 0, end }] };
}

function coldResult(
  fileId: string,
  version: number,
  lines: readonly string[],
): ChunkResult {
  const engine = engineFor(new Map(), lines.length);
  engine.contentChanged(fileId, version, text(lines));
  return required(engine.step());
}

function expectPackedEqual(actual: ChunkResult, expected: ChunkResult): void {
  expect(actual.runs).toEqual(expected.runs);
  expect(actual.lineRunOffsets).toEqual(expected.lineRunOffsets);
}

describe("TokenizationEngine", () => {
  it("reports cold files in grammar-call chunks and completes with a minimap", () => {
    const grammars = new Map<string, CountingGrammar>();
    const engine = engineFor(grammars);
    const fileId = sourceFileId("cold.ts");
    engine.contentChanged(fileId, 1, text(sourceLines(250)));

    const results = [
      required(engine.step()),
      required(engine.step()),
      required(engine.step()),
    ];

    expect(results.map((result) => result.lineRange)).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 250 },
    ]);
    expect(results[2]?.minimap).toHaveLength(256 * 250);
    expect(results[2]?.minimapHeight).toBe(250);
    expect(grammars.get(fileId)?.calls).toBe(250);
    results.forEach((result) => {
      expect(new TokenizedDocument(fileId, 1, result).lineCount).toBe(
        result.lineRange.end - result.lineRange.start,
      );
    });
    expect(engine.step()).toBeUndefined();
    expect(engine.idle).toBe(true);
  });

  it("advances wanted files first and replaces the ranking", () => {
    const engine = engineFor();
    engine.contentChanged("A", 1, text(sourceLines(150, "a")));
    engine.contentChanged("B", 1, text(sourceLines(160, "b")));

    engine.rank([wanted("B", 160)]);
    expect(required(engine.step()).fileId).toBe("B");

    engine.rank([{ fileId: "A", lineRanges: [{ start: 0, end: 150 }] }]);
    expect(required(engine.step()).fileId).toBe("A");
    expect(required(engine.step()).fileId).toBe("A");
    expect(required(engine.step()).fileId).toBe("B");
  });

  it("continues with background files after an oversized wanted range completes", () => {
    const engine = engineFor();
    engine.contentChanged("A", 1, text(sourceLines(30, "a")));
    engine.contentChanged("B", 1, text(sourceLines(120, "b")));

    engine.rank([wanted("A", 60)]);
    expect(required(engine.step()).fileId).toBe("A");
    const results: ChunkResult[] = [];
    while (!engine.idle) results.push(required(engine.step()));

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.fileId === "B")).toBe(true);
  });
});

describe("TokenizationEngine cache", () => {
  it("reuses a converged cache across a one-line edit", () => {
    const grammars = new Map<string, CountingGrammar>();
    const engine = engineFor(grammars);
    const fileId = sourceFileId("converged.ts");
    const lines = sourceLines(2000);
    engine.contentChanged(fileId, 1, text(lines));
    const first = required(engine.step());
    while (!engine.idle) required(engine.step());
    const calls = grammars.get(fileId)?.calls ?? 0;

    lines[1000] = "changed";
    engine.contentChanged(fileId, 2, text(lines));
    const result: ChunkResult = required(engine.step());
    const cold = coldResult(fileId, 2, lines);

    expect((grammars.get(fileId)?.calls ?? 0) - calls).toBe(1);
    expect(result.lineRange).toEqual({ start: 0, end: 2000 });
    expect(result.contentVersion).toBe(2);
    expect(result.minimapHeight).toBe(512);
    expectPackedEqual(result, cold);
    expect(result.runs.slice(0, 2)).toEqual(first.runs.slice(0, 2));
  });

  it("re-tokenizes until a changed comment state converges", () => {
    const grammars = new Map<string, CountingGrammar>();
    const engine = engineFor(grammars);
    const fileId = sourceFileId("comment.ts");
    const lines = sourceLines(40);
    lines[20] = "*/";
    engine.contentChanged(fileId, 1, text(lines));
    while (!engine.idle) required(engine.step());
    const calls = grammars.get(fileId)?.calls ?? 0;

    lines[10] = "/*";
    engine.contentChanged(fileId, 2, text(lines));
    const result = required(engine.step());
    const document = new TokenizedDocument(fileId, 2, result);
    const cold = coldResult(fileId, 2, lines);

    expect((grammars.get(fileId)?.calls ?? 0) - calls).toBe(11);
    expect(result.lineRange).toEqual({ start: 0, end: 40 });
    expectPackedEqual(result, cold);
    expect(document.colorAt(11, 0)).toBe(7);
    expect(document.colorAt(20, 0)).toBe(7);
    expect(document.colorAt(21, 0)).not.toBe(7);
  });
});

describe("TokenizationEngine line shifts", () => {
  it("re-indexes cached suffix lines after insertion and deletion", () => {
    const grammars = new Map<string, CountingGrammar>();
    const engine = engineFor(grammars);
    const fileId = sourceFileId("shifted.ts");
    const lines = sourceLines(30);
    engine.contentChanged(fileId, 1, text(lines));
    while (!engine.idle) required(engine.step());
    const calls = grammars.get(fileId)?.calls ?? 0;

    lines.splice(5, 0, "inserted-a", "inserted-b", "inserted-c");
    engine.contentChanged(fileId, 2, text(lines));
    const inserted = required(engine.step());
    expect(inserted.lineRange).toEqual({ start: 0, end: 33 });
    expectPackedEqual(inserted, coldResult(fileId, 2, lines));
    expect((grammars.get(fileId)?.calls ?? 0) - calls).toBe(3);

    lines.splice(5, 3);
    engine.contentChanged(fileId, 3, text(lines));
    const deleted = required(engine.step());
    expect(deleted.lineRange).toEqual({ start: 0, end: 30 });
    expectPackedEqual(deleted, coldResult(fileId, 3, lines));
    expect((grammars.get(fileId)?.calls ?? 0) - calls).toBe(3);
  });
});

describe("TokenizationEngine edge cases", () => {
  it("completes an empty file with one token run and a minimap", () => {
    const engine = engineFor();
    const fileId = sourceFileId("empty.ts");
    engine.contentChanged(fileId, 1, "");

    const result = required(engine.step());
    const document = new TokenizedDocument(fileId, 1, result);
    expect(result.lineRange).toEqual({ start: 0, end: 1 });
    expect(document.runCount(0)).toBe(1);
    expect(result.runs).toEqual(new Uint32Array([0, 0]));
    expect(result.minimap).toHaveLength(256);
    expect(result.minimapHeight).toBe(1);
  });

  it("ignores stale content and unknown ranked files", () => {
    const grammars = new Map<string, CountingGrammar>();
    const engine = engineFor(grammars);
    const fileId = sourceFileId("stale.ts");
    engine.contentChanged(fileId, 2, "new");
    engine.contentChanged(fileId, 1, "old");
    engine.rank([{ fileId: "unknown", lineRanges: [{ start: 0, end: 1 }] }]);

    const result = required(engine.step());
    expect(result.contentVersion).toBe(2);
    expect(result.lineRange).toEqual({ start: 0, end: 1 });
    expect(grammars.get(fileId)?.calls).toBe(1);
  });
});
