import { expect, test, type Page } from "@playwright/test";

import { WIDGET_SCROLL_THUMB_COLOR } from "../../src/rendering/widget-colors";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  installDirectoryMock,
  openFolder,
  readCanvasColumn,
  readWidgetRects,
  writeMockFile,
  type WidgetRect,
} from "./support";

const EDGE_GRAB_OFFSET_PX = 4;

interface Point {
  readonly x: number;
  readonly y: number;
}

function headerPoint(widget: WidgetRect, scale: number): Point {
  return {
    x: widget.rect.x + widget.rect.width / 2,
    y: widget.rect.y + (DEFAULT_CODE_FONT.bodyTop * scale) / 2,
  };
}

function cornerPoint(widget: WidgetRect): Point {
  return {
    x: widget.rect.x + widget.rect.width + EDGE_GRAB_OFFSET_PX,
    y: widget.rect.y + widget.rect.height + EDGE_GRAB_OFFSET_PX,
  };
}

async function waitForOneAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
}

async function dragInSteps(
  page: Page,
  start: Point,
  delta: Point,
): Promise<void> {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      start.x + (delta.x * step) / 10,
      start.y + (delta.y * step) / 10,
    );
    await waitForOneAnimationFrame(page);
  }
  await page.mouse.up();
}

function sourceText(lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) => `const line${String(index)} = ${String(index)};`,
  ).join("\n");
}

async function waitForTwoAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

async function dispatchWheel(page: Page, point: Point): Promise<void> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: box.x + point.x,
    y: box.y + point.y,
    deltaX: 40,
    deltaY: 30,
  });
}

function expectRectClose(
  label: string,
  actual: number,
  expected: number,
  measured: string,
): void {
  expect(
    Math.abs(actual - expected),
    `${label} measured=${String(actual)} expected=${String(expected)} ${measured}`,
  ).toBeLessThanOrEqual(0.5);
}

function colorFromHex(color: string): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} {
  const value = Number.parseInt(color.slice(1), 16);
  return {
    red: (value >> 16) & 0xff,
    green: (value >> 8) & 0xff,
    blue: value & 0xff,
  };
}

async function scrollThumbStart(
  page: Page,
  rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): Promise<number> {
  const canvas = page.getByTestId("canvas");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Canvas bounds are unavailable");
  const bodyTop = rect.y + DEFAULT_CODE_FONT.bodyTop;
  const bodyBottom = Math.min(
    rect.y + rect.height - 1,
    canvasBox.y + canvasBox.height - 1,
  );
  const thumb = colorFromHex(WIDGET_SCROLL_THUMB_COLOR);
  const pixels = await readCanvasColumn(
    page,
    rect.x + rect.width - 6,
    bodyTop,
    bodyBottom,
  );
  return pixels.findIndex(
    (pixel) =>
      pixel.red === thumb.red &&
      pixel.green === thumb.green &&
      pixel.blue === thumb.blue,
  );
}

test("Restart", async ({ page }) => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    path: `file-${String(index)}.ts`,
    text: sourceText(60),
  }));
  const folderName = await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");

  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const center = { x: box.width / 2, y: box.height / 2 };
  await dispatchWheel(page, center);
  await dispatchWheel(page, center);
  await dispatchWheel(page, center);
  await waitForTwoAnimationFrames(page);
  const recordedRects = await readWidgetRects(page);
  await page.waitForTimeout(1500);

  await page.reload();
  const reopenButton = page.getByTestId("reopen-folder");
  await expect(reopenButton).toBeVisible();
  await expect(reopenButton).toContainText(folderName);
  await reopenButton.click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");
  await waitForTwoAnimationFrames(page);

  const restoredRects = await readWidgetRects(page);
  const measured = `recorded=${JSON.stringify(recordedRects)} restored=${JSON.stringify(restoredRects)}`;
  expect(
    restoredRects.length,
    `widget count measured=${String(restoredRects.length)} expected=3 ${measured}`,
  ).toBe(3);
  for (const recorded of recordedRects) {
    const restored = restoredRects.find(
      (widget) => widget.filePath === recorded.filePath,
    );
    expect(
      restored,
      `missing restored widget file=${recorded.filePath} ${measured}`,
    ).toBeDefined();
    if (!restored) continue;
    for (const property of ["x", "y", "width", "height"] as const) {
      expectRectClose(
        `${recorded.filePath} ${property}`,
        restored.rect[property],
        recorded.rect[property],
        measured,
      );
    }
  }
  await expect(reopenButton).toBeHidden();
});

test("Reload after rearranging", async ({ page }) => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    path: `file-${String(index)}.ts`,
    text: sourceText(10),
  }));
  const folderName = await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");

  const scale = Number(await canvas.getAttribute("data-text-metrics-scale"));
  if (!Number.isFinite(scale)) throw new Error("Camera scale is unavailable");
  const before = await readWidgetRects(page);
  const beforeTarget = before.find((widget) => widget.filePath === "file-0.ts");
  if (!beforeTarget)
    throw new Error(
      `Target widget is missing: rects=${JSON.stringify(before)}`,
    );

  await dragInSteps(page, headerPoint(beforeTarget, scale), { x: 80, y: 60 });
  const movedTarget = (await readWidgetRects(page)).find(
    (widget) => widget.filePath === beforeTarget.filePath,
  );
  if (!movedTarget)
    throw new Error("Target widget disappeared after dragging its header");
  await dragInSteps(page, cornerPoint(movedTarget), { x: 120, y: 100 });
  const recordedRects = await readWidgetRects(page);
  const recordedTarget = recordedRects.find(
    (widget) => widget.filePath === beforeTarget.filePath,
  );
  if (!recordedTarget)
    throw new Error(
      `Target widget is missing after rearranging: rects=${JSON.stringify(recordedRects)}`,
    );

  for (const property of ["x", "y", "width", "height"] as const) {
    expect(
      recordedTarget.rect[property],
      `${property} did not change: before=${JSON.stringify(beforeTarget.rect)} after=${JSON.stringify(recordedTarget.rect)}`,
    ).not.toBe(beforeTarget.rect[property]);
  }
  await page.waitForTimeout(1100);

  await page.reload();
  const reopenButton = page.getByTestId("reopen-folder");
  await expect(reopenButton).toBeVisible();
  await expect(reopenButton).toContainText(folderName);
  await reopenButton.click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");
  await waitForTwoAnimationFrames(page);

  const restoredRects = await readWidgetRects(page);
  const measured = `recorded=${JSON.stringify(recordedRects)} restored=${JSON.stringify(restoredRects)}`;
  expect(
    restoredRects.length,
    `widget count measured=${String(restoredRects.length)} expected=3 ${measured}`,
  ).toBe(3);
  for (const recorded of recordedRects) {
    const restored = restoredRects.find(
      (widget) => widget.filePath === recorded.filePath,
    );
    expect(
      restored,
      `missing restored widget file=${recorded.filePath} ${measured}`,
    ).toBeDefined();
    if (!restored) continue;
    for (const property of ["x", "y", "width", "height"] as const) {
      expectRectClose(
        `${recorded.filePath} ${property}`,
        restored.rect[property],
        recorded.rect[property],
        measured,
      );
    }
  }
});

test("New file in the folder", async ({ page }) => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    path: `file-${String(index)}.ts`,
    text: sourceText(10),
  }));
  const folderName = await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");
  const recordedRects = await readWidgetRects(page);
  await page.waitForTimeout(1100);

  await page.reload();
  const reopenButton = page.getByTestId("reopen-folder");
  await expect(reopenButton).toBeVisible();
  await expect(reopenButton).toContainText(folderName);
  await writeMockFile(page, "new-file.ts", sourceText(10));
  await reopenButton.click();
  await expect(canvas).toHaveAttribute("data-widget-count", "4");
  await waitForTwoAnimationFrames(page);

  const restoredRects = await readWidgetRects(page);
  const newWidget = restoredRects.find(
    (widget) => widget.filePath === "new-file.ts",
  );
  expect(newWidget).toBeDefined();
  if (!newWidget) return;
  const oldWidgets = restoredRects.filter(
    (widget) => widget.filePath !== newWidget.filePath,
  );
  const largestOldRight = Math.max(
    ...recordedRects.map((widget) => widget.rect.x + widget.rect.width),
  );
  expect(newWidget.rect.x).toBeGreaterThanOrEqual(largestOldRight);
  for (const oldWidget of oldWidgets) {
    const oldRect = oldWidget.rect;
    const overlaps =
      oldRect.x < newWidget.rect.x + newWidget.rect.width &&
      oldRect.x + oldRect.width > newWidget.rect.x &&
      oldRect.y < newWidget.rect.y + newWidget.rect.height &&
      oldRect.y + oldRect.height > newWidget.rect.y;
    expect(
      overlaps,
      `new widget overlaps ${oldWidget.filePath}: rects=${JSON.stringify(restoredRects)}`,
    ).toBe(false);
  }
  const measured = `recorded=${JSON.stringify(recordedRects)} restored=${JSON.stringify(restoredRects)}`;
  for (const recorded of recordedRects) {
    const restored = restoredRects.find(
      (widget) => widget.filePath === recorded.filePath,
    );
    expect(
      restored,
      `missing restored widget file=${recorded.filePath} ${measured}`,
    ).toBeDefined();
    if (!restored) continue;
    for (const property of ["x", "y", "width", "height"] as const) {
      expectRectClose(
        `${recorded.filePath} ${property}`,
        restored.rect[property],
        recorded.rect[property],
        measured,
      );
    }
  }
});

test("Project folder", async ({ page }) => {
  const files = [
    ...Array.from({ length: 200 }, (_, index) => ({
      path: `src/group-${String(index % 4)}/file-${String(index)}.${index % 2 === 0 ? "ts" : "tsx"}`,
      text: `export const value${String(index)} = ${String(index)};`,
    })),
    { path: "node_modules/pkg/index.ts", text: "export const ignored = 1;" },
    {
      path: "node_modules/pkg/nested/index.tsx",
      text: "export const nested = 1;",
    },
    { path: ".git/config.ts", text: "export const ignored = 1;" },
    { path: "dist/generated.ts", text: "export const ignored = 1;" },
    { path: "build/output.ts", text: "export const ignored = 1;" },
    { path: ".cache/hidden.ts", text: "export const ignored = 1;" },
    { path: "README.md", text: "not a widget" },
  ];
  await installDirectoryMock(page, files);
  await page.goto("/");
  await openFolder(page);

  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-widget-count", "200");
  const paths = (await readWidgetRects(page)).map((widget) => widget.filePath);
  expect(paths).toHaveLength(200);
  for (const directory of ["node_modules", ".git", "dist", "build", ".cache"]) {
    expect(
      paths.filter((path) => path.startsWith(`${directory}/`)),
    ).toHaveLength(0);
  }
});

test("File larger than 2000 lines", async ({ page }) => {
  await installDirectoryMock(page, [
    { path: "large.ts", text: sourceText(5000) },
    { path: "small.ts", text: sourceText(3) },
  ]);
  await page.goto("/");
  await openFolder(page);

  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-widget-count", "2");
  const widget = (await readWidgetRects(page)).find(
    (candidate) => candidate.filePath === "large.ts",
  );
  expect(widget).toBeDefined();
  if (!widget) return;

  await waitForTwoAnimationFrames(page);
  const initialThumb = await scrollThumbStart(page, widget.rect);
  expect(initialThumb).toBeGreaterThanOrEqual(0);
  await page.mouse.move(
    widget.rect.x + widget.rect.width / 2,
    widget.rect.y + DEFAULT_CODE_FONT.bodyTop + 20,
  );
  await page.mouse.wheel(0, DEFAULT_CODE_FONT.lineHeight * 2500);
  await waitForTwoAnimationFrames(page);
  const finalThumb = await scrollThumbStart(page, widget.rect);
  expect(finalThumb).toBeGreaterThan(initialThumb);
});

test("Folder larger than 200 files", async ({ page }) => {
  const files = Array.from({ length: 350 }, (_, index) => ({
    path: `group-${String(index % 7)}/file-${String(index)}.ts`,
    text: `export const value${String(index)} = ${String(index)};`,
  }));
  await installDirectoryMock(page, files);
  await page.goto("/");
  await openFolder(page);

  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-widget-count", "350");
  const paths = (await readWidgetRects(page)).map((widget) => widget.filePath);
  expect(paths).toHaveLength(350);
  expect(new Set(paths).size).toBe(350);
});
