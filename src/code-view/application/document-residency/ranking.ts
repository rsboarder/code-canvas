import type { LineRange, Tokenizer } from "./ports";

export interface RankingDocument {
  readonly fileId: string;
  readonly visible: boolean;
  readonly wantedRange: LineRange | undefined;
}

export class Ranking {
  private previous = new Map<string, LineRange>();

  update(
    documents: Iterable<RankingDocument>,
    priorityFileId: string | undefined,
    tokenizer: Tokenizer,
  ): void {
    const all = [...documents];
    const next = this.nextRanking(all, priorityFileId);
    if (sameRanking(this.previous, next)) return;
    next.forEach((range, fileId) => {
      tokenizer.wanted(fileId, [range]);
    });
    this.previous.forEach((_range, fileId) => {
      if (!next.has(fileId)) tokenizer.wanted(fileId, []);
    });
    this.previous = next;
  }

  private nextRanking(
    documents: readonly RankingDocument[],
    priorityFileId: string | undefined,
  ): Map<string, LineRange> {
    const next = new Map<string, LineRange>();
    const priority = documents.find(({ fileId }) => fileId === priorityFileId);
    if (priority) {
      const range = priority.wantedRange ?? wholeFileRange();
      next.set(priority.fileId, range);
    }
    documents.forEach((document) => {
      if (!document.visible || next.has(document.fileId)) return;
      if (document.wantedRange) next.set(document.fileId, document.wantedRange);
    });
    return next;
  }
}

export function wholeFileRange(): LineRange {
  return { start: 0, end: Number.MAX_SAFE_INTEGER };
}

function sameRanking(
  previous: ReadonlyMap<string, LineRange>,
  next: ReadonlyMap<string, LineRange>,
): boolean {
  if (previous.size !== next.size) return false;
  const previousEntries = [...previous.entries()];
  const nextEntries = [...next.entries()];
  return nextEntries.every(([fileId, range], index) => {
    const previousEntry = previousEntries[index];
    if (!previousEntry) return false;
    return (
      previousEntry[0] === fileId &&
      previousEntry[1].start === range.start &&
      previousEntry[1].end === range.end
    );
  });
}
