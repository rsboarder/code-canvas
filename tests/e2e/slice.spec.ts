import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../../src/shared/pinch";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
} from "./support";

const referenceFile = resolve(
  "fixtures/reference-dataset/group-00/widget-000.tsx",
);

test.use({ deviceScaleFactor: 2 });

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

interface FrameLogEntry {
  readonly tick: number;
  readonly timeMs: number;
  readonly missingTile: boolean;
  readonly cameraScale: number;
  readonly detailLevel: 0 | 1;
  readonly drawnLabelTileCount: number;
  readonly onScreenLineHeight: number;
  readonly textReady: boolean;
}

async function readFrameLog(page: Page): Promise<readonly FrameLogEntry[]> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.frameLog();
  });
}

async function pinchZoomTo(
  page: Page,
  target: number,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const session = await page.context().newCDPSession(page);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const scale = Number(await canvas.getAttribute("data-text-metrics-scale"));
    const remaining = Math.log(target / scale);
    if (Math.abs(remaining) < 1e-3) break;
    const step =
      Math.sign(remaining) * Math.min(Math.abs(remaining), MAX_ZOOM_STEP_LN);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: box.x + point.x,
      y: box.y + point.y,
      deltaX: 0,
      deltaY: -step * PINCH_WHEEL_DELTA_PER_LN_SCALE,
      modifiers: 2,
    });
    await waitForTwoAnimationFrames(page);
  }
  await expect
    .poll(async () =>
      Number(await canvas.getAttribute("data-text-metrics-scale")),
    )
    .toBeCloseTo(target, 2);
  await page.waitForTimeout(600);
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

async function assertHeaderLabel(page: Page): Promise<void> {
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  const rectValue = await canvas.getAttribute("data-widget-body-rect");
  const scale = Number(await canvas.getAttribute("data-text-metrics-scale"));
  if (!box || !rectValue || !Number.isFinite(scale))
    throw new Error("Widget header clip is unavailable");
  const rect = JSON.parse(rectValue) as WidgetBodyRect;
  const height = Math.min(DEFAULT_CODE_FONT.bodyTop * scale, rect.y);
  const clip = {
    x: box.x + rect.x,
    y: box.y + rect.y - height,
    width: rect.width / 2,
    height,
  };
  const screenshot = await page.screenshot({
    path: "test-results/slice/header-text.png",
    clip,
  });
  const brighterPixels = await page.evaluate(async (pngBase64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${pngBase64}`;
    await image.decode();
    const raster = document.createElement("canvas");
    raster.width = image.naturalWidth;
    raster.height = image.naturalHeight;
    const context = raster.getContext("2d", { willReadFrequently: true });
    if (!context) return 0;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      if (red > 48 || green > 48 || blue > 48) count += 1;
    }
    return count;
  }, screenshot.toString("base64"));
  expect(brighterPixels).toBeGreaterThan(0);
}

interface MinimapLabelPixels {
  readonly bright: number;
  readonly coloured: number;
  readonly brightTop: number;
  readonly brightBottom: number;
  readonly height: number;
}

async function readMinimapLabel(
  page: Page,
  artifactPath: string,
): Promise<MinimapLabelPixels> {
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  const rectValue = await canvas.getAttribute("data-widget-body-rect");
  if (!box || !rectValue) throw new Error("Widget body clip is unavailable");
  const rect = JSON.parse(rectValue) as WidgetBodyRect;
  const clip = widgetBodyClip(box, rect);
  if (!clip) throw new Error("Widget body clip is empty");
  const screenshot = await page.screenshot({
    path: artifactPath,
    clip,
  });
  const result = await page.evaluate(async (pngBase64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${pngBase64}`;
    await image.decode();
    const raster = document.createElement("canvas");
    raster.width = image.naturalWidth;
    raster.height = image.naturalHeight;
    const context = raster.getContext("2d", { willReadFrequently: true });
    if (!context)
      return {
        bright: 0,
        coloured: 0,
        brightTop: -1,
        brightBottom: -1,
        height: 0,
      };
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, raster.width, raster.height).data;
    let bright = 0;
    let coloured = 0;
    let brightTop = raster.height;
    let brightBottom = -1;
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        const offset = (y * raster.width + x) * 4;
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const central =
          Math.hypot(x / raster.width - 0.5, y / raster.height - 0.5) < 0.35;
        if (red >= 240 && green >= 240 && blue >= 240) {
          if (central) {
            bright += 1;
            brightTop = Math.min(brightTop, y);
            brightBottom = Math.max(brightBottom, y);
          }
        }
        if (
          red + green + blue > 120 &&
          Math.max(red, green, blue) - Math.min(red, green, blue) > 28
        )
          coloured += 1;
      }
    }
    return { bright, coloured, brightTop, brightBottom, height: raster.height };
  }, screenshot.toString("base64"));
  return result;
}

async function assertMinimapLabel(
  page: Page,
  artifactPath: string,
  assertVerticalExtent: boolean,
): Promise<void> {
  let pixels: MinimapLabelPixels = {
    bright: 0,
    coloured: 0,
    brightTop: -1,
    brightBottom: -1,
    height: 0,
  };
  await expect
    .poll(
      async () => {
        pixels = await readMinimapLabel(page, artifactPath);
        return pixels.bright > 0 && pixels.coloured > 0;
      },
      { timeout: 15000, intervals: [100, 250, 500, 1000] },
    )
    .toBe(true);
  expect(pixels.bright).toBeGreaterThan(0);
  expect(pixels.coloured).toBeGreaterThan(0);
  if (assertVerticalExtent) {
    expect(pixels.brightTop).toBeGreaterThan(0);
    expect(pixels.brightBottom).toBeLessThan(pixels.height - 1);
  }
  await expect
    .poll(async () => {
      const entries = await readFrameLog(page);
      const latest = entries[entries.length - 1];
      return latest?.detailLevel === 1 && latest.drawnLabelTileCount > 0;
    })
    .toBe(true);
}

function logMinimapLabelDelay(
  label: string,
  entries: readonly FrameLogEntry[],
): void {
  const firstMinimap = entries.find((entry) => entry.detailLevel === 1);
  const firstDrawnLabel = entries.find(
    (entry) => entry.detailLevel === 1 && entry.drawnLabelTileCount > 0,
  );
  if (!firstMinimap || !firstDrawnLabel) {
    console.info(`${label} minimap label delay: unavailable`);
    return;
  }
  console.info(
    `${label} minimap label delay: ` +
      `ticks ${String(firstDrawnLabel.tick - firstMinimap.tick)}, ` +
      `milliseconds ${String(firstDrawnLabel.timeMs - firstMinimap.timeMs)}`,
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
  await installDirectoryMock(
    page,
    readFileSync(referenceFile, "utf8"),
    "group-00/widget-000.tsx",
  );
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);
  const zoomPoint = { x: 400, y: 300 };
  const panPoint = { x: 400, y: 90 };
  await assertHeaderLabel(page);
  await readScreenshotPattern(page, {
    requiredDistinct: 4,
    artifactPath: "test-results/slice/displaying-a-file-text-clip.png",
  });
  await page.screenshot({
    path: "test-results/slice/displaying-a-file-text.png",
  });
  await page.getByTestId("canvas").hover({ position: panPoint });
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
  const zoomPoint = { x: 400, y: 130 };
  await test.step("two-line file", async () => {
    await installDirectoryMock(
      page,
      "const answer: number = 42;\nexport function read() { return answer; }\n",
    );
    await page.goto("/");
    await openFolder(page);
    await expectHighlighted(page, browserErrors);
    await page.getByTestId("canvas").hover({ position: zoomPoint });
    await zoomUntilDetail(page, 120, "minimap", zoomPoint);
    await expectZoomPointVisible(page, zoomPoint);
    await assertMinimapLabel(
      page,
      "test-results/slice/minimap-label.png",
      true,
    );
    logMinimapLabelDelay("two-line file", await readFrameLog(page));
    await readScreenshotPattern(page, {
      requiredDistinct: 3,
      artifactPath:
        "test-results/slice/zooming-out-to-the-minimap-minimap-clip.png",
    });
    await page.screenshot({
      path: "test-results/slice/zooming-out-to-the-minimap-minimap.png",
    });
    await zoomUntilDetail(page, -120, "text", zoomPoint);
  });
  test.skip(
    !existsSync(referenceFile),
    "Reference Dataset file is missing; run pnpm fixtures.",
  );
  await test.step("2000-line reference file", async () => {
    await installDirectoryMock(
      page,
      readFileSync(referenceFile, "utf8"),
      "group-00/widget-000.tsx",
    );
    await page.goto("/");
    await openFolder(page);
    await expectHighlighted(page, browserErrors);
    await page.getByTestId("canvas").hover({ position: zoomPoint });
    await zoomUntilDetail(page, 120, "minimap", zoomPoint);
    await expectZoomPointVisible(page, zoomPoint);
    await assertMinimapLabel(
      page,
      "test-results/slice/minimap-label-2000.png",
      false,
    );
    logMinimapLabelDelay("2000-line reference file", await readFrameLog(page));
    await zoomUntilDetail(page, -120, "text", zoomPoint);
  });
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});

test("Transition without flicker", async ({ page }) => {
  await installDirectoryMock(
    page,
    "export function widget(value: number): number {\n  return value * 2;\n}\n",
  );
  await page.goto("/");
  await openFolder(page);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  const point = { x: 400, y: 130 };
  await pinchZoomTo(page, 0.2, point);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-detail-level",
    "minimap",
  );

  const beforeTransition = await readFrameLog(page);
  const transitionStart =
    beforeTransition[beforeTransition.length - 1]?.tick ?? -1;
  await pinchZoomTo(page, 0.4, point);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-detail-level",
    "text",
  );
  const entries = (await readFrameLog(page)).filter(
    (entry) => entry.tick > transitionStart,
  );
  const firstAboveThreshold = entries.find(
    (entry) => entry.onScreenLineHeight > 11,
  );
  const switchedToText = entries.find((entry) => entry.detailLevel === 0);
  if (!firstAboveThreshold || !switchedToText) {
    throw new Error("Detail Level transition was not logged");
  }
  expect(
    entries.some((entry) => entry.detailLevel === 0 && entry.missingTile),
  ).toBe(false);
  console.info(
    `Transition without flicker switch lag: ${String(
      switchedToText.tick - firstAboveThreshold.tick,
    )} ticks, ${String(
      (switchedToText.tick - firstAboveThreshold.tick) * (1000 / 120),
    )} ms`,
  );
});

test("Jumps from Minimap to Text without a gesture", async ({ page }) => {
  await installDirectoryMock(
    page,
    "export function widget(value: number): number {\n  return value * 2;\n}\n",
  );
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-highlighted", "true");
  await pinchZoomTo(page, 0.2, { x: 400, y: 130 });
  await expect(canvas).toHaveAttribute("data-detail-level", "minimap");

  const beforeJump = await readFrameLog(page);
  const jumpStart = beforeJump[beforeJump.length - 1]?.tick ?? -1;
  await page.evaluate(() => {
    window.__codeCanvasTest?.setCamera(60, 76, 1);
  });
  await expect(canvas).toHaveAttribute("data-detail-level", "text", {
    timeout: 2000,
  });
  const entries = (await readFrameLog(page)).filter(
    (entry) => entry.tick > jumpStart,
  );
  expect(
    entries.some((entry) => entry.detailLevel === 0 && entry.missingTile),
  ).toBe(false);
});
