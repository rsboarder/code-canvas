import type { IGrammar, StateStack } from "vscode-textmate";

// Pure algorithms for the D7/D8 "100 ms after exiting editing" question:
// given a per-line rule-stack cache built once, how cheap is it to resume
// tokenization from an edited line versus rescanning from the file start?
// No Vite-specific imports here (no `?url`/`?raw`) so this module loads
// unchanged in both the worker (Vite/browser) and a plain Node script.

const WINDOW_LINES = 60;
const CHUNK_SIZE = 100;

export interface ChunkTiming {
  startLine: number;
  endLine: number;
  ms: number;
}

export interface ColdWindowResult {
  linesTokenized: number;
  ms: number;
}

export interface IncrementalEditResult {
  editLine: number;
  linesRetokenized: number;
  converged: boolean;
  reachedWindowBound: boolean;
  incrementalMs: number;
  fullRescanMs: number;
}

export interface FileIncrementalMeasurement {
  fileId: string;
  lineCount: number;
  coldFirstWindow: ColdWindowResult;
  editAt10: IncrementalEditResult;
  editAt1000: IncrementalEditResult;
  chunkTimings: ChunkTiming[];
}

// Simulates the smallest realistic post-edit re-highlight case — the user
// typed one character at the start of a line's content — rather than an
// adversarial worst case. This is exactly the scenario design D7/D8's
// "100 ms after exiting editing" budget targets.
export function simulateSingleCharacterEdit(line: string): string {
  const leadingWhitespaceMatch = /^\s*/u.exec(line);
  const leadingWhitespace = leadingWhitespaceMatch
    ? leadingWhitespaceMatch[0]
    : "";
  return `${leadingWhitespace} ${line.slice(leadingWhitespace.length)}`;
}

// The per-line rule-stack cache: the entry state (state stack *before*
// tokenizing that line) for every line of a cold, full-file tokenization.
export function buildEntryStateCache(
  lines: string[],
  grammar: IGrammar,
): (StateStack | null)[] {
  const entryStates: (StateStack | null)[] = Array.from(
    { length: lines.length },
    () => null,
  );
  let state: StateStack | null = null;
  for (let line = 0; line < lines.length; line += 1) {
    entryStates[line] = state;
    const result = grammar.tokenizeLine2(lines[line] ?? "", state);
    state = result.ruleStack;
  }
  return entryStates;
}

export function measureColdFirstWindow(
  lines: string[],
  grammar: IGrammar,
  windowLines: number = WINDOW_LINES,
): ColdWindowResult {
  const limit = Math.min(windowLines, lines.length);
  const startedAt = performance.now();
  let state: StateStack | null = null;
  for (let line = 0; line < limit; line += 1) {
    const result = grammar.tokenizeLine2(lines[line] ?? "", state);
    state = result.ruleStack;
  }
  return { linesTokenized: limit, ms: performance.now() - startedAt };
}

// Resumes from the cached entry state at `editLine`, re-tokenizing forward
// with the single-character-edited line substituted at `editLine`, and
// stops as soon as a later line's resulting end state matches what the
// original cold pass cached as that line's entry state (everything after
// that point is guaranteed unchanged) — or after `windowLines` lines,
// whichever comes first. Also measures a full-rescan-from-line-0 baseline
// over the same span, to quantify the cache's savings.
export function measureIncrementalEdit(
  originalLines: string[],
  grammar: IGrammar,
  entryStates: (StateStack | null)[],
  editLine: number,
  windowLines: number = WINDOW_LINES,
): IncrementalEditResult {
  const editedLine = simulateSingleCharacterEdit(originalLines[editLine] ?? "");
  const windowEnd = Math.min(editLine + windowLines, originalLines.length);

  const incrementalStartedAt = performance.now();
  let state: StateStack | null = entryStates[editLine] ?? null;
  let line = editLine;
  let converged = false;
  while (line < windowEnd) {
    const text = line === editLine ? editedLine : (originalLines[line] ?? "");
    const result = grammar.tokenizeLine2(text, state);
    state = result.ruleStack;
    const nextLine = line + 1;
    const cachedNextEntry = entryStates[nextLine];
    if (
      line > editLine &&
      nextLine < entryStates.length &&
      cachedNextEntry !== undefined &&
      cachedNextEntry !== null &&
      state.equals(cachedNextEntry)
    ) {
      converged = true;
      line = nextLine;
      break;
    }
    line = nextLine;
  }
  const incrementalMs = performance.now() - incrementalStartedAt;

  const fullRescanStartedAt = performance.now();
  let rescanState: StateStack | null = null;
  for (let rescanLine = 0; rescanLine < line; rescanLine += 1) {
    const text =
      rescanLine === editLine ? editedLine : (originalLines[rescanLine] ?? "");
    const result = grammar.tokenizeLine2(text, rescanState);
    rescanState = result.ruleStack;
  }
  const fullRescanMs = performance.now() - fullRescanStartedAt;

  return {
    editLine,
    linesRetokenized: line - editLine,
    converged,
    reachedWindowBound: !converged && line >= windowEnd,
    incrementalMs,
    fullRescanMs,
  };
}

// Per-100-line chunk cost over the whole file, carrying state across
// chunks — the granularity at which a worker could yield/cancel between
// chunks of a chunked, resumable tokenization pass.
export function measureChunkTimings(
  lines: string[],
  grammar: IGrammar,
  chunkSize: number = CHUNK_SIZE,
): ChunkTiming[] {
  const timings: ChunkTiming[] = [];
  let state: StateStack | null = null;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, lines.length);
    const startedAt = performance.now();
    for (let line = start; line < end; line += 1) {
      const result = grammar.tokenizeLine2(lines[line] ?? "", state);
      state = result.ruleStack;
    }
    timings.push({
      startLine: start,
      endLine: end,
      ms: performance.now() - startedAt,
    });
  }
  return timings;
}

export function measureFileIncremental(
  fileId: string,
  lines: string[],
  grammar: IGrammar,
): FileIncrementalMeasurement {
  const entryStates = buildEntryStateCache(lines, grammar);
  const coldFirstWindow = measureColdFirstWindow(lines, grammar);
  const editAt10 = measureIncrementalEdit(
    lines,
    grammar,
    entryStates,
    Math.min(10, lines.length - 1),
  );
  const editAt1000 = measureIncrementalEdit(
    lines,
    grammar,
    entryStates,
    Math.min(1000, lines.length - 1),
  );
  const chunkTimings = measureChunkTimings(lines, grammar);
  return {
    fileId,
    lineCount: lines.length,
    coldFirstWindow,
    editAt10,
    editAt1000,
    chunkTimings,
  };
}
