import { describe, expect, it } from "vitest";

import {
  minimumHeight,
  type BoardMetrics,
} from "../board/domain/board-metrics";
import { StackOrder } from "../board/domain/stack-order";
import { Widget } from "../board/domain/widget";
import { sourceFileId } from "../shared/domain";

const metrics: BoardMetrics = {
  baseLineHeight: 20,
  headerHeight: 42,
  minimumWidth: 240,
  minimumBodyLines: 3,
  columnWidth: 760,
  gridGap: 40,
  maximumHeight: 900,
  edgeGrabScreenPx: 8,
};

function widget(lineCount = 2000, height = 900): Widget {
  return new Widget(sourceFileId("file.ts"), "file.ts", lineCount, {
    frame: { x: 10, y: 20, width: 760, height },
    metrics,
  });
}

describe("Widget", () => {
  it("Minimum size", () => {
    const value = widget(20);

    value.resizeTo(10, 10);

    expect(value.width).toBe(240);
    expect(value.height).toBe(minimumHeight(metrics));
  });

  it("Resizing while scrolled to the end", () => {
    const value = widget();
    value.scrollTo(Number.POSITIVE_INFINITY);

    value.resizeTo(760, 1400);

    expect(value.contentScroll).toBe(2000 * 20 - (1400 - 42));
    expect(value.maxContentScroll).toBe(2000 * 20 - (1400 - 42));
  });

  it("Line count shrinks after an edit", () => {
    const value = widget();
    value.scrollTo(Number.POSITIVE_INFINITY);

    value.setLineCount(100);

    expect(value.contentScroll).toBe(100 * 20 - (900 - 42));
  });

  it("Content edge", () => {
    const value = widget();
    value.scrollTo(Number.POSITIVE_INFINITY);

    expect(value.scrollBy(50)).toBe(0);
    expect(value.contentScroll).toBe(2000 * 20 - (900 - 42));

    value.scrollTo(0);

    expect(value.scrollBy(-50)).toBe(0);
  });

  it("does not scroll below zero for short content", () => {
    const value = widget(1, 900);
    value.scrollTo(-50);

    expect(value.contentScroll).toBe(0);
    expect(value.maxContentScroll).toBe(0);
  });
});

describe("Stack Order", () => {
  it("adds widgets on top and exposes them top-most first", () => {
    const order = new StackOrder();
    const bottom = sourceFileId("bottom");
    const middle = sourceFileId("middle");
    const top = sourceFileId("top");

    order.add(bottom);
    order.add(middle);
    order.add(top);

    expect(order.idAtFromTop(0)).toBe(top);
    expect(order.idAtFromTop(1)).toBe(middle);
    expect(order.idAtFromTop(2)).toBe(bottom);
    expect(order.size).toBe(3);
  });

  it("rejects duplicate widgets", () => {
    const order = new StackOrder();
    const id = sourceFileId("file.ts");
    order.add(id);

    expect(() => {
      order.add(id);
    }).toThrow(RangeError);
  });

  it("brings a widget to the front while preserving the other order", () => {
    const order = new StackOrder();
    const first = sourceFileId("first");
    const second = sourceFileId("second");
    const third = sourceFileId("third");
    order.add(first);
    order.add(second);
    order.add(third);

    order.bringToFront(first);

    expect(order.indexOf(first)).toBe(2);
    expect(order.idAtFromTop(0)).toBe(first);
    expect(order.idAtFromTop(1)).toBe(third);
    expect(order.idAtFromTop(2)).toBe(second);
  });
});
