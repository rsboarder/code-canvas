import { LineLayout } from "../../domain/line-layout";
import { DrainBudget } from "./drain-budget";
import {
  LineWindowBuilder,
  RecolorWork,
  type CellColorAt,
} from "./line-window-builder";
import { Ranking, wholeFileRange, type RankingDocument } from "./ranking";
import type {
  DocumentResidencyOptions,
  GpuUploader,
  LineRange,
  LineWindow,
  MinimapUpload,
  TokenizedLines,
  Tokenizer,
} from "./ports";
import { VersionLedger, type VersionRecord } from "./version-ledger";

interface ResidencyDocument {
  readonly fileId: string;
  record: VersionRecord;
  visible: boolean;
  visibleStart: number;
  visibleEnd: number;
  plannedRange: LineRange | undefined;
  wantedRange: LineRange | undefined;
  colorAt: CellColorAt;
  layout: LineLayout | undefined;
  builder: LineWindowBuilder | undefined;
  recolor: RecolorWork | undefined;
  uploadedWindow: LineWindow | undefined;
  uploadedFrontier: number;
  minimapReady: boolean;
  minimapQueued: boolean;
}

export class DocumentResidency {
  private readonly ledger = new VersionLedger();
  private readonly documents = new Map<string, ResidencyDocument>();
  private readonly ranking = new Ranking();
  private readonly tokenizer: Tokenizer;
  private readonly now: () => number;
  private readonly lineMetrics: DocumentResidencyOptions["lineMetrics"];
  private visibleOrder: string[] = [];
  private nextVisibleOrder: string[] = [];
  private nextVisibleIndex = 0;
  private visibleOrderChanged = false;
  private windowReplanned = false;
  private readonly budget: DrainBudget;
  private readonly visibleEntry = (
    visibleRanges: readonly LineRange[],
    fileId: string,
  ): void => {
    this.visitVisibleEntry(fileId, visibleRanges);
  };
  private priorityFileId: string | undefined;
  private readonly minimapOrder: ResidencyDocument[] = [];
  private currentBacklogDepth = 0;

  constructor(options: DocumentResidencyOptions) {
    this.tokenizer = options.tokenizer;
    this.lineMetrics = options.lineMetrics;
    this.now = options.now ?? (() => performance.now());
    this.budget = new DrainBudget(this.now);
    this.tokenizer.subscribe((result) => {
      this.queueResult(result);
    });
  }

  get backlogDepth(): number {
    return this.currentBacklogDepth;
  }

  // Read by the perf bridge only; no frame stage depends on this signal.
  get tokenizationPendingCount(): number {
    let pending = 0;
    for (const record of this.ledger.values()) {
      if (!record.minimap) pending += 1;
    }
    return pending;
  }

  contentChanged(fileId: string, contentVersion: number, text: string): void {
    const record = this.ledger.replace(fileId, contentVersion, text);
    if (!record) return;
    const previous = this.documents.get(fileId);
    const document = previous ?? createDocument(fileId, record);
    this.removeMinimap(document);
    document.record = record;
    document.colorAt = createColorAt(this.ledger, document);
    document.layout = undefined;
    document.builder = undefined;
    document.recolor = undefined;
    document.uploadedWindow = undefined;
    document.uploadedFrontier = 0;
    document.minimapReady = false;
    if (!previous) this.documents.set(fileId, document);
    this.tokenizer.contentChanged(fileId, contentVersion, text);
  }

  visibleRangesChanged(
    ranges: ReadonlyMap<string, readonly LineRange[]>,
  ): void {
    this.nextVisibleIndex = 0;
    this.nextVisibleOrder.length = 0;
    this.visibleOrderChanged = false;
    this.windowReplanned = false;
    ranges.forEach(this.visibleEntry);
    let index = 0;
    while (index < this.visibleOrder.length) {
      const fileId = this.visibleOrder[index];
      if (fileId === undefined) {
        index += 1;
        continue;
      }
      if (!ranges.has(fileId)) {
        const document = this.documents.get(fileId);
        if (document) this.hideDocument(document);
      }
      index += 1;
    }
    if (this.nextVisibleIndex !== this.visibleOrder.length) {
      this.visibleOrderChanged = true;
    }
    if (!this.hasVisibleWork()) return;
    if (this.visibleOrderChanged) {
      const previousOrder = this.visibleOrder;
      this.visibleOrder = this.nextVisibleOrder;
      this.nextVisibleOrder = previousOrder;
      this.visibleOrder.length = this.nextVisibleIndex;
    }
    this.sendRanking();
  }

  prioritize(fileId: string): void {
    const document = this.documents.get(fileId);
    if (!document) return;
    if (this.priorityFileId === fileId) return;
    this.priorityFileId = fileId;
    if (!document.visible) {
      document.wantedRange = wholeFileRange();
    } else {
      this.planVisibleHull(
        document,
        document.visibleStart,
        document.visibleEnd,
      );
    }
    this.sendRanking();
  }

  drain(budgetMs: number, uploader: GpuUploader): boolean {
    const budget = this.budget;
    budget.restart(budgetMs);
    const priorityId = this.priorityFileId;
    const priority = priorityId ? this.documents.get(priorityId) : undefined;
    this.drainPriority(priority, uploader, budget);
    let continued = this.drainVisible(priorityId, uploader, budget);
    if (!continued && budget.exhausted)
      continued = this.minimapOrder.length > 0;
    if (!continued && !budget.exhausted) {
      this.drainMinimaps(uploader, budget);
      continued = this.minimapOrder.length > 0;
    }
    this.updateBacklogDepth();
    return continued;
  }

  private updateBacklogDepth(): void {
    let depth = this.minimapOrder.length;
    let index = 0;
    while (index < this.visibleOrder.length) {
      const fileId = this.visibleOrder[index];
      const document =
        fileId === undefined ? undefined : this.documents.get(fileId);
      if (document && hasBacklog(document, this.frontier(document))) depth += 1;
      index += 1;
    }
    this.currentBacklogDepth = depth;
  }

  private drainPriority(
    priority: ResidencyDocument | undefined,
    uploader: GpuUploader,
    budget: DrainBudget,
  ): void {
    if (!priority) return;
    this.drainDocument(priority, uploader, budget, true);
    if (priority.visible && isHighlighted(priority)) {
      this.drainReadyMinimap(priority, uploader, budget, true);
    }
    if (this.priorityFileId === priority.fileId && isHighlighted(priority)) {
      this.priorityFileId = undefined;
      this.sendRanking();
    }
  }

  private drainVisible(
    priorityId: string | undefined,
    uploader: GpuUploader,
    budget: DrainBudget,
  ): boolean {
    let index = 0;
    while (index < this.visibleOrder.length) {
      if (budget.exhausted && this.hasVisibleAfterBudget(index, priorityId)) {
        return true;
      }
      const fileId = this.visibleOrder[index];
      if (fileId !== undefined && fileId !== priorityId) {
        const document = this.documents.get(fileId);
        const stopped = document
          ? this.drainDocument(document, uploader, budget, false)
          : false;
        if (document && isHighlighted(document)) {
          this.drainReadyMinimap(document, uploader, budget, false);
        }
        if (stopped) return true;
      }
      index += 1;
    }
    return false;
  }

  private queueResult(result: TokenizedLines): void {
    const record = this.ledger.append(result);
    if (!record) return;
    const document = this.documents.get(result.fileId);
    if (
      !document ||
      !record.minimap ||
      record.minimapHeight === undefined ||
      document.minimapQueued
    ) {
      return;
    }
    document.minimapReady = true;
    document.minimapQueued = true;
    this.minimapOrder.push(document);
  }

  private planVisibleHull(
    document: ResidencyDocument,
    start: number,
    end: number,
  ): void {
    if (
      !document.plannedRange ||
      !containsBounds(document.plannedRange, start, end)
    ) {
      const margin = end - start;
      this.plan(document, {
        start: Math.max(0, start - margin),
        end: end + margin,
      });
      this.windowReplanned = true;
    }
    document.wantedRange = document.plannedRange;
  }

  private plan(document: ResidencyDocument, range: LineRange): void {
    if (sameRange(document.plannedRange, range)) return;
    document.plannedRange = range;
    document.wantedRange = range;
    document.builder = undefined;
    document.recolor = undefined;
  }

  private sendRanking(): void {
    this.ranking.update(
      this.rankingDocuments(),
      this.priorityFileId,
      this.tokenizer,
    );
  }

  private rankingDocuments(): RankingDocument[] {
    const documents: RankingDocument[] = [];
    const priority = this.priorityFileId
      ? this.documents.get(this.priorityFileId)
      : undefined;
    if (priority && !priority.visible)
      documents.push(toRankingDocument(priority));
    let index = 0;
    while (index < this.visibleOrder.length) {
      const fileId = this.visibleOrder[index];
      if (fileId === undefined) {
        index += 1;
        continue;
      }
      const document = this.documents.get(fileId);
      if (document) documents.push(toRankingDocument(document));
      index += 1;
    }
    return documents;
  }

  private hasVisibleWork(): boolean {
    return this.visibleOrderChanged || this.windowReplanned;
  }

  private drainDocument(
    document: ResidencyDocument,
    uploader: GpuUploader,
    budget: DrainBudget,
    exempt: boolean,
  ): boolean {
    let unit = this.nextUnit(document);
    while (unit !== "none") {
      if (unit === "window") {
        const window = document.uploadedWindow;
        if (!window) return false;
        uploader.uploadLineWindow(window);
      }
      if (unit === "recolor") {
        const recolor = document.recolor;
        if (!recolor) return false;
        const frontier = this.frontier(document);
        document.uploadedWindow = recolor.toWindow(frontier);
        document.recolor = undefined;
        const window = document.uploadedWindow;
        document.uploadedFrontier = Math.min(
          window.firstLine + window.lines.length,
          frontier,
        );
        uploader.uploadLineWindow(window);
      }
      budget.completeUnit();
      if (!exempt && budget.exhausted) {
        return this.hasWorkAfterUnit(document, unit);
      }
      unit = this.nextUnit(document);
    }
    return false;
  }

  private hasWorkAfterUnit(
    document: ResidencyDocument,
    unit: "window" | "recolor" | "work",
  ): boolean {
    if (unit === "work" || document.builder || document.recolor) return true;
    return needsRecolor(document, this.frontier(document));
  }

  private hasVisibleAfterBudget(
    start: number,
    priorityId: string | undefined,
  ): boolean {
    for (let index = start; index < this.visibleOrder.length; index += 1) {
      const fileId = this.visibleOrder[index];
      if (fileId !== undefined && fileId !== priorityId) return true;
    }
    return false;
  }

  private nextUnit(
    document: ResidencyDocument,
  ): "none" | "window" | "recolor" | "work" {
    const frontier = this.frontier(document);
    const colorAt = document.colorAt;
    if (document.builder) {
      if (document.builder.needsRecolor(frontier)) {
        document.builder.recolorBuiltUnit(frontier, colorAt);
        return "work";
      }
      if (!document.builder.complete) {
        document.builder.buildUnit(frontier, colorAt);
        return "work";
      }
      document.uploadedWindow = document.builder.toWindow(frontier);
      document.uploadedFrontier = Math.min(document.builder.endLine, frontier);
      document.builder = undefined;
      return "window";
    }
    if (needsWindow(document)) {
      document.builder = this.createBuilder(document);
      return "work";
    }
    const window = document.uploadedWindow;
    if (!document.recolor && window && needsRecolor(document, frontier)) {
      document.recolor = new RecolorWork({
        window,
        firstLine: Math.max(window.firstLine, document.uploadedFrontier),
        endLine: Math.min(window.firstLine + window.lines.length, frontier),
        colorAt,
      });
    }
    if (document.recolor) {
      if (!document.recolor.complete) {
        document.recolor.recolorUnit();
        return "work";
      }
      return "recolor";
    }
    return "none";
  }

  private createBuilder(document: ResidencyDocument): LineWindowBuilder {
    const layout =
      document.layout ?? new LineLayout(document.record.text, this.lineMetrics);
    document.layout = layout;
    const planned = document.plannedRange ?? wholeFileRange();
    const range = clampRange(planned, layout.lineCount);
    return new LineWindowBuilder({
      fileId: document.fileId,
      contentVersion: document.record.contentVersion,
      layout,
      range,
      lineMetrics: this.lineMetrics,
    });
  }

  private frontier(document: ResidencyDocument): number {
    return this.ledger.frontier(document.record);
  }

  private visitVisibleEntry(
    fileId: string,
    visibleRanges: readonly LineRange[],
  ): void {
    const document = this.documents.get(fileId);
    if (!document) return;
    if (visibleRanges.length === 0) {
      this.hideDocument(document);
      return;
    }
    let start = visibleRanges[0]?.start ?? 0;
    let end = visibleRanges[0]?.end ?? 0;
    for (let index = 1; index < visibleRanges.length; index += 1) {
      const range = visibleRanges[index];
      if (!range) continue;
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
    const visibleIndex = this.nextVisibleIndex;
    if (this.visibleOrder[visibleIndex] !== fileId || !document.visible) {
      this.visibleOrderChanged = true;
    }
    this.nextVisibleOrder[visibleIndex] = fileId;
    this.nextVisibleIndex += 1;
    const moved =
      !document.visible ||
      document.visibleStart !== start ||
      document.visibleEnd !== end;
    document.visible = true;
    document.visibleStart = start;
    document.visibleEnd = end;
    if (moved) this.planVisibleHull(document, start, end);
  }

  private hideDocument(document: ResidencyDocument): void {
    if (!document.visible) return;
    document.visible = false;
    document.visibleStart = 0;
    document.visibleEnd = 0;
    this.visibleOrderChanged = true;
    if (document.fileId === this.priorityFileId) {
      document.wantedRange = wholeFileRange();
    }
  }

  private drainMinimaps(uploader: GpuUploader, budget: DrainBudget): number {
    let uploads = 0;
    while (this.minimapOrder.length > 0 && !budget.exhausted) {
      const document = this.minimapOrder[0];
      if (!document) break;
      if (!document.minimapReady) {
        this.removeMinimap(document);
        continue;
      }
      const minimap = this.toMinimap(document);
      if (!minimap) {
        this.removeMinimap(document);
        continue;
      }
      uploader.uploadMinimap(minimap);
      this.removeMinimap(document);
      uploads += 1;
      budget.completeUnit();
    }
    return uploads;
  }

  private drainReadyMinimap(
    document: ResidencyDocument,
    uploader: GpuUploader,
    budget: DrainBudget,
    exempt: boolean,
  ): number {
    if (!document.minimapReady || (!exempt && budget.exhausted)) return 0;
    const minimap = this.toMinimap(document);
    if (!minimap) {
      this.removeMinimap(document);
      return 0;
    }
    uploader.uploadMinimap(minimap);
    this.removeMinimap(document);
    budget.completeUnit();
    return 1;
  }

  private removeMinimap(document: ResidencyDocument): void {
    const index = this.minimapOrder.indexOf(document);
    if (index >= 0) this.minimapOrder.splice(index, 1);
    document.minimapReady = false;
    document.minimapQueued = false;
  }

  private toMinimap(document: ResidencyDocument): MinimapUpload | undefined {
    const { minimap, minimapHeight } = document.record;
    if (!minimap || minimapHeight === undefined) return undefined;
    return {
      fileId: document.fileId,
      contentVersion: document.record.contentVersion,
      bytes: minimap,
      height: minimapHeight,
    };
  }
}

function createDocument(
  fileId: string,
  record: VersionRecord,
): ResidencyDocument {
  return {
    fileId,
    record,
    visible: false,
    visibleStart: 0,
    visibleEnd: 0,
    plannedRange: undefined,
    wantedRange: undefined,
    colorAt: () => 0,
    layout: undefined,
    builder: undefined,
    recolor: undefined,
    uploadedWindow: undefined,
    uploadedFrontier: 0,
    minimapReady: false,
    minimapQueued: false,
  };
}

function containsBounds(range: LineRange, start: number, end: number): boolean {
  return range.start <= start && range.end >= end;
}

function sameRange(
  left: LineRange | undefined,
  right: LineRange | undefined,
): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

function clampRange(range: LineRange, lineCount: number): LineRange {
  const start = Math.min(Math.max(0, range.start), Math.max(0, lineCount - 1));
  const end = Math.min(Math.max(start, range.end), lineCount);
  return { start, end: Math.max(start + 1, end) };
}

function toRankingDocument(document: ResidencyDocument): RankingDocument {
  return {
    fileId: document.fileId,
    visible: document.visible,
    wantedRange: document.wantedRange,
  };
}

function needsWindow(document: ResidencyDocument): boolean {
  if (!document.visible) return false;
  if (!document.uploadedWindow || !document.plannedRange) return true;
  const lineCount = document.uploadedWindow.lineCount;
  const plannedStart = Math.min(
    Math.max(0, document.plannedRange.start),
    Math.max(0, lineCount - 1),
  );
  const plannedEnd = Math.min(
    Math.max(plannedStart, document.plannedRange.end),
    lineCount,
  );
  const expectedEnd = Math.max(plannedStart + 1, plannedEnd);
  return (
    document.uploadedWindow.contentVersion !== document.record.contentVersion ||
    document.uploadedWindow.firstLine !== plannedStart ||
    document.uploadedWindow.firstLine + document.uploadedWindow.lines.length !==
      expectedEnd
  );
}

function needsRecolor(document: ResidencyDocument, frontier: number): boolean {
  if (!document.uploadedWindow) return false;
  const end =
    document.uploadedWindow.firstLine + document.uploadedWindow.lines.length;
  return document.uploadedFrontier < Math.min(frontier, end);
}

function hasBacklog(document: ResidencyDocument, frontier: number): boolean {
  return (
    needsWindow(document) ||
    document.builder !== undefined ||
    document.recolor !== undefined ||
    needsRecolor(document, frontier)
  );
}

function isHighlighted(document: ResidencyDocument): boolean {
  return (
    document.uploadedWindow?.highlighted === true &&
    document.uploadedWindow.contentVersion === document.record.contentVersion
  );
}

function createColorAt(
  ledger: VersionLedger,
  document: ResidencyDocument,
): CellColorAt {
  return (line, utf16Offset) =>
    ledger.chunkAt(document.record, line)?.colorAt(line, utf16Offset) ?? 0;
}
