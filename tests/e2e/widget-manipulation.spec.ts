import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
  readCanvasRegion,
  readWidgetRects,
  type Pixel,
  type WidgetRect,
} from "./support";

const EDGE_GRAB_OFFSET_PX = 4;
// Mirrors boardMetrics in src/app/main.ts:103-111.
const MINIMUM_WIDTH = 240;
const MINIMUM_HEIGHT =
  DEFAULT_CODE_FONT.bodyTop + 3 * DEFAULT_CODE_FONT.lineHeight;

function sourceLines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => {
    if (index % 4 === 0)
      return `const value${prefix}${String(index)}: number = ${String(index)};`;
    if (index % 4 === 1)
      return `const label${prefix}${String(index)} = "line-${String(index)}";`;
    if (index % 4 === 2)
      return `if (value${prefix}${String(index - 2)} >= 0) console.log(label${prefix}${String(index - 1)});`;
    return `// highlighted line ${String(index)}`;
  }).join("\n");
}

function threeFiles(): readonly { path: string; text: string }[] {
  return [
    { path: "a.ts", text: sourceLines(60, "A") },
    { path: "b.ts", text: sourceLines(60, "B") },
    { path: "c.ts", text: sourceLines(60, "C") },
  ];
}

function rectFor(rects: readonly WidgetRect[], filePath: string): WidgetRect {
  const widget = rects.find((candidate) => candidate.filePath === filePath);
  if (widget) return widget;
  throw new Error(
    `Widget rect is missing: filePath=${filePath} rects=${JSON.stringify(rects)}`,
  );
}

async function readScale(page: Page): Promise<number> {
  const value = await page
    .getByTestId("canvas")
    .getAttribute("data-text-metrics-scale");
  const scale = Number(value);
  if (!Number.isFinite(scale))
    throw new Error(`Camera scale is unavailable: value=${String(value)}`);
  return scale;
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

async function waitForSettledTiles(page: Page): Promise<void> {
  let frame: unknown;
  try {
    await expect
      .poll(
        async () => {
          frame = await page.evaluate(() => {
            const entries = window.__codeCanvasTest?.frameLog();
            return entries?.[entries.length - 1];
          });
          const entry = frame as
            | {
                drawnTileCount?: number;
                drawnUnhighlightedTileCount?: number;
              }
            | undefined;
          return (
            (entry?.drawnTileCount ?? 0) > 0 &&
            entry?.drawnUnhighlightedTileCount === 0
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `Tiles did not settle: frame=${JSON.stringify(frame)}\n${String(error)}`,
    );
  }
}

function rectDiagnostic(
  actual: WidgetRect,
  expected: WidgetRect,
  scale: number,
  rects: readonly WidgetRect[],
): string {
  return (
    `actualRect=${JSON.stringify(actual.rect)} ` +
    `expectedRect=${JSON.stringify(expected.rect)} scale=${String(scale)} ` +
    `rects=${JSON.stringify(rects)}`
  );
}

function expectRectWithin(
  actual: WidgetRect,
  expected: WidgetRect,
  scale: number,
  rects: readonly WidgetRect[],
): void {
  expect(
    actual.filePath,
    `Widget path mismatch: ${rectDiagnostic(actual, expected, scale, rects)}`,
  ).toBe(expected.filePath);
  for (const field of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(actual.rect[field] - expected.rect[field]),
      `Widget ${field} mismatch: ${rectDiagnostic(actual, expected, scale, rects)}`,
    ).toBeLessThanOrEqual(0.5);
  }
}

function expectOtherRectsUnchanged(
  actual: readonly WidgetRect[],
  expected: readonly WidgetRect[],
  targetPath: string,
  scale: number,
): void {
  const actualOthers = actual
    .filter((widget) => widget.filePath !== targetPath)
    .map((widget) => ({ filePath: widget.filePath, rect: widget.rect }));
  const expectedOthers = expected
    .filter((widget) => widget.filePath !== targetPath)
    .map((widget) => ({ filePath: widget.filePath, rect: widget.rect }));
  expect(
    actualOthers,
    `Other widget rects changed: actualRects=${JSON.stringify(actual)} ` +
      `expectedRects=${JSON.stringify(expected)} scale=${String(scale)}`,
  ).toEqual(expectedOthers);
}

function pixelKey(pixel: Pixel): string {
  return `${String(pixel.red)},${String(pixel.green)},${String(pixel.blue)}`;
}

interface DiagnosticContext {
  readonly scale: number;
  readonly rects: readonly WidgetRect[];
}

function distinctColorCount(pixels: readonly Pixel[]): number {
  return new Set(pixels.map(pixelKey)).size;
}

async function expectTextColours(
  page: Page,
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  label: string,
  context: DiagnosticContext,
): Promise<void> {
  const pixels = await readCanvasRegion(page, region, 1);
  const colourCount = distinctColorCount(pixels);
  expect(
    colourCount,
    `${label}: colourCount=${String(colourCount)} pixels=${String(pixels.length)} ` +
      `region=${JSON.stringify(region)} scale=${String(context.scale)} rects=${JSON.stringify(context.rects)}`,
  ).toBeGreaterThanOrEqual(3);
}

function expectRegionsIdentical(
  before: readonly Pixel[],
  after: readonly Pixel[],
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  context: DiagnosticContext,
): void {
  let mismatch = -1;
  for (
    let index = 0;
    index < Math.max(before.length, after.length);
    index += 1
  ) {
    const left = before[index];
    const right = after[index];
    if (!left || !right || pixelKey(left) !== pixelKey(right)) {
      mismatch = index;
      break;
    }
  }
  expect(
    mismatch,
    `Top region changed: mismatchIndex=${String(mismatch)} ` +
      `beforePixel=${JSON.stringify(before[mismatch])} afterPixel=${JSON.stringify(after[mismatch])} ` +
      `region=${JSON.stringify(region)} scale=${String(context.scale)} rects=${JSON.stringify(context.rects)}`,
  ).toBe(-1);
}

function headerPoint(
  widget: WidgetRect,
  scale: number,
): { x: number; y: number } {
  return {
    x: widget.rect.x + widget.rect.width / 2,
    y: widget.rect.y + (DEFAULT_CODE_FONT.bodyTop * scale) / 2,
  };
}

function bottomEdgePoint(widget: WidgetRect): { x: number; y: number } {
  return {
    x: widget.rect.x + widget.rect.width / 2,
    y: widget.rect.y + widget.rect.height + EDGE_GRAB_OFFSET_PX,
  };
}

function cornerPoint(widget: WidgetRect): { x: number; y: number } {
  return {
    x: widget.rect.x + widget.rect.width + EDGE_GRAB_OFFSET_PX,
    y: widget.rect.y + widget.rect.height + EDGE_GRAB_OFFSET_PX,
  };
}

async function dragInSteps(
  page: Page,
  start: { readonly x: number; readonly y: number },
  delta: { readonly x: number; readonly y: number },
  waitForFrames: boolean,
): Promise<void> {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      start.x + (delta.x * step) / 10,
      start.y + (delta.y * step) / 10,
    );
    if (waitForFrames) await waitForOneAnimationFrame(page);
  }
  await page.mouse.up();
}

test("Dragging by the header", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, threeFiles());
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);

  const scale = await readScale(page);
  const before = await readWidgetRects(page);
  const target = before.find((widget) => widget.filePath === "a.ts");
  if (!target)
    throw new Error(`First widget is missing: rects=${JSON.stringify(before)}`);
  const start = headerPoint(target, scale);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(start.x + step * 15, start.y + step * 9);
    await waitForOneAnimationFrame(page);
    const actual = await readWidgetRects(page);
    const moved = rectFor(actual, target.filePath);
    const expected: WidgetRect = {
      ...target,
      rect: {
        ...target.rect,
        x: target.rect.x + step * 15,
        y: target.rect.y + step * 9,
      },
    };
    expectRectWithin(moved, expected, scale, actual);
    expectOtherRectsUnchanged(actual, before, target.filePath, scale);
  }
  await page.mouse.up();
});

test("Stack order", async ({ page }) => {
  await installDirectoryMock(page, threeFiles());
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  const scale = await readScale(page);
  const before = await readWidgetRects(page);
  const viewport = await canvas.boundingBox();
  if (!viewport)
    throw new Error("Canvas bounds are unavailable: width=0 height=0");
  const target = before.slice(1).find(({ rect }) => {
    const bodyTop = rect.y + DEFAULT_CODE_FONT.bodyTop * scale;
    return (
      bodyTop < viewport.height &&
      rect.y + rect.height > bodyTop &&
      rect.x < viewport.width
    );
  });
  if (!target)
    throw new Error(
      `No visible non-top widget: scale=${String(scale)} rects=${JSON.stringify(before)}`,
    );
  await page.mouse.click(
    target.rect.x + Math.min(120, target.rect.width / 2),
    target.rect.y + DEFAULT_CODE_FONT.bodyTop * scale + 20,
  );
  await waitForTwoAnimationFrames(page);
  const afterClick = await readWidgetRects(page);
  expect(
    afterClick[0]?.filePath,
    `Stack order after click: actualRects=${JSON.stringify(afterClick)} ` +
      `target=${target.filePath} scale=${String(scale)}`,
  ).toBe(target.filePath);

  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");
  const afterReload = await readWidgetRects(page);
  expect(
    afterReload[0]?.filePath,
    `Stack order after reload: actualRects=${JSON.stringify(afterReload)} ` +
      `target=${target.filePath} scale=${String(await readScale(page))}`,
  ).toBe(target.filePath);
});

test("Increasing height", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, sourceLines(200, "height"));
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() =>
    window.__codeCanvasTest?.setCamera(60, 560 - 900, 1),
  );
  await expectHighlighted(page, browserErrors);
  await waitForSettledTiles(page);

  const scale = await readScale(page);
  const before = await readWidgetRects(page);
  const target = rectFor(before, "widget-000.tsx");
  const topRegion = { x: target.rect.x + 40, y: 80, width: 300, height: 100 };
  const topBefore = await readCanvasRegion(page, topRegion, 1);
  await dragInSteps(page, bottomEdgePoint(target), { x: 0, y: 120 }, true);
  await waitForTwoAnimationFrames(page);
  const after = await readWidgetRects(page);
  const resized = rectFor(after, target.filePath);
  const expected: WidgetRect = {
    ...target,
    rect: { ...target.rect, height: target.rect.height + 120 * scale },
  };
  expectRectWithin(resized, expected, scale, after);
  const strip = { x: target.rect.x + 40, y: 568, width: 300, height: 104 };
  await expectTextColours(page, strip, "Newly exposed strip", {
    scale,
    rects: after,
  });
  const topAfter = await readCanvasRegion(page, topRegion, 1);
  expectRegionsIdentical(topBefore, topAfter, topRegion, {
    scale,
    rects: after,
  });
});

test("Minimum size", async ({ page }) => {
  await installDirectoryMock(page, sourceLines(5, "minimum"));
  await page.goto("/");
  await openFolder(page);
  const scale = await readScale(page);
  const before = await readWidgetRects(page);
  const target = rectFor(before, "widget-000.tsx");
  await dragInSteps(
    page,
    cornerPoint(target),
    { x: 100 - cornerPoint(target).x, y: 30 - cornerPoint(target).y },
    false,
  );
  await waitForTwoAnimationFrames(page);
  const after = await readWidgetRects(page);
  const resized = rectFor(after, target.filePath);
  const expected: WidgetRect = {
    ...target,
    rect: {
      ...target.rect,
      width: MINIMUM_WIDTH * scale,
      height: MINIMUM_HEIGHT * scale,
    },
  };
  expectRectWithin(resized, expected, scale, after);
});

test("Resizing while scrolled to the end", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, sourceLines(2000, "scroll"));
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() =>
    window.__codeCanvasTest?.setCamera(60, 560 - 900, 1),
  );
  await expectHighlighted(page, browserErrors);
  await waitForSettledTiles(page);

  const scale = await readScale(page);
  const before = await readWidgetRects(page);
  const target = rectFor(before, "widget-000.tsx");
  const bodyPoint = { x: target.rect.x + 100, y: 100 };
  await page.mouse.move(bodyPoint.x, bodyPoint.y);
  for (let index = 0; index < 25; index += 1) await page.mouse.wheel(0, 2000);
  await waitForSettledTiles(page);
  const atEnd = await readWidgetRects(page);
  const endRect = rectFor(atEnd, target.filePath).rect;
  await expectTextColours(
    page,
    {
      x: endRect.x + 40,
      y: endRect.y + endRect.height - DEFAULT_CODE_FONT.lineHeight * scale - 4,
      width: 300,
      height: DEFAULT_CODE_FONT.lineHeight * scale,
    },
    "End-of-file band before resize",
    { scale, rects: atEnd },
  );

  await dragInSteps(
    page,
    bottomEdgePoint(rectFor(atEnd, target.filePath)),
    { x: 0, y: 120 },
    false,
  );
  await waitForSettledTiles(page);
  const after = await readWidgetRects(page);
  const resized = rectFor(after, target.filePath);
  const expected: WidgetRect = {
    ...target,
    rect: { ...target.rect, height: target.rect.height + 120 * scale },
  };
  expectRectWithin(resized, expected, scale, after);
  await expectTextColours(
    page,
    {
      x: resized.rect.x + 40,
      y:
        resized.rect.y +
        resized.rect.height -
        DEFAULT_CODE_FONT.lineHeight * scale -
        4,
      width: 300,
      height: DEFAULT_CODE_FONT.lineHeight * scale,
    },
    "End-of-file band after resize",
    { scale, rects: after },
  );
});

test("Dragging at a far zoom level", async ({ page }) => {
  await installDirectoryMock(page, threeFiles());
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() => window.__codeCanvasTest?.setCamera(60, 76, 0.1));
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-detail-level", "minimap");

  const scale = await readScale(page);
  const before = await readWidgetRects(page);
  const target = before[0];
  if (!target)
    throw new Error(
      `First minimap widget is missing: rects=${JSON.stringify(before)}`,
    );
  const start = {
    x: target.rect.x + target.rect.width / 2,
    y: target.rect.y + target.rect.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(start.x + step * 6, start.y + step * 4);
    await waitForOneAnimationFrame(page);
    const actual = await readWidgetRects(page);
    const moved = rectFor(actual, target.filePath);
    const expected: WidgetRect = {
      ...target,
      rect: {
        ...target.rect,
        x: target.rect.x + step * 6,
        y: target.rect.y + step * 4,
      },
    };
    expectRectWithin(moved, expected, scale, actual);
    expectOtherRectsUnchanged(actual, before, target.filePath, scale);
  }
  await page.mouse.up();
});
