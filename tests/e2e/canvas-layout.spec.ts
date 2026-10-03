import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  installDirectoryMock,
  openFolder,
  readWidgetRects,
  type WidgetRect,
} from "./support";

const CANVAS_INSET = 40;
const GEOMETRY_TOLERANCE = 1;

interface Camera {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface WheelInput {
  readonly point: Point;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly modifiers?: number;
}

interface CanvasSize {
  readonly width: number;
  readonly height: number;
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

async function readLastFrame(page: Page): Promise<Camera> {
  const frame = await page.evaluate(() => {
    const entries = window.__codeCanvasTest?.frameLog();
    return entries?.[entries.length - 1];
  });
  if (!frame) throw new Error("Code Canvas frame log is missing");
  return frame;
}

async function readCanvasSize(page: Page): Promise<CanvasSize> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  return { width: box.width, height: box.height };
}

function rowMajor(rects: readonly WidgetRect[]): readonly WidgetRect[] {
  const byY = [...rects].sort((left, right) => left.rect.y - right.rect.y);
  const rows: WidgetRect[][] = [];
  for (const rect of byY) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (row && first && Math.abs(rect.rect.y - first.rect.y) <= 0.5) {
      row.push(rect);
      continue;
    }
    rows.push([rect]);
  }
  return rows.flatMap((row) =>
    row.sort((left, right) => left.rect.x - right.rect.x),
  );
}

function rectDescription(rect: WidgetRect): string {
  return `${rect.filePath}:${JSON.stringify(rect.rect)}`;
}

function expectNoOverlaps(rects: readonly WidgetRect[]): void {
  for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
    const left = rects[leftIndex];
    if (!left) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < rects.length;
      rightIndex += 1
    ) {
      const right = rects[rightIndex];
      if (!right) continue;
      const overlapWidth =
        Math.min(
          left.rect.x + left.rect.width,
          right.rect.x + right.rect.width,
        ) - Math.max(left.rect.x, right.rect.x);
      const overlapHeight =
        Math.min(
          left.rect.y + left.rect.height,
          right.rect.y + right.rect.height,
        ) - Math.max(left.rect.y, right.rect.y);
      expect(
        overlapWidth > 0 && overlapHeight > 0,
        `overlap measuredWidth=${String(overlapWidth)} measuredHeight=${String(overlapHeight)} left=${rectDescription(left)} right=${rectDescription(right)}`,
      ).toBe(false);
    }
  }
}

function expectEqualWidths(rects: readonly WidgetRect[]): void {
  const reference = rects[0]?.rect.width;
  if (reference === undefined) throw new Error("Widget rects are empty");
  for (const rect of rects) {
    expect(
      Math.abs(rect.rect.width - reference),
      `width mismatch measured=${String(rect.rect.width)} reference=${String(reference)} rect=${rectDescription(rect)}`,
    ).toBeLessThanOrEqual(0.01);
  }
}

function expectInsideInset(
  rects: readonly WidgetRect[],
  canvas: CanvasSize,
): void {
  for (const widget of rects) {
    const right = widget.rect.x + widget.rect.width;
    const bottom = widget.rect.y + widget.rect.height;
    const measured = `rect=${rectDescription(widget)} canvas=${JSON.stringify(canvas)}`;
    expect(
      widget.rect.x,
      `left edge measured=${String(widget.rect.x)} ${measured}`,
    ).toBeGreaterThanOrEqual(CANVAS_INSET - GEOMETRY_TOLERANCE);
    expect(
      widget.rect.y,
      `top edge measured=${String(widget.rect.y)} ${measured}`,
    ).toBeGreaterThanOrEqual(CANVAS_INSET - GEOMETRY_TOLERANCE);
    expect(
      right,
      `right edge measured=${String(right)} ${measured}`,
    ).toBeLessThanOrEqual(canvas.width - CANVAS_INSET + GEOMETRY_TOLERANCE);
    expect(
      bottom,
      `bottom edge measured=${String(bottom)} ${measured}`,
    ).toBeLessThanOrEqual(canvas.height - CANVAS_INSET + GEOMETRY_TOLERANCE);
  }
}

function expectClose(
  input: Readonly<{
    readonly label: string;
    readonly actual: number;
    readonly expected: number;
    readonly tolerance: number;
    readonly measured: string;
  }>,
): void {
  expect(
    Math.abs(input.actual - input.expected),
    `${input.label} measured=${String(input.actual)} expected=${String(input.expected)} tolerance=${String(input.tolerance)} ${input.measured}`,
  ).toBeLessThanOrEqual(input.tolerance);
}

function unionOf(rects: readonly WidgetRect[]): {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
} {
  return rects.reduce(
    (union, widget) => ({
      left: Math.min(union.left, widget.rect.x),
      top: Math.min(union.top, widget.rect.y),
      right: Math.max(union.right, widget.rect.x + widget.rect.width),
      bottom: Math.max(union.bottom, widget.rect.y + widget.rect.height),
    }),
    {
      left: Infinity,
      top: Infinity,
      right: -Infinity,
      bottom: -Infinity,
    },
  );
}

async function dispatchWheel(page: Page, input: WheelInput): Promise<void> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: box.x + input.point.x,
    y: box.y + input.point.y,
    deltaX: input.deltaX,
    deltaY: input.deltaY,
    modifiers: input.modifiers ?? 0,
  });
}

test("First opening of a folder", async ({ page }) => {
  const files = [
    { path: "src/zeta.ts", text: sourceText(30) },
    { path: "lib/beta.ts", text: sourceText(40) },
    { path: "app.ts", text: sourceText(50) },
    { path: "src/alpha.ts", text: sourceText(60) },
    { path: "lib/alpha.ts", text: sourceText(70) },
    { path: "tools/gamma.ts", text: sourceText(80) },
    { path: "main.ts", text: sourceText(90) },
  ];
  await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "7");
  await waitForTwoAnimationFrames(page);

  const rects = await readWidgetRects(page);
  const canvasSize = await readCanvasSize(page);
  expectNoOverlaps(rects);
  expectEqualWidths(rects);
  expectInsideInset(rects, canvasSize);

  const expectedPaths = files
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right, "en"));
  const measuredPaths = rowMajor(rects).map((widget) => widget.filePath);
  expect(
    measuredPaths,
    `row-major paths measured=${JSON.stringify(measuredPaths)} expected=${JSON.stringify(expectedPaths)} rects=${JSON.stringify(rects)}`,
  ).toEqual(expectedPaths);
});

test("Short and long files", async ({ page }) => {
  const files = [
    { path: "long.ts", text: sourceText(2000) },
    { path: "short.ts", text: sourceText(20) },
  ];
  await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "2");
  await waitForTwoAnimationFrames(page);

  const rects = await readWidgetRects(page);
  const long = rects.find((widget) => widget.filePath === "long.ts");
  const short = rects.find((widget) => widget.filePath === "short.ts");
  if (!long || !short)
    throw new Error(`Expected widget rects: ${JSON.stringify(rects)}`);
  const frame = await readLastFrame(page);
  const measured = `rects=${JSON.stringify(rects)} camera=${JSON.stringify(frame)}`;
  expect(
    short.rect.height,
    `short height measured=${String(short.rect.height)} long height measured=${String(long.rect.height)} ${measured}`,
  ).toBeLessThan(long.rect.height);
  expectClose({
    label: "long height",
    actual: long.rect.height,
    expected: 900 * frame.cameraScale,
    tolerance: 0.5,
    measured,
  });
  expectClose({
    label: "short height",
    actual: short.rect.height,
    expected:
      (DEFAULT_CODE_FONT.bodyTop + 20 * DEFAULT_CODE_FONT.lineHeight) *
      frame.cameraScale,
    tolerance: 0.5,
    measured,
  });
});

test("Fit all", async ({ page }) => {
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `file-${String(index)}.ts`,
    text: sourceText(60),
  }));
  await installDirectoryMock(page, files);
  await page.goto("/");
  await openFolder(page);

  const before = await readWidgetRects(page);
  const canvasSize = await readCanvasSize(page);
  expect(
    before.some(
      (widget) =>
        widget.rect.x < 0 ||
        widget.rect.y < 0 ||
        widget.rect.x + widget.rect.width > canvasSize.width ||
        widget.rect.y + widget.rect.height > canvasSize.height,
    ),
    `precondition measuredRects=${JSON.stringify(before)} canvas=${JSON.stringify(canvasSize)}`,
  ).toBe(true);

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });
  await page.keyboard.press("Shift+1");
  await waitForTwoAnimationFrames(page);

  const rects = await readWidgetRects(page);
  expectInsideInset(rects, canvasSize);
  const union = unionOf(rects);
  const tight =
    (Math.abs(union.left - CANVAS_INSET) <= GEOMETRY_TOLERANCE &&
      Math.abs(union.right - (canvasSize.width - CANVAS_INSET)) <=
        GEOMETRY_TOLERANCE) ||
    (Math.abs(union.top - CANVAS_INSET) <= GEOMETRY_TOLERANCE &&
      Math.abs(union.bottom - (canvasSize.height - CANVAS_INSET)) <=
        GEOMETRY_TOLERANCE);
  expect(
    tight,
    `fit bounds measured=${JSON.stringify(union)} expectedInset=${String(CANVAS_INSET)} canvas=${JSON.stringify(canvasSize)} rects=${JSON.stringify(rects)}`,
  ).toBe(true);
});

test("Reopening", async ({ page }) => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    path: `file-${String(index)}.ts`,
    text: sourceText(60),
  }));
  await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");
  await waitForTwoAnimationFrames(page);

  const canvasSize = await readCanvasSize(page);
  const center = { x: canvasSize.width / 2, y: canvasSize.height / 2 };
  for (let index = 0; index < 5; index += 1) {
    await dispatchWheel(page, { point: center, deltaX: 40, deltaY: 30 });
  }
  for (let index = 0; index < 3; index += 1) {
    await dispatchWheel(page, {
      point: center,
      deltaX: 0,
      deltaY: -20,
      modifiers: 2,
    });
  }
  await waitForTwoAnimationFrames(page);
  const expectedCamera = await readLastFrame(page);
  await page.waitForTimeout(1500);

  await page.reload();
  await page.getByTestId("open-folder").click();
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-widget-count",
    "3",
  );
  await waitForTwoAnimationFrames(page);
  const actualCamera = await readLastFrame(page);
  const measured = `measuredCamera=${JSON.stringify(actualCamera)} expectedCamera=${JSON.stringify(expectedCamera)}`;
  expectClose({
    label: "camera offset x",
    actual: actualCamera.cameraOffsetX,
    expected: expectedCamera.cameraOffsetX,
    tolerance: 0.5,
    measured,
  });
  expectClose({
    label: "camera offset y",
    actual: actualCamera.cameraOffsetY,
    expected: expectedCamera.cameraOffsetY,
    tolerance: 0.5,
    measured,
  });
  expectClose({
    label: "camera scale",
    actual: actualCamera.cameraScale,
    expected: expectedCamera.cameraScale,
    tolerance: 1e-3,
    measured,
  });
});
