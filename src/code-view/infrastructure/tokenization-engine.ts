import type { LineRange } from "../application/document-residency";
import type { PackedTokenRuns } from "../domain/tokenized-document";
import { splitSourceLines } from "../../shared/domain/line-splitting";
import { buildMinimap } from "./minimap-bytes";

export interface GrammarState {
  equals(other: GrammarState): boolean;
}

export interface LineGrammar {
  tokenizeLine2(
    line: string,
    state: GrammarState | null,
  ): { readonly tokens: Uint32Array; readonly ruleStack: GrammarState };
}

export interface TokenizationEngineOptions {
  readonly grammarFor: (fileId: string) => LineGrammar;
  readonly foregroundOf: (metadata: number) => number;
  readonly chunkLines?: number;
}

export interface WantedLines {
  readonly fileId: string;
  readonly lineRanges: readonly LineRange[];
}

export interface ChunkResult extends PackedTokenRuns {
  readonly fileId: string;
  readonly contentVersion: number;
  readonly lineRange: LineRange;
  readonly minimap?: Uint8Array;
  readonly minimapHeight?: number;
}

interface CachedLine {
  readonly text: string;
  readonly inState: GrammarState | null;
  readonly outState: GrammarState;
  readonly runs: Uint32Array;
}

interface FileState {
  readonly fileId: string;
  readonly grammar: LineGrammar;
  readonly lines: string[];
  readonly cache: (CachedLine | undefined)[];
  readonly version: number;
  frontier: number;
}

export class TokenizationEngine {
  private readonly files = new Map<string, FileState>();
  private readonly fileOrder: string[] = [];
  private readonly chunkLines: number;
  private ranking: readonly WantedLines[] = [];

  constructor(private readonly options: TokenizationEngineOptions) {
    this.chunkLines = Math.max(1, Math.floor(options.chunkLines ?? 100));
  }

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    const previous = this.files.get(fileId);
    if (previous && contentVersion < previous.version) return;
    const lines = splitSourceLines(text);
    const cache = createCache(previous, lines);
    const state: FileState = {
      fileId,
      grammar: previous?.grammar ?? this.options.grammarFor(fileId),
      lines,
      cache,
      version: contentVersion,
      frontier: 0,
    };
    if (!previous) this.fileOrder.push(fileId);
    this.files.set(fileId, state);
  }

  rank(wanted: readonly WantedLines[]): void {
    this.ranking = wanted.filter(({ fileId }) => this.files.has(fileId));
  }

  step(): ChunkResult | undefined {
    const file = this.nextFile();
    if (!file) return undefined;
    const start = file.frontier;
    this.establish(file);
    if (file.frontier === start) return undefined;
    const result = packRange(file, start, file.frontier);
    if (file.frontier !== file.lines.length) return result;
    const full = start === 0 ? result : packRange(file, 0, file.lines.length);
    return {
      ...result,
      minimap: buildMinimap(file.lines, full.runs, full.lineRunOffsets),
      minimapHeight: Math.min(512, Math.max(1, file.lines.length)),
    };
  }

  get idle(): boolean {
    for (const file of this.files.values()) {
      if (file.frontier < file.lines.length) return false;
    }
    return true;
  }

  private nextFile(): FileState | undefined {
    for (const wanted of this.ranking) {
      const file = this.files.get(wanted.fileId);
      if (file && hasWantedWork(file, wanted.lineRanges)) return file;
    }
    for (const fileId of this.fileOrder) {
      const file = this.files.get(fileId);
      if (file && file.frontier < file.lines.length) return file;
    }
    return undefined;
  }

  private establish(file: FileState): void {
    let state = incomingState(file);
    let grammarCalls = 0;
    while (file.frontier < file.lines.length) {
      const lineIndex = file.frontier;
      const line = file.lines[lineIndex] ?? "";
      const cached = file.cache[lineIndex];
      if (cached?.text === line && statesEqual(state, cached.inState)) {
        state = cached.outState;
        file.frontier += 1;
        continue;
      }
      if (grammarCalls >= this.chunkLines) return;
      const tokenized = file.grammar.tokenizeLine2(line, state);
      file.cache[lineIndex] = {
        text: line,
        inState: state,
        outState: tokenized.ruleStack,
        runs: packLine(tokenized.tokens, this.options.foregroundOf),
      };
      state = tokenized.ruleStack;
      grammarCalls += 1;
      file.frontier += 1;
    }
  }
}

function createCache(
  previous: FileState | undefined,
  lines: readonly string[],
): (CachedLine | undefined)[] {
  const cache = new Array<CachedLine | undefined>(lines.length);
  if (!previous) return cache;
  const prefix = commonPrefix(previous.lines, lines);
  const suffix = commonSuffix(previous.lines, lines, prefix);
  for (let index = 0; index < prefix; index += 1) {
    cache[index] = previous.cache[index];
  }
  for (let index = 0; index < suffix; index += 1) {
    const newIndex = lines.length - suffix + index;
    const oldIndex = previous.lines.length - suffix + index;
    cache[newIndex] = previous.cache[oldIndex];
  }
  return cache;
}

function commonPrefix(
  left: readonly string[],
  right: readonly string[],
): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  ) {
    index += 1;
  }
  return index;
}

function commonSuffix(
  left: readonly string[],
  right: readonly string[],
  prefix: number,
): number {
  let count = 0;
  while (
    count < left.length - prefix &&
    count < right.length - prefix &&
    left[left.length - count - 1] === right[right.length - count - 1]
  ) {
    count += 1;
  }
  return count;
}

function incomingState(file: FileState): GrammarState | null {
  if (file.frontier === 0) return null;
  return file.cache[file.frontier - 1]?.outState ?? null;
}

function statesEqual(
  left: GrammarState | null,
  right: GrammarState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function hasWantedWork(file: FileState, ranges: readonly LineRange[]): boolean {
  return ranges.some(
    (range) => Math.min(range.end, file.lines.length) > file.frontier,
  );
}

function packLine(
  tokens: Uint32Array,
  foregroundOf: (metadata: number) => number,
): Uint32Array {
  const values: number[] = [];
  let previous = -1;
  for (let index = 0; index < tokens.length; index += 2) {
    const offset = tokens[index] ?? 0;
    const color = foregroundOf(tokens[index + 1] ?? 0);
    if (color === previous) continue;
    values.push(offset, color);
    previous = color;
  }
  if (values.length === 0) values.push(0, 0);
  if (values[0] !== 0) values[0] = 0;
  return new Uint32Array(values);
}

function packRange(file: FileState, start: number, end: number): ChunkResult {
  const values: number[] = [];
  const lineRunOffsets = new Uint32Array(end - start + 1);
  for (let index = start; index < end; index += 1) {
    lineRunOffsets[index - start] = values.length;
    const runs = file.cache[index]?.runs ?? new Uint32Array([0, 0]);
    values.push(...runs);
  }
  lineRunOffsets[end - start] = values.length;
  return {
    fileId: file.fileId,
    contentVersion: file.version,
    firstLine: start,
    lineRange: { start, end },
    runs: new Uint32Array(values),
    lineRunOffsets,
  };
}
