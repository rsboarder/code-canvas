import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardReadModel, WidgetRow } from "../../board";
import {
  MAX_WIDGET_ROWS,
  WidgetTable,
  type WidgetTableBoard,
} from "./widget-table";

type WidgetId = NonNullable<ReturnType<BoardReadModel["widgetIdAtFromTop"]>>;

interface FakeWidget extends WidgetRow {
  readonly id: WidgetId;
}

class FakeBoard implements WidgetTableBoard {
  layoutVersion = 1;
  readonly dirtyIds: WidgetId[] = [];

  constructor(readonly widgets: FakeWidget[]) {}

  get widgetCount(): number {
    return this.widgets.length;
  }

  widgetIdAtFromTop(index: number): WidgetId | undefined {
    return this.widgets[index]?.id;
  }

  readWidget(id: WidgetId, out: WidgetRow): WidgetRow {
    const widget = this.widgets.find((candidate) => candidate.id === id);
    if (!widget) throw new RangeError("Unknown widget id.");
    Object.assign(out, widget);
    return out;
  }

  drainDirtyWidgets(out: WidgetId[]): number {
    out.length = 0;
    out.push(...this.dirtyIds);
    this.dirtyIds.length = 0;
    return out.length;
  }
}

function widget(
  id: string,
  stackIndex: number,
  x = stackIndex * 10,
): FakeWidget {
  return {
    id: id as WidgetId,
    x,
    y: 20,
    width: 300,
    height: 200,
    contentScroll: 4,
    maxContentScroll: 80,
    lineCount: 10,
    stackIndex,
  };
}

function rowValues(table: WidgetTable, row: number): number[] {
  return [...table.values.slice(row * 8, row * 8 + 8)];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WidgetTable CPU projection", () => {
  it("rewrites every row and rebuilds the id-to-row map on a layout change", () => {
    const board = new FakeBoard([
      widget("top.ts", 1, 0),
      widget("bottom.ts", 0),
    ]);
    const table = new WidgetTable();

    table.sync(board);

    expect(table.rowCount).toBe(2);
    expect(rowValues(table, 0).slice(0, 5)).toEqual([0, 20, 300, 200, 4]);
    expect(rowValues(table, 0)[5]).toBeCloseTo(
      (MAX_WIDGET_ROWS - 1) / (MAX_WIDGET_ROWS + 1),
    );
    expect(rowValues(table, 0).slice(6)).toEqual([80, 0]);
    expect(table.rowFor("top.ts" as WidgetId)).toBe(0);
    expect(table.rowFor("bottom.ts" as WidgetId)).toBe(1);
    expect(table.dirtyRowStart).toBe(0);
    expect(table.dirtyRowEndExclusive).toBe(2);
  });

  it("rewrites only a dirty row and records the dirty range", () => {
    const board = new FakeBoard([
      widget("top.ts", 1, 0),
      widget("bottom.ts", 0),
    ]);
    const table = new WidgetTable();
    table.sync(board);
    table.clearDirtyRange();
    const bottom = board.widgets[1];
    if (!bottom) throw new Error("Expected bottom widget.");
    bottom.x = 999;
    board.dirtyIds.push("bottom.ts" as WidgetId);

    table.sync(board);

    expect(rowValues(table, 0)[0]).toBe(0);
    expect(rowValues(table, 1)[0]).toBe(999);
    expect(table.dirtyRowStart).toBe(1);
    expect(table.dirtyRowEndExclusive).toBe(2);
  });

  it("does not record an upload when nothing is dirty", () => {
    const board = new FakeBoard([widget("only.ts", 0)]);
    const table = new WidgetTable();
    table.sync(board);
    table.clearDirtyRange();

    table.sync(board);

    expect(table.hasDirtyRows).toBe(false);
  });
});

describe("WidgetTable stack and capacity", () => {
  it("assigns unique depths with higher stack indexes nearer the camera", () => {
    const board = new FakeBoard([
      widget("top.ts", 2),
      widget("middle.ts", 1),
      widget("bottom.ts", 0),
    ]);
    const table = new WidgetTable();

    table.sync(board);

    const depths = [0, 1, 2].map((row) => rowValues(table, row)[5]);
    expect(new Set(depths).size).toBe(3);
    expect(depths[0] ?? 0).toBeLessThan(depths[1] ?? 0);
    expect(depths[1] ?? 0).toBeLessThan(depths[2] ?? 0);
  });

  it("keeps row indexes fixed when widgets are brought to the front", () => {
    const board = new FakeBoard([widget("top.ts", 1), widget("bottom.ts", 0)]);
    const table = new WidgetTable();
    table.sync(board);
    table.clearDirtyRange();
    const top = board.widgets[0];
    const bottom = board.widgets[1];
    if (!top || !bottom) throw new Error("Expected two widgets.");
    top.stackIndex = 0;
    bottom.stackIndex = 1;
    board.dirtyIds.push("top.ts" as WidgetId, "bottom.ts" as WidgetId);

    table.sync(board);

    expect(table.rowFor("top.ts" as WidgetId)).toBe(0);
    expect(table.rowFor("bottom.ts" as WidgetId)).toBe(1);
    expect(rowValues(table, 0)[5] ?? 0).toBeGreaterThan(
      rowValues(table, 1)[5] ?? 0,
    );
  });

  it("draws only capacity rows and logs one error for an overflowing layout", () => {
    const board = new FakeBoard(
      Array.from({ length: MAX_WIDGET_ROWS + 1 }, (_, index) =>
        widget(`widget-${String(index)}.ts`, index),
      ),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const table = new WidgetTable();

    table.sync(board);
    table.sync(board);

    expect(table.rowCount).toBe(MAX_WIDGET_ROWS);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
