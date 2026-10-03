import { expect, test, type Page } from "@playwright/test";

import { CANVAS_CLEAR_COLOR } from "../../src/rendering/clear-color";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  installDirectoryMock,
  openFolder,
  readCanvasPixel,
  readCanvasRegion,
  readWidgetRects,
  type DirectoryMockFile,
  type Pixel,
  type WidgetRect,
} from "./support";

test.use({ deviceScaleFactor: 2 });

const FILES: readonly DirectoryMockFile[] = [
  { path: "a.ts", text: "const a = 1;\n" },
  { path: "b.ts", text: "const b = 2;\n" },
  { path: "c.ts", text: "const c = 3;\n" },
];
const WIDGET_BACKGROUND: Pixel = { red: 30, green: 30, blue: 30 };
const CANVAS_BACKGROUND: Pixel = {
  red: Math.round(CANVAS_CLEAR_COLOR.red * 255),
  green: Math.round(CANVAS_CLEAR_COLOR.green * 255),
  blue: Math.round(CANVAS_CLEAR_COLOR.blue * 255),
};

function fortyLines(): string {
  return Array.from(
    { length: 40 },
    (_, line) => `const value${String(line)} = ${String(line)};`,
  ).join("\n");
}

async function bandColorCount(input: {
  readonly page: Page;
  readonly widget: WidgetRect;
  readonly top: number;
  readonly bottom: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly inset?: number;
  readonly xStep?: number;
}): Promise<number> {
  const colors = new Set<string>();
  const inset = input.inset ?? 12;
  const xStep = input.xStep ?? 12;
  const left = Math.max(0, Math.ceil(input.widget.rect.x + inset));
  const right = Math.min(
    input.canvasWidth - 1,
    Math.floor(input.widget.rect.x + input.widget.rect.width - inset),
  );
  const top = Math.max(0, Math.ceil(input.top));
  const bottom = Math.min(input.canvasHeight - 1, Math.floor(input.bottom));
  if (left > right || top > bottom) return 0;
  const pixels = await readCanvasRegion(
    input.page,
    {
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
    },
    xStep,
  );
  for (const pixel of pixels) {
    colors.add(
      `${String(pixel.red)},${String(pixel.green)},${String(pixel.blue)}`,
    );
  }
  return colors.size;
}

async function minimapBodyColors(input: {
  readonly page: Page;
  readonly widget: WidgetRect;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): Promise<readonly string[]> {
  const left = Math.max(0, Math.ceil(input.widget.rect.x + 2));
  const right = Math.min(
    input.canvasWidth,
    Math.floor(input.widget.rect.x + input.widget.rect.width - 2),
  );
  const top = Math.max(
    0,
    Math.ceil(input.widget.rect.y + DEFAULT_CODE_FONT.bodyTop * 0.2 + 2),
  );
  const bottom = Math.min(
    input.canvasHeight,
    Math.floor(input.widget.rect.y + input.widget.rect.height - 2),
  );
  if (left >= right || top >= bottom) return [];
  const pixels = await readCanvasRegion(
    input.page,
    { x: left, y: top, width: right - left, height: bottom - top },
    1,
  );
  const colors = new Set<string>();
  for (const pixel of pixels) {
    colors.add(
      `${String(pixel.red)},${String(pixel.green)},${String(pixel.blue)}`,
    );
  }
  return [...colors];
}

async function minimapBodyBrightPixels(input: {
  readonly page: Page;
  readonly widget: WidgetRect;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): Promise<number> {
  const left = Math.max(0, Math.ceil(input.widget.rect.x + 2));
  const right = Math.min(
    input.canvasWidth,
    Math.floor(input.widget.rect.x + input.widget.rect.width - 2),
  );
  const top = Math.max(
    0,
    Math.ceil(input.widget.rect.y + DEFAULT_CODE_FONT.bodyTop * 0.2 + 2),
  );
  const bottom = Math.min(
    input.canvasHeight,
    Math.floor(input.widget.rect.y + input.widget.rect.height - 2),
  );
  if (left >= right || top >= bottom) return 0;
  const pixels = await readCanvasRegion(
    input.page,
    { x: left, y: top, width: right - left, height: bottom - top },
    1,
  );
  return pixels.filter(
    (pixel) => pixel.red >= 230 && pixel.green >= 230 && pixel.blue >= 230,
  ).length;
}

interface MinimapLabelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface BrightestPixel {
  readonly x: number;
  readonly y: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly brightness: number;
}

interface MinimapLabelDiagnostic {
  readonly region: MinimapLabelRegion;
  readonly brightestPixel: BrightestPixel | undefined;
}

interface FrameLogDiagnosticEntry {
  readonly tick: number;
  readonly detailLevel: 0 | 1;
  readonly drawnTileCount: number;
  readonly drawnLabelTileCount: number;
  readonly drawnMinimapCount: number;
  readonly missingTile: boolean;
}

function minimapLabelRegion(input: {
  readonly widget: WidgetRect;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): MinimapLabelRegion {
  const left = Math.max(0, Math.ceil(input.widget.rect.x + 2));
  const right = Math.min(
    input.canvasWidth,
    Math.floor(input.widget.rect.x + input.widget.rect.width - 2),
  );
  const top = Math.max(
    0,
    Math.ceil(input.widget.rect.y + DEFAULT_CODE_FONT.bodyTop * 0.2 + 2),
  );
  const bottom = Math.min(
    input.canvasHeight,
    Math.floor(input.widget.rect.y + input.widget.rect.height - 2),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function readMinimapLabelDiagnostic(input: {
  readonly page: Page;
  readonly widget: WidgetRect;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): Promise<MinimapLabelDiagnostic> {
  const region = minimapLabelRegion(input);
  if (region.width <= 0 || region.height <= 0)
    return { region, brightestPixel: undefined };
  const pixels = await readCanvasRegion(input.page, region, 1);
  let brightestPixel: BrightestPixel | undefined;
  for (let column = 0; column < region.width; column += 1) {
    for (let row = 0; row < region.height; row += 1) {
      const pixel = pixels[column * region.height + row];
      if (!pixel) continue;
      const brightness = pixel.red + pixel.green + pixel.blue;
      if (brightestPixel && brightness <= brightestPixel.brightness) continue;
      brightestPixel = {
        x: region.x + column,
        y: region.y + row,
        red: pixel.red,
        green: pixel.green,
        blue: pixel.blue,
        brightness,
      };
    }
  }
  return { region, brightestPixel };
}

async function readLastFrameLog(
  page: Page,
): Promise<readonly FrameLogDiagnosticEntry[]> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) return [];
    return hook
      .frameLog()
      .slice(-5)
      .map((entry) => ({
        tick: entry.tick,
        detailLevel: entry.detailLevel,
        drawnTileCount: entry.drawnTileCount,
        drawnLabelTileCount: entry.drawnLabelTileCount,
        drawnMinimapCount: entry.drawnMinimapCount,
        missingTile: entry.missingTile,
      }));
  });
}

async function pollLateMinimapLabel(
  input: {
    readonly page: Page;
    readonly widget: WidgetRect;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
  },
  readCount: () => Promise<number>,
): Promise<string | undefined> {
  try {
    await expect
      .poll(readCount, {
        timeout: 15000,
        message: `${input.widget.filePath} late minimap label bright-pixel count`,
      })
      .toBeGreaterThanOrEqual(12);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

async function expectMinimapLabel(input: {
  readonly page: Page;
  readonly widget: WidgetRect;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): Promise<void> {
  let brightPixels = 0;
  const startedAt = Date.now();
  let reachedAfterMs: number | undefined;
  const readCount = async (): Promise<number> => {
    brightPixels = await minimapBodyBrightPixels(input);
    if (brightPixels >= 12 && reachedAfterMs === undefined)
      reachedAfterMs = Date.now() - startedAt;
    return brightPixels;
  };
  try {
    await expect
      .poll(
        async () => {
          return readCount();
        },
        {
          timeout: 5000,
          message: `${input.widget.filePath} minimap label bright-pixel count`,
        },
      )
      .toBeGreaterThanOrEqual(12);
  } catch (error) {
    const lateError = await pollLateMinimapLabel(input, readCount);
    const diagnostic = await readMinimapLabelDiagnostic(input);
    const detailLevel = await input.page
      .getByTestId("canvas")
      .getAttribute("data-detail-level");
    const cameraScale = await input.page
      .getByTestId("canvas")
      .getAttribute("data-text-metrics-scale");
    const frameLog = await readLastFrameLog(input.page);
    const timing =
      reachedAfterMs === undefined
        ? "never"
        : `after ${String(reachedAfterMs)}ms`;
    const message = lateError ?? "late poll reached threshold";
    throw new Error(
      `${input.widget.filePath} minimap label bright-pixel count ${String(brightPixels)} ` +
        `detail-level=${detailLevel ?? "unknown"} late-or-never=${timing} ` +
        `region=${JSON.stringify(diagnostic.region)} ` +
        `brightestPixel=${JSON.stringify(diagnostic.brightestPixel)} ` +
        `cameraScale=${String(cameraScale)} ` +
        `lastFrameLog=${JSON.stringify(frameLog)}\n${message}\n${String(error)}`,
    );
  }
}

async function expectBandColors(input: {
  readonly page: Page;
  readonly widget: WidgetRect;
  readonly band: string;
  readonly minimum: number;
  readonly top: number;
  readonly bottom: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}): Promise<void> {
  let count = 0;
  try {
    await expect
      .poll(
        async () => {
          count = await bandColorCount(input);
          return count;
        },
        {
          timeout: 5000,
          message: `${input.widget.filePath} ${input.band} band`,
        },
      )
      .toBeGreaterThanOrEqual(input.minimum);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${input.widget.filePath} ${input.band} band colour count ${String(count)}\n${message}`,
    );
  }
}

function intersectsCanvas(
  widget: WidgetRect,
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  return (
    widget.rect.x < canvasWidth &&
    widget.rect.x + widget.rect.width > 0 &&
    widget.rect.y < canvasHeight &&
    widget.rect.y + widget.rect.height > 0
  );
}

function center(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): {
  x: number;
  y: number;
} {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function gapPoint(
  rects: readonly WidgetRect[],
): { x: number; y: number } | undefined {
  for (const left of rects) {
    for (const right of rects) {
      const gap = right.rect.x - (left.rect.x + left.rect.width);
      const top = Math.max(left.rect.y, right.rect.y);
      const bottom = Math.min(
        left.rect.y + left.rect.height,
        right.rect.y + right.rect.height,
      );
      if (gap > 4 && bottom > top) {
        return {
          x: left.rect.x + left.rect.width + gap / 2,
          y: (top + bottom) / 2,
        };
      }
    }
  }
  throw new Error("No visible widget gap found");
}

async function expectWidgetBackgrounds(page: Page): Promise<void> {
  const rects = await readWidgetRects(page);
  expect(rects).toHaveLength(3);
  for (const widget of rects) {
    const point = center(widget.rect);
    const pixel = await readCanvasPixel(page, point.x, point.y);
    expect(pixel).toEqual(WIDGET_BACKGROUND);
  }
  const gap = gapPoint(rects);
  if (!gap) throw new Error("Widget gap is unavailable");
  expect(await readCanvasPixel(page, gap.x, gap.y)).toEqual(CANVAS_BACKGROUND);
}

test("Every widget is drawn from the WidgetTable", async ({ page }) => {
  await installDirectoryMock(page, FILES);
  await page.goto("/");
  await openFolder(page);
  await expectWidgetBackgrounds(page);

  await page.evaluate(() => {
    window.__codeCanvasTest?.setCamera(0, 0, 1);
  });
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
  await expectWidgetBackgrounds(page);
});

test("Displaying a file", async ({ page }) => {
  await installDirectoryMock(page, [
    { path: "a.ts", text: fortyLines() },
    { path: "b.ts", text: fortyLines() },
    { path: "c.ts", text: fortyLines() },
  ]);
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() => window.__codeCanvasTest?.setCamera(0, 0, 1));
  const canvasBox = await page.getByTestId("canvas").boundingBox();
  if (!canvasBox) throw new Error("Canvas bounds are unavailable");
  const canvasWidth = Math.floor(canvasBox.width);
  const canvasHeight = Math.floor(canvasBox.height);
  await expect
    .poll(
      async () =>
        (await readWidgetRects(page)).filter((widget) =>
          intersectsCanvas(widget, canvasWidth, canvasHeight),
        ).length,
    )
    .toBeGreaterThanOrEqual(2);
  const widgets = (await readWidgetRects(page)).filter((widget) =>
    intersectsCanvas(widget, canvasWidth, canvasHeight),
  );
  for (const widget of widgets) {
    await expectBandColors({
      page,
      widget,
      band: "header",
      minimum: 2,
      top: widget.rect.y + 2,
      bottom: widget.rect.y + DEFAULT_CODE_FONT.bodyTop - 2,
      canvasWidth,
      canvasHeight,
    });
    await expectBandColors({
      page,
      widget,
      band: "body",
      minimum: 3,
      top: widget.rect.y + DEFAULT_CODE_FONT.bodyTop,
      bottom:
        widget.rect.y +
        DEFAULT_CODE_FONT.bodyTop +
        DEFAULT_CODE_FONT.lineHeight,
      canvasWidth,
      canvasHeight,
    });
  }
});

test("Zooming out to the minimap", async ({ page }) => {
  await installDirectoryMock(page, [
    { path: "a.ts", text: fortyLines() },
    { path: "b.ts", text: fortyLines() },
    { path: "c.ts", text: fortyLines() },
  ]);
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() => {
    window.__codeCanvasTest?.setCamera(0, 0, 0.2);
  });
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-detail-level",
    "minimap",
  );
  const canvasBox = await page.getByTestId("canvas").boundingBox();
  if (!canvasBox) throw new Error("Canvas bounds are unavailable");
  const widgets = (await readWidgetRects(page)).filter((widget) =>
    intersectsCanvas(
      widget,
      Math.floor(canvasBox.width),
      Math.floor(canvasBox.height),
    ),
  );
  expect(widgets).toHaveLength(3);
  for (const widget of widgets) {
    let colors: readonly string[] = [];
    try {
      await expect
        .poll(
          async () => {
            colors = await minimapBodyColors({
              page,
              widget,
              canvasWidth: Math.floor(canvasBox.width),
              canvasHeight: Math.floor(canvasBox.height),
            });
            return colors.length;
          },
          { timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(3);
    } catch (error) {
      const detailLevel = await page
        .getByTestId("canvas")
        .getAttribute("data-detail-level");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${widget.filePath} minimap body colour count ${String(colors.length)} ` +
          `[${colors.slice(0, 8).join(", ")}] detail-level=${detailLevel ?? "unknown"}\n${message}`,
      );
    }

    await expectMinimapLabel({
      page,
      widget,
      canvasWidth: Math.floor(canvasBox.width),
      canvasHeight: Math.floor(canvasBox.height),
    });
  }
});
