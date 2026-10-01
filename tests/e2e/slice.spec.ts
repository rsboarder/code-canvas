import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const referenceFile = resolve(
  "fixtures/reference-dataset/group-00/widget-000.tsx",
);

test.use({ deviceScaleFactor: 2 });

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(`PAGEERROR: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`CONSOLE: ${message.text()}`);
    }
  });
  return errors;
}

async function expectHighlighted(
  page: Page,
  browserErrors: string[],
): Promise<void> {
  try {
    await expect(page.getByTestId("canvas")).toHaveAttribute(
      "data-highlighted",
      "true",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nBrowser diagnostics:\n${browserErrors.join("\n")}`,
    );
  }
}

async function installDirectoryMock(page: Page, text: string): Promise<void> {
  await page.addInitScript((fileText: string) => {
    const file = {
      kind: "file",
      name: "widget-000.tsx",
      getFile: () =>
        Promise.resolve(
          new File([fileText], "widget-000.tsx", { type: "text/plain" }),
        ),
    };
    const directory = {
      kind: "directory",
      name: "workspace",
      entries: async function* () {
        await Promise.resolve();
        yield ["widget-000.tsx", file];
      },
    };
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: () => Promise.resolve(directory),
    });
  }, text);
}

interface WidgetBodyRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ScreenshotPattern {
  readonly distinct: number;
  readonly varyingRows: number;
  readonly width: number;
  readonly height: number;
  readonly topBuckets: readonly { bucket: string; count: number }[];
}

interface ScreenshotOptions {
  readonly requiredDistinct: number;
  readonly artifactPath: string;
}

function widgetBodyClip(
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
  rect: WidgetBodyRect,
): { x: number; y: number; width: number; height: number } | undefined {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(box.width, rect.x + rect.width);
  const bottom = Math.min(box.height, rect.y + rect.height);
  if (right <= left || bottom <= top) return undefined;
  return {
    x: box.x + left,
    y: box.y + top,
    width: right - left,
    height: bottom - top,
  };
}

async function readScreenshotPattern(
  page: Page,
  options: ScreenshotOptions,
): Promise<ScreenshotPattern> {
  await waitForTwoAnimationFrames(page);
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  const rectValue = await canvas.getAttribute("data-widget-body-rect");
  if (!box || !rectValue) {
    throw new Error(
      `Widget body rect unavailable: rect=${rectValue ?? "<missing>"} clip=<none>`,
    );
  }
  const rect = JSON.parse(rectValue) as WidgetBodyRect;
  const clip = widgetBodyClip(box, rect);
  if (!clip) {
    throw new Error(
      `Widget body clip is empty: rect=${JSON.stringify(rect)} clip=<empty>`,
    );
  }
  const screenshot = await page.screenshot({
    clip,
    path: options.artifactPath,
  });
  const pattern = await analyzeScreenshot(page, screenshot);
  if (pattern.distinct < options.requiredDistinct) {
    throw new Error(
      `Pixel pattern has ${String(pattern.distinct)} colours; required ${String(options.requiredDistinct)}; ` +
        `rect=${JSON.stringify(rect)} clip=${JSON.stringify(clip)} ` +
        `size=${String(pattern.width)}x${String(pattern.height)} ` +
        `topBuckets=${JSON.stringify(pattern.topBuckets)}`,
    );
  }
  return pattern;
}

async function analyzeScreenshot(
  page: Page,
  screenshot: Buffer,
): Promise<ScreenshotPattern> {
  return page.evaluate(async (pngBase64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${pngBase64}`;
    await image.decode();
    const raster = document.createElement("canvas");
    raster.width = image.naturalWidth;
    raster.height = image.naturalHeight;
    const context = raster.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return {
        distinct: 0,
        varyingRows: 0,
        width: raster.width,
        height: raster.height,
        topBuckets: [],
      };
    }
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
    const bucketAt = (x: number, y: number): string => {
      const offset = (y * raster.width + x) * 4;
      return [0, 1, 2]
        .map((channel) =>
          String(Math.floor((pixels[offset + channel] ?? 0) / 16)),
        )
        .join(":");
    };
    const backgroundBuckets = new Set(["0:1:1", "1:1:1", "1:2:3"]);
    const buckets = new Map<string, number>();
    for (let index = 0; index < pixels.length; index += 4) {
      const bucket = [0, 1, 2]
        .map((channel) =>
          String(Math.floor((pixels[index + channel] ?? 0) / 16)),
        )
        .join(":");
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const distinct = new Set<string>();
    buckets.forEach((count, bucket) => {
      if (count >= 20 && !backgroundBuckets.has(bucket)) distinct.add(bucket);
    });
    let varyingRows = 0;
    [0.3, 0.5, 0.7].forEach((rowFraction) => {
      const rowColors = new Set<string>();
      [0.2, 0.5, 0.8].forEach((columnFraction) => {
        rowColors.add(
          bucketAt(
            Math.floor(raster.width * columnFraction),
            Math.floor(raster.height * rowFraction),
          ),
        );
      });
      if (rowColors.size > 1) varyingRows += 1;
    });
    const topBuckets = [...buckets.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([bucket, count]) => ({ bucket, count }));
    return {
      distinct: distinct.size,
      varyingRows,
      width: raster.width,
      height: raster.height,
      topBuckets,
    };
  }, screenshot.toString("base64"));
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

async function expectZoomPointVisible(
  page: Page,
  point: { x: number; y: number },
): Promise<void> {
  await waitForTwoAnimationFrames(page);
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  const rectValue = await canvas.getAttribute("data-widget-body-rect");
  if (!box || !rectValue) {
    throw new Error(
      `Zoom point check unavailable: rect=${rectValue ?? "<missing>"} ` +
        `point=${JSON.stringify(point)}`,
    );
  }
  const rect = JSON.parse(rectValue) as WidgetBodyRect;
  expect(point.x).toBeGreaterThanOrEqual(rect.x);
  expect(point.y).toBeGreaterThanOrEqual(rect.y);
  expect(point.x).toBeLessThanOrEqual(rect.x + rect.width);
  expect(point.y).toBeLessThanOrEqual(rect.y + rect.height);
  const screenshot = await page.screenshot({
    clip: { x: box.x + point.x, y: box.y + point.y, width: 1, height: 1 },
  });
  const pixel = await page.evaluate(async (pngBase64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${pngBase64}`;
    await image.decode();
    const raster = document.createElement("canvas");
    raster.width = image.naturalWidth;
    raster.height = image.naturalHeight;
    const context = raster.getContext("2d", { willReadFrequently: true });
    if (!context) return [0, 0, 0];
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  }, screenshot.toString("base64"));
  expect(pixel).not.toEqual([14, 18, 28]);
}

async function zoomUntilDetail(
  page: Page,
  deltaY: number,
  target: "minimap" | "text",
  point: { x: number; y: number },
): Promise<void> {
  const canvas = page.getByTestId("canvas");
  const session = await page.context().newCDPSession(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Cannot zoom: canvas bounding box is unavailable");
  const x = box.x + point.x;
  const y = box.y + point.y;
  let lastRect = await canvas.getAttribute("data-widget-body-rect");
  const MAX_ZOOM_STEPS = 40;
  for (let index = 0; index < MAX_ZOOM_STEPS; index += 1) {
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      modifiers: 2,
    });
    await waitForTwoAnimationFrames(page);
    const nextRect = await canvas.getAttribute("data-widget-body-rect");
    const step = index + 1;
    if (!nextRect || nextRect === lastRect) {
      throw new Error(
        `Zoom step ${String(step)} did not change widget body rect; ` +
          `steps=${String(step)} lastRect=${lastRect ?? "<missing>"} ` +
          `currentRect=${nextRect ?? "<missing>"}`,
      );
    }
    lastRect = nextRect;
    if ((await canvas.getAttribute("data-detail-level")) === target) {
      await expect(canvas).toHaveAttribute("data-detail-level", target);
      return;
    }
  }
  throw new Error(
    `Zoom did not reach ${target}; steps=${String(MAX_ZOOM_STEPS)} lastRect=${lastRect ?? "<missing>"}`,
  );
}

test("Displaying a file", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  test.skip(
    !existsSync(referenceFile),
    "Reference Dataset file is missing; run pnpm fixtures.",
  );
  if (!existsSync(referenceFile)) return;
  await installDirectoryMock(page, readFileSync(referenceFile, "utf8"));
  await page.goto("/");
  await page.getByTestId("open-folder").click();
  await expectHighlighted(page, browserErrors);
  const zoomPoint = { x: 400, y: 300 };
  await readScreenshotPattern(page, {
    requiredDistinct: 4,
    artifactPath: "test-results/slice/displaying-a-file-text-clip.png",
  });
  await page.screenshot({
    path: "test-results/slice/displaying-a-file-text.png",
  });
  await page.getByTestId("canvas").hover({ position: zoomPoint });
  await page.mouse.wheel(80, 40);
  await page.screenshot({
    path: "test-results/slice/displaying-a-file-pan.png",
  });
  await zoomUntilDetail(page, 120, "minimap", zoomPoint);
  await expectZoomPointVisible(page, zoomPoint);
  const minimapPattern = await readScreenshotPattern(page, {
    requiredDistinct: 3,
    artifactPath: "test-results/slice/displaying-a-file-minimap-clip.png",
  });
  expect(minimapPattern.varyingRows).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/slice/displaying-a-file-minimap.png",
  });
  await zoomUntilDetail(page, -120, "text", zoomPoint);
  await readScreenshotPattern(page, {
    requiredDistinct: 4,
    artifactPath:
      "test-results/slice/displaying-a-file-roundtrip-text-clip.png",
  });
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});

test("Zooming out to the minimap", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(
    page,
    "const answer: number = 42;\nexport function read() { return answer; }\n",
  );
  await page.goto("/");
  await page.getByTestId("open-folder").click();
  await expectHighlighted(page, browserErrors);
  const zoomPoint = { x: 400, y: 130 };
  await page.getByTestId("canvas").hover({ position: zoomPoint });
  await zoomUntilDetail(page, 120, "minimap", zoomPoint);
  await expectZoomPointVisible(page, zoomPoint);
  await readScreenshotPattern(page, {
    requiredDistinct: 3,
    artifactPath:
      "test-results/slice/zooming-out-to-the-minimap-minimap-clip.png",
  });
  await page.screenshot({
    path: "test-results/slice/zooming-out-to-the-minimap-minimap.png",
  });
  await zoomUntilDetail(page, -120, "text", zoomPoint);
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
