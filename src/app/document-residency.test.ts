import { describe, expect, it } from "vitest";

import {
  DocumentResidency,
  type DocumentResidencyOptions,
  type GpuUploader,
  type LineRange,
  type LineWindow,
  type MinimapUpload,
  type TokenizedLines,
  type Tokenizer,
} from "../code-view/application/document-residency/index";
import {
  SynchronousTokenizer as InfrastructureTokenizer,
  type SynchronousTokenizerOptions,
} from "../code-view/infrastructure/synchronous-tokenizer";
import type {
  GrammarState,
  LineGrammar,
  TokenizationEngineOptions,
} from "../code-view/infrastructure/tokenization-engine";

const metrics = {
  narrowAdvance: 10,
  tabSize: 4,
  baseline: 15,
  lineHeight: 20,
  advanceFor: (cluster: string) =>
    (cluster.codePointAt(0) ?? 0) > 0x7f ? 17 : 10,
};

interface MutableLineRange {
  start: number;
  end: number;
}

class WordState implements GrammarState {
  equals(other: GrammarState): boolean {
    return other instanceof WordState;
  }
}

class WordGrammar implements LineGrammar {
  tokenizeLine2(
    line: string,
    state: GrammarState | null,
  ): { readonly tokens: Uint32Array; readonly ruleStack: GrammarState } {
    const values: number[] = [];
    const words = /\S+/gu;
    let match = words.exec(line);
    while (match) {
      values.push(match.index, colorOf(match[0]));
      match = words.exec(line);
    }
    if (values.length === 0) values.push(0, 0);
    return {
      tokens: new Uint32Array(values),
      ruleStack: state instanceof WordState ? state : new WordState(),
    };
  }
}

class SynchronousTokenizer implements Tokenizer {
  readonly wantedCalls: { fileId: string; ranges: readonly LineRange[] }[] = [];
  private readonly inner: InfrastructureTokenizer;

  constructor(options: SynchronousTokenizerOptions = tokenizerOptions()) {
    this.inner = new InfrastructureTokenizer(options);
  }

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    this.inner.contentChanged(fileId, contentVersion, text);
  }

  wanted(fileId: string, lineRanges: readonly LineRange[]): void {
    this.wantedCalls.push({ fileId, ranges: lineRanges });
    this.inner.wanted(fileId, lineRanges);
  }

  subscribe(listener: (result: TokenizedLines) => void): () => void {
    return this.inner.subscribe((result) => {
      listener(toResidencyResult(result));
    });
  }

  step(): TokenizedLines | undefined {
    const result = this.inner.step();
    return result ? toResidencyResult(result) : undefined;
  }

  deliver(result: TokenizedLines): void {
    this.inner.deliver(result);
  }

  flush(): number {
    return this.inner.flush();
  }
}

function tokenizerOptions(): SynchronousTokenizerOptions {
  const engineOptions: TokenizationEngineOptions = {
    grammarFor: () => new WordGrammar(),
    foregroundOf: (metadata) => metadata,
    chunkLines: 100,
  };
  return engineOptions;
}

function colorOf(word: string): number {
  return (word.codePointAt(0) ?? 0) % 10;
}

class RecordingUploader implements GpuUploader {
  readonly calls: {
    kind: "window" | "minimap";
    fileId: string;
    highlighted?: boolean;
  }[] = [];
  readonly windows: LineWindow[] = [];
  readonly minimaps: MinimapUpload[] = [];

  uploadLineWindow(window: LineWindow): void {
    this.calls.push({
      kind: "window",
      fileId: window.fileId,
      highlighted: window.highlighted,
    });
    this.windows.push(snapshotWindow(window));
  }

  uploadMinimap(minimap: MinimapUpload): void {
    this.calls.push({ kind: "minimap", fileId: minimap.fileId });
    this.minimaps.push({ ...minimap, bytes: new Uint8Array(minimap.bytes) });
  }
}

describe("DocumentResidency", () => {
  it(
    "uploads single-colour text, then a highlighted window and minimap",
    singleColourTest,
  );
  it("drops a stale response after a newer content version", staleVersionTest);
  it(
    "ranks priority before visible files and clears removed files",
    rankingTest,
  );
  it("resumes line work at the budget boundary", budgetTest);
  it("reports whether budget work remains", drainContinuationTest);
  it("exempts the priority file from the budget", priorityTest);
  it(
    "continues visible work after a visible priority file",
    visiblePriorityTest,
  );
  it(
    "prioritizes an invisible file without building its window",
    invisiblePriorityTest,
  );
  it("rebuilds when scrolling outside the current window", scrollingTest);
  it(
    "fast scrolling draws the loaded window while lines are still being loaded",
    fastScrollingTest,
  );
  it("backlogDepth counts queued minimaps", minimapBacklogTest);
  it(
    "counts files whose current content version lacks a minimap",
    tokenizationPendingTest,
  );
  it(
    "rebuilds when a reused visible range is mutated in place",
    reusedRangeTest,
  );
  it(
    "keeps visible windows ahead of minimaps across a 200-file flood",
    floodTest,
  );
});

function singleColourTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const options: DocumentResidencyOptions = { tokenizer, lineMetrics: metrics };
  const residency = new DocumentResidency(options);
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(300));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 40 }]]]));
  residency.drain(Infinity, uploader);
  expect(uploader.windows[0]?.lines).toHaveLength(80);
  expect(uploader.windows[0]?.highlighted).toBe(false);
  expect(
    [...(uploader.windows[0]?.cellColors ?? [])].every((color) => color === 0),
  ).toBe(true);
  expect(uploader.windows[0]?.cellStarts[0]).toBe(0);
  expect(uploader.windows[0]?.cellEnds[0]).toBe(1);
  expect(uploader.windows[0]?.cellXs[0]).toBe(0);
  tokenizer.flush();
  residency.drain(Infinity, uploader);
  expect(uploader.windows[1]?.highlighted).toBe(true);
  expect(uploader.windows[1]?.cellColors[0]).toBe(10);
  expect(uploader.minimaps).toHaveLength(1);
}

function staleVersionTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(4));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 2 }]]]));
  const held = tokenizer.step();
  if (!held) throw new Error("Expected a version 1 result");
  residency.contentChanged("A", 2, lines(4, "new"));
  tokenizer.deliver(held);
  residency.drain(Infinity, uploader);
  expect(uploader.windows[0]?.contentVersion).toBe(2);
  expect(uploader.windows[0]?.highlighted).toBe(false);
  expect(uploader.minimaps).toHaveLength(0);
  tokenizer.flush();
  residency.drain(Infinity, uploader);
  expect(uploader.windows[uploader.windows.length - 1]?.highlighted).toBe(true);
  expect(
    uploader.minimaps.every((minimap) => minimap.contentVersion === 2),
  ).toBe(true);
}

function rankingTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  for (const fileId of ["A", "B", "C", "D"])
    residency.contentChanged(fileId, 1, lines(10));
  tokenizer.wantedCalls.length = 0;
  residency.visibleRangesChanged(
    new Map([
      ["C", [{ start: 0, end: 2 }]],
      ["A", [{ start: 0, end: 2 }]],
    ]),
  );
  residency.prioritize("D");
  expect(callNames(tokenizer)).toEqual(["C:1", "A:1", "D:1", "C:1", "A:1"]);
  const beforeRepeat = tokenizer.wantedCalls.length;
  residency.visibleRangesChanged(
    new Map([
      ["C", [{ start: 0, end: 2 }]],
      ["A", [{ start: 0, end: 2 }]],
    ]),
  );
  expect(tokenizer.wantedCalls).toHaveLength(beforeRepeat);
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 2 }]]]));
  expect(callNames(tokenizer).slice(-3)).toEqual(["D:1", "A:1", "C:0"]);
}

function budgetTest(): void {
  const tokenizer = new SynchronousTokenizer();
  let reads = 0;
  const residency = new DocumentResidency({
    tokenizer,
    lineMetrics: metrics,
    now: () => (reads += 1) * 0.25,
  });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(300));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 40 }]]]));
  for (let index = 0; index < 20 && uploader.windows.length === 0; index += 1) {
    const before = uploader.calls.length;
    residency.drain(2, uploader);
    expect(uploader.calls.length - before).toBeLessThanOrEqual(1);
  }
  expect(uploader.windows).toHaveLength(1);
  expect(uploader.windows[0]?.lines).toHaveLength(80);
}

function drainContinuationTest(): void {
  const tokenizer = new SynchronousTokenizer();
  let reads = 0;
  const residency = new DocumentResidency({
    tokenizer,
    lineMetrics: metrics,
    now: () => (reads += 1) * 0.25,
  });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(80));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 40 }]]]));

  let continued = residency.drain(2, uploader);
  expect(continued).toBe(true);
  for (
    let index = 0;
    index < 100 && uploader.windows.length === 0;
    index += 1
  ) {
    continued = residency.drain(2, uploader);
  }

  expect(uploader.windows).toHaveLength(1);
  expect(continued).toBe(false);
  expect(residency.drain(2, uploader)).toBe(false);
}

function priorityTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({
    tokenizer,
    lineMetrics: metrics,
    now: () => 0,
  });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(100));
  residency.contentChanged("B", 1, lines(100));
  residency.visibleRangesChanged(
    new Map([
      ["A", [{ start: 0, end: 40 }]],
      ["B", [{ start: 0, end: 40 }]],
    ]),
  );
  residency.prioritize("A");
  residency.drain(0, uploader);
  expect(uploader.windows.map((window) => window.fileId)).toEqual(["A"]);
}

function visiblePriorityTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(300));
  residency.contentChanged("B", 1, lines(300));
  residency.visibleRangesChanged(
    new Map([
      ["A", [{ start: 0, end: 40 }]],
      ["B", [{ start: 0, end: 40 }]],
    ]),
  );
  residency.prioritize("A");
  residency.drain(Infinity, uploader);
  expect(uploader.windows.map((window) => window.fileId)).toEqual(["A", "B"]);
}

function invisiblePriorityTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(2000));
  residency.prioritize("A");
  residency.drain(Infinity, uploader);
  expect(uploader.windows).toHaveLength(0);
  expect(tokenizer.wantedCalls[tokenizer.wantedCalls.length - 1]).toEqual({
    fileId: "A",
    ranges: [{ start: 0, end: Number.MAX_SAFE_INTEGER }],
  });
}

function toResidencyResult(
  result: Parameters<InfrastructureTokenizer["deliver"]>[0],
): TokenizedLines {
  return {
    fileId: result.fileId,
    contentVersion: result.contentVersion,
    firstLine: result.lineRange.start,
    lineRange: result.lineRange,
    runs: result.runs,
    lineRunOffsets: result.lineRunOffsets,
    ...(result.minimap ? { minimap: result.minimap } : {}),
    ...(result.minimapHeight === undefined
      ? {}
      : { minimapHeight: result.minimapHeight }),
  };
}

function scrollingTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(300));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 40 }]]]));
  residency.drain(Infinity, uploader);
  residency.visibleRangesChanged(new Map([["A", [{ start: 100, end: 140 }]]]));
  residency.drain(Infinity, uploader);
  expect(
    uploader.windows.map((window) => [window.firstLine, window.lines.length]),
  ).toEqual([
    [0, 80],
    [60, 120],
  ]);
}

function fastScrollingTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(300));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 40 }]]]));
  residency.drain(Infinity, uploader);

  residency.visibleRangesChanged(new Map([["A", [{ start: 200, end: 240 }]]]));
  residency.drain(0, uploader);

  expect(uploader.windows[uploader.windows.length - 1]?.firstLine).toBe(0);
  expect(residency.backlogDepth).toBeGreaterThanOrEqual(1);

  tokenizer.flush();
  residency.drain(Infinity, uploader);

  expect(uploader.windows[uploader.windows.length - 1]?.firstLine).toBe(160);
  expect(uploader.windows[uploader.windows.length - 1]?.lines).toHaveLength(
    120,
  );
  expect(residency.backlogDepth).toBe(0);
}

function minimapBacklogTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  residency.contentChanged("A", 1, lines(300));
  residency.visibleRangesChanged(new Map([["A", [{ start: 0, end: 40 }]]]));
  residency.drain(Infinity, uploader);
  tokenizer.flush();

  residency.drain(0, uploader);

  expect(residency.backlogDepth).toBeGreaterThanOrEqual(1);

  residency.drain(Infinity, uploader);

  expect(residency.backlogDepth).toBe(0);
}

function tokenizationPendingTest(): void {
  const tokenizer = new SynchronousTokenizer({
    ...tokenizerOptions(),
    chunkLines: 1,
  });
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  residency.contentChanged("A", 1, lines(2));
  residency.contentChanged("B", 1, lines(2));

  expect(residency.tokenizationPendingCount).toBe(2);

  const firstChunk = tokenizer.step();
  if (!firstChunk) throw new Error("Expected a tokenized chunk");
  tokenizer.deliver(firstChunk);
  expect(residency.tokenizationPendingCount).toBe(2);

  const finalChunk = tokenizer.step();
  if (!finalChunk) throw new Error("Expected a final tokenized chunk");
  tokenizer.deliver(finalChunk);
  expect(residency.tokenizationPendingCount).toBe(1);

  const secondFileChunk = tokenizer.step();
  if (!secondFileChunk) throw new Error("Expected a tokenized chunk");
  tokenizer.deliver(secondFileChunk);
  expect(residency.tokenizationPendingCount).toBe(1);

  residency.contentChanged("A", 2, lines(2, "new"));
  expect(residency.tokenizationPendingCount).toBe(2);
}

function reusedRangeTest(): void {
  const tokenizer = new SynchronousTokenizer();
  const residency = new DocumentResidency({ tokenizer, lineMetrics: metrics });
  const uploader = new RecordingUploader();
  const range: MutableLineRange = { start: 0, end: 40 };
  const ranges = new Map<string, readonly MutableLineRange[]>([["A", [range]]]);
  residency.contentChanged("A", 1, lines(300));
  residency.visibleRangesChanged(ranges);
  residency.drain(Infinity, uploader);
  range.start = 100;
  range.end = 140;
  residency.visibleRangesChanged(ranges);
  residency.drain(Infinity, uploader);
  expect(
    uploader.windows.map((window) => [window.firstLine, window.lines.length]),
  ).toEqual([
    [0, 80],
    [60, 120],
  ]);
}

function floodTest(): void {
  const tokenizer = new SynchronousTokenizer();
  let time = 0;
  const residency = new DocumentResidency({
    tokenizer,
    lineMetrics: metrics,
    now: () => (time += 0.25),
  });
  const uploader = new RecordingUploader();
  for (let index = 0; index < 200; index += 1) {
    const fileId = `file-${String(index)}`;
    residency.contentChanged(fileId, 1, lines(300, fileId));
  }
  residency.visibleRangesChanged(
    new Map([
      ["file-2", [{ start: 0, end: 40 }]],
      ["file-17", [{ start: 0, end: 40 }]],
      ["file-143", [{ start: 0, end: 40 }]],
    ]),
  );
  for (
    let index = 0;
    index < 5000 && uploader.minimaps.length < 200;
    index += 1
  ) {
    const result = tokenizer.step();
    if (result) tokenizer.deliver(result);
    residency.drain(2, uploader);
  }
  expect(uploader.minimaps).toHaveLength(200);
  expect(residency.backlogDepth).toBe(0);
  const visibleIds = ["file-2", "file-17", "file-143"];
  const firstMinimap = uploader.calls.findIndex(
    (call) => call.kind === "minimap" && !visibleIds.includes(call.fileId),
  );
  for (const fileId of visibleIds) {
    expect(
      uploader.calls.findIndex(
        (call) => call.fileId === fileId && call.highlighted,
      ),
    ).toBeLessThan(firstMinimap);
  }
}

function callNames(tokenizer: SynchronousTokenizer): string[] {
  return tokenizer.wantedCalls.map(
    (call) => `${call.fileId}:${String(call.ranges.length)}`,
  );
}

function lines(count: number, prefix = "word"): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index)} other${String(index)}`,
  ).join("\n");
}

function snapshotWindow(window: LineWindow): LineWindow {
  return {
    ...window,
    lines: [...window.lines],
    lineCellOffsets: new Uint32Array(window.lineCellOffsets),
    cellStarts: new Uint32Array(window.cellStarts),
    cellEnds: new Uint32Array(window.cellEnds),
    cellXs: new Float32Array(window.cellXs),
    cellColors: new Uint8Array(window.cellColors),
  };
}
