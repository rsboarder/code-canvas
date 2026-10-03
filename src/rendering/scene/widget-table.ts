import type { BoardReadModel, WidgetRow } from "../../board";
import type { Rect } from "../../shared/geometry/geometry";

export const MAX_WIDGET_ROWS = 4096;
const FLOATS_PER_ROW = 8;
const INITIAL_LAYOUT_VERSION = -1;

export type WidgetId = NonNullable<
  ReturnType<BoardReadModel["widgetIdAtFromTop"]>
>;

export type WidgetTableBoard = Pick<
  BoardReadModel,
  | "layoutVersion"
  | "widgetCount"
  | "widgetIdAtFromTop"
  | "readWidget"
  | "drainDirtyWidgets"
>;

export class WidgetTable {
  readonly values = new Float32Array(MAX_WIDGET_ROWS * FLOATS_PER_ROW);
  private readonly rowById = new Map<WidgetId, number>();
  private readonly idByRow: (WidgetId | undefined)[] = [];
  private readonly dirtyIds: WidgetId[] = [];
  private readonly widgetRow: WidgetRow = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    contentScroll: 0,
    maxContentScroll: 0,
    lineCount: 0,
    stackIndex: 0,
  };
  private lastLayoutVersion = INITIAL_LAYOUT_VERSION;
  private currentRowCount = 0;
  private currentDirtyStart = MAX_WIDGET_ROWS;
  private currentDirtyEnd = 0;
  private documentId: WidgetId | undefined;
  private overflowLayoutVersion = INITIAL_LAYOUT_VERSION;
  private currentRowsVersion = 0;

  get rowCount(): number {
    return this.currentRowCount;
  }

  get rowsVersion(): number {
    return this.currentRowsVersion;
  }

  get hasDirtyRows(): boolean {
    return this.currentDirtyStart < this.currentDirtyEnd;
  }

  get dirtyRowStart(): number | undefined {
    return this.hasDirtyRows ? this.currentDirtyStart : undefined;
  }

  get dirtyRowEndExclusive(): number | undefined {
    return this.hasDirtyRows ? this.currentDirtyEnd : undefined;
  }

  get documentRowIndex(): number {
    if (!this.documentId) return -1;
    return this.rowById.get(this.documentId) ?? -1;
  }

  setDocumentId(id: string): void {
    this.documentId = id as WidgetId;
  }

  rowFor(id: WidgetId): number | undefined {
    return this.rowById.get(id);
  }

  widgetIdAt(row: number): WidgetId | undefined {
    return this.idByRow[row];
  }

  readFrame(row: number, out: Rect): boolean {
    const offset = row * FLOATS_PER_ROW;
    if (row < 0 || row >= this.currentRowCount) {
      out.x = 0;
      out.y = 0;
      out.width = 0;
      out.height = 0;
      return false;
    }
    out.x = this.values[offset] ?? 0;
    out.y = this.values[offset + 1] ?? 0;
    out.width = this.values[offset + 2] ?? 0;
    out.height = this.values[offset + 3] ?? 0;
    return true;
  }

  contentScrollAt(row: number): number {
    if (row < 0 || row >= this.currentRowCount) return 0;
    return this.values[row * FLOATS_PER_ROW + 4] ?? 0;
  }

  depthAt(row: number): number {
    if (row < 0 || row >= this.currentRowCount) return 0;
    return this.values[row * FLOATS_PER_ROW + 5] ?? 0;
  }

  readDocumentFrame(out: Rect): boolean {
    return this.readFrame(this.documentRowIndex, out);
  }

  readDocumentContentScroll(): number {
    const offset = this.documentRowIndex * FLOATS_PER_ROW;
    return offset < 0 ? 0 : (this.values[offset + 4] ?? 0);
  }

  sync(board: WidgetTableBoard): void {
    if (board.layoutVersion !== this.lastLayoutVersion) {
      this.rebuild(board);
      return;
    }
    this.drainDirtyRows(board);
  }

  clearDirtyRange(): void {
    this.currentDirtyStart = MAX_WIDGET_ROWS;
    this.currentDirtyEnd = 0;
  }

  private rebuild(board: WidgetTableBoard): void {
    this.lastLayoutVersion = board.layoutVersion;
    this.currentRowsVersion += 1;
    this.rowById.clear();
    this.currentRowCount = Math.min(board.widgetCount, MAX_WIDGET_ROWS);
    this.idByRow.length = this.currentRowCount;
    if (
      board.widgetCount > MAX_WIDGET_ROWS &&
      this.overflowLayoutVersion !== board.layoutVersion
    ) {
      console.error(
        `WidgetTable capacity exceeded: drawing ${String(MAX_WIDGET_ROWS)} of ${String(board.widgetCount)} widgets.`,
      );
      this.overflowLayoutVersion = board.layoutVersion;
    }
    for (let index = 0; index < this.currentRowCount; index += 1) {
      const id = board.widgetIdAtFromTop(index);
      this.idByRow[index] = id;
      if (!id) continue;
      this.rowById.set(id, index);
      board.readWidget(id, this.widgetRow);
      this.writeRow(index, this.widgetRow);
    }
    this.markDirty(0, this.currentRowCount);
    board.drainDirtyWidgets(this.dirtyIds);
  }

  private drainDirtyRows(board: WidgetTableBoard): void {
    const dirtyCount = board.drainDirtyWidgets(this.dirtyIds);
    for (let index = 0; index < dirtyCount; index += 1) {
      const id = this.dirtyIds[index];
      if (!id) continue;
      const row = this.rowById.get(id);
      if (row === undefined) continue;
      board.readWidget(id, this.widgetRow);
      this.writeRow(row, this.widgetRow);
      this.markDirty(row, row + 1);
    }
  }

  private writeRow(row: number, widget: WidgetRow): void {
    const offset = row * FLOATS_PER_ROW;
    this.values[offset] = widget.x;
    this.values[offset + 1] = widget.y;
    this.values[offset + 2] = widget.width;
    this.values[offset + 3] = widget.height;
    this.values[offset + 4] = widget.contentScroll;
    this.values[offset + 5] = depthFor(widget.stackIndex);
    this.values[offset + 6] = widget.maxContentScroll;
    this.values[offset + 7] = 0;
  }

  private markDirty(start: number, end: number): void {
    if (start >= end) return;
    this.currentDirtyStart = Math.min(this.currentDirtyStart, start);
    this.currentDirtyEnd = Math.max(this.currentDirtyEnd, end);
  }
}

function depthFor(stackIndex: number): number {
  return (MAX_WIDGET_ROWS - stackIndex) / (MAX_WIDGET_ROWS + 1);
}
