import { expect, test } from "@playwright/test";

import {
  WIDGET_FRAME_COLOR,
  WIDGET_HEADER_COLOR,
  WIDGET_SCROLL_THUMB_COLOR,
} from "../../src/rendering/widget-colors";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  installDirectoryMock,
  openFolder,
  readCanvasColumn,
  readCanvasPixel,
  readWidgetRects,
  type Pixel,
} from "./support";

test.use({ deviceScaleFactor: 2 });

const SCROLL_GUTTER_WIDTH = 12;
const MINIMUM_SCROLL_THUMB_HEIGHT = 20;

function lines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `const value${String(index)} = 1;`,
  ).join("\n");
}

function colorFromHex(color: string): Pixel {
  const value = Number.parseInt(color.slice(1), 16);
  return {
    red: (value >> 16) & 0xff,
    green: (value >> 8) & 0xff,
    blue: value & 0xff,
  };
}

function thumbRun(
  pixels: readonly Pixel[],
  color: Pixel,
): { start: number; height: number } | undefined {
  const first = pixels.findIndex(
    (pixel) =>
      pixel.red === color.red &&
      pixel.green === color.green &&
      pixel.blue === color.blue,
  );
  if (first < 0) return undefined;
  let end = first;
  while (end + 1 < pixels.length) {
    const pixel = pixels[end + 1];
    if (
      pixel?.red !== color.red ||
      pixel.green !== color.green ||
      pixel.blue !== color.blue
    )
      break;
    end += 1;
  }
  return { start: first, height: end - first + 1 };
}

async function waitForFrames(
  page: Parameters<typeof openFolder>[0],
): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
}

async function scanThumb(
  page: Parameters<typeof openFolder>[0],
  rect: { x: number; y: number; width: number; height: number },
): Promise<{ start: number; height: number } | undefined> {
  const bodyTop = rect.y + DEFAULT_CODE_FONT.bodyTop;
  const canvas = page.getByTestId("canvas");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Canvas bounds are unavailable");
  const bodyBottom = Math.min(
    rect.y + rect.height - 1,
    canvasBox.y + canvasBox.height - 1,
  );
  const x = rect.x + rect.width - SCROLL_GUTTER_WIDTH / 2;
  const pixels = await readCanvasColumn(page, x, bodyTop, bodyBottom);
  return thumbRun(pixels, colorFromHex(WIDGET_SCROLL_THUMB_COLOR));
}

test("Scroll indicator", async ({ page }) => {
  await installDirectoryMock(page, lines(300), "scroll.ts");
  await page.goto("/");
  await openFolder(page);
  await waitForFrames(page);

  const rect = (await readWidgetRects(page))[0]?.rect;
  if (!rect) throw new Error("Scroll widget rect is unavailable");
  const bodyTop = rect.y + DEFAULT_CODE_FONT.bodyTop;
  const bodyHeight = rect.height - DEFAULT_CODE_FONT.bodyTop;
  const contentHeight = Math.max(
    bodyHeight,
    lines(300).split("\n").length * DEFAULT_CODE_FONT.lineHeight,
  );
  const expectedHeight = Math.max(
    MINIMUM_SCROLL_THUMB_HEIGHT,
    (bodyHeight * bodyHeight) / contentHeight,
  );
  const initialThumb = await scanThumb(page, rect);
  expect(initialThumb).toBeDefined();
  expect(initialThumb?.start).toBeLessThanOrEqual(2);
  expect(
    Math.abs((initialThumb?.height ?? 0) - expectedHeight),
  ).toBeLessThanOrEqual(2);
  expect(
    await readCanvasPixel(page, rect.x + rect.width - 20, rect.y + 16),
  ).toEqual(colorFromHex(WIDGET_HEADER_COLOR));
  expect(
    await readCanvasPixel(page, rect.x + rect.width / 2, rect.y + 0.25),
  ).toEqual(colorFromHex(WIDGET_FRAME_COLOR));

  await page.mouse.move(rect.x + rect.width / 2, bodyTop + bodyHeight / 2);
  await page.mouse.wheel(0, 400);
  await waitForFrames(page);
  const movedThumb = await scanThumb(page, rect);
  expect(movedThumb).toBeDefined();
  expect(movedThumb?.start).toBeGreaterThan(initialThumb?.start ?? 0);

  const shortPage = await page.context().newPage();
  await installDirectoryMock(shortPage, "one\ntwo\nthree", "short.ts");
  await shortPage.goto("/");
  await openFolder(shortPage);
  await waitForFrames(shortPage);
  const shortRect = (await readWidgetRects(shortPage))[0]?.rect;
  if (!shortRect) throw new Error("Short widget rect is unavailable");
  expect(await scanThumb(shortPage, shortRect)).toBeUndefined();
});
