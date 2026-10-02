import { describe, expect, it } from "vitest";

import {
  layoutMinimapLabel,
  MINIMAP_LABEL_MAX_FONT_SIZE,
  MINIMAP_LABEL_MIN_FONT_SIZE,
} from "./minimap-label";

const metrics = {
  baseFontSize: 16,
  baseBaseline: 15,
  baseLineHeight: 20,
  advanceFor: (cluster: string) => cluster.length * 8,
};

describe("Minimap label layout", () => {
  it("keeps a fitting File Path and chooses the largest fitting font", () => {
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "src/a.ts",
      widgetWidth: 240,
      widgetHeight: 200,
      padding: 16,
    });

    expect(label.text).toBe("src/a.ts");
    expect(label.fontSize).toBe(MINIMAP_LABEL_MAX_FONT_SIZE);
  });

  it("drops folders when the File Path does not fit at the minimum size", () => {
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "very/long/folder/a.ts",
      widgetWidth: 100,
      widgetHeight: 200,
      padding: 8,
    });

    expect(label.text).toBe("a.ts");
    expect(label.fontSize).toBeGreaterThan(MINIMAP_LABEL_MIN_FONT_SIZE);
  });

  it("ellipsizes a file name that does not fit at the minimum size", () => {
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "very/long/folder/a-very-long-file-name.ts",
      widgetWidth: 72,
      widgetHeight: 200,
      padding: 8,
    });

    expect(label.text.endsWith("…")).toBe(true);
    expect(label.fontSize).toBe(MINIMAP_LABEL_MIN_FONT_SIZE);
    expect(label.width).toBeLessThanOrEqual(72);
  });

  it("clamps the chosen font size at both ends", () => {
    expect(
      layoutMinimapLabel({
        ...metrics,
        filePath: "a.ts",
        widgetWidth: 1000,
        widgetHeight: 200,
        padding: 8,
      }).fontSize,
    ).toBe(MINIMAP_LABEL_MAX_FONT_SIZE);
    expect(
      layoutMinimapLabel({
        ...metrics,
        filePath: "a.ts",
        widgetWidth: 32,
        widgetHeight: 200,
        padding: 8,
      }).fontSize,
    ).toBe(MINIMAP_LABEL_MIN_FONT_SIZE);
  });
});

describe("Minimap label vertical metrics", () => {
  it("centres a long-document label in a 900 px widget body", () => {
    const bodyWidth = 900;
    const bodyHeight = 900 - 40;
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "widget-000.tsx",
      widgetWidth: bodyWidth,
      widgetHeight: bodyHeight,
      padding: 12,
    });

    expect(label.x).toBeCloseTo((bodyWidth - label.width) / 2);
    expect(label.y).toBeCloseTo((bodyHeight - label.height) / 2);
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.y).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(bodyWidth);
    expect(label.y + label.height).toBeLessThanOrEqual(bodyHeight);
  });

  it("keeps a two-line widget label inside and centred in the body", () => {
    const bodyWidth = 320;
    const bodyHeight = 120;
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "src/a.ts",
      widgetWidth: bodyWidth,
      widgetHeight: bodyHeight,
      padding: 12,
    });

    expect(label.x).toBeCloseTo((bodyWidth - label.width) / 2);
    expect(label.y).toBeCloseTo((bodyHeight - label.height) / 2);
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.y).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(bodyWidth);
    expect(label.y + label.height).toBeLessThanOrEqual(bodyHeight);
  });

  it("caps the font at the minimap body's height", () => {
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "a.ts",
      widgetWidth: 1000,
      widgetHeight: 24,
      padding: 4,
    });

    expect(label.fontSize).toBe(12.8);
    expect(label.height).toBe(16);
  });

  it("keeps the 9 px floor when the body is shorter than a line", () => {
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "a.ts",
      widgetWidth: 1000,
      widgetHeight: 10,
      padding: 4,
    });

    expect(label.fontSize).toBe(MINIMAP_LABEL_MIN_FONT_SIZE);
  });
  it("scales Text Metrics' baseline and line height with the label font", () => {
    const label = layoutMinimapLabel({
      ...metrics,
      filePath: "a.ts",
      widgetWidth: 1000,
      widgetHeight: 200,
      padding: 8,
    });

    expect(label.fontSize).toBe(MINIMAP_LABEL_MAX_FONT_SIZE);
    expect(label.baseline).toBe(26.25);
    expect(label.lineHeight).toBe(35);
    expect(label.height).toBe(label.lineHeight);
  });
});
