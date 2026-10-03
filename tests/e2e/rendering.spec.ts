import { expect, test, type Page } from "@playwright/test";

import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../../src/shared/pinch";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  installDirectoryMock,
  openFolder,
  readCanvasRegion,
  readWidgetRects,
  type Pixel,
  type WidgetRect,
} from "./support";

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface FrameLogEntry {
  readonly tick: number;
  readonly drawnTileCount: number;
  readonly drawnLabelTileCount: number;
  readonly drawnMinimapCount: number;
  readonly detailLevel: 0 | 1;
}

interface TileDebugSnapshot {
  readonly rasterScales: readonly number[];
}

interface ColorCounts {
  readonly orange: number;
  readonly green: number;
  readonly region: Region;
}

const CRISP_LINES = [
  "const answer = 42;",
  'const greeting = "hello";',
  "function add(left: number, right: number): number {",
  "return left + right;",
  "}",
  "const values = [1, 2, 3];",
  "export const result = add(answer, values[0]);",
  "if (result > 0) {",
  "console.log(greeting, result);",
  "}",
  "const enabled = true;",
  "const label = `${greeting}!`;",
  "export { label };",
].join("\n");

function longStringFile(): string {
  return Array.from(
    { length: 30 },
    (_, index) => `const a${String(index)} = "${"a".repeat(215)}";`,
  ).join("\n");
}

function longCommentFile(): string {
  return Array.from({ length: 30 }, () => `// ${"b".repeat(225)}`).join("\n");
}

function fortyLines(): string {
  return Array.from(
    { length: 40 },
    (_, index) => `const value${String(index)} = ${String(index)};`,
  ).join("\n");
}

async function readFrameLog(page: Page): Promise<readonly FrameLogEntry[]> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.frameLog();
  });
}

async function readTileDebug(page: Page): Promise<TileDebugSnapshot> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.tileDebug();
  });
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

async function pinchZoomTo(
  page: Page,
  target: number,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounds unavailable: width=0 height=0");
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
  const actual = Number(await canvas.getAttribute("data-text-metrics-scale"));
  try {
    await expect
      .poll(async () =>
        Number(await canvas.getAttribute("data-text-metrics-scale")),
      )
      .toBeCloseTo(target, 2);
  } catch (error) {
    throw new Error(
      `Pinch scale mismatch: target=${String(target)} actual=${String(actual)} ` +
        `point=${JSON.stringify(point)}\n${String(error)}`,
    );
  }
  await page.waitForTimeout(600);
}

async function expectCanvasAttribute(
  page: Page,
  name: string,
  expected: string,
): Promise<void> {
  const canvas = page.getByTestId("canvas");
  let actual: string | null = null;
  try {
    await expect
      .poll(async () => {
        actual = await canvas.getAttribute(name);
        return actual;
      })
      .toBe(expected);
  } catch (error) {
    throw new Error(
      `Canvas attribute mismatch: name=${name} expected=${expected} ` +
        `actual=${String(actual)}\n${String(error)}`,
    );
  }
}

async function waitForSettledTiles(page: Page): Promise<void> {
  let snapshot: TileDebugSnapshot = { rasterScales: [] };
  let cameraScale = Number(
    await page.getByTestId("canvas").getAttribute("data-text-metrics-scale"),
  );
  let expectedRasterScale = 2 * cameraScale;
  try {
    await expect
      .poll(
        async () => {
          cameraScale = Number(
            await page
              .getByTestId("canvas")
              .getAttribute("data-text-metrics-scale"),
          );
          expectedRasterScale = 2 * cameraScale;
          snapshot = await readTileDebug(page);
          return (
            snapshot.rasterScales.length > 0 &&
            snapshot.rasterScales.every(
              (scale) => Math.abs(scale - expectedRasterScale) <= 0.01,
            )
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `Tiles did not settle at DPR 2: rasterScales=${JSON.stringify(snapshot.rasterScales)} ` +
        `count=${String(snapshot.rasterScales.length)} ` +
        `cameraScale=${String(cameraScale)} expectedRasterScale=${String(expectedRasterScale)}\n${String(error)}`,
    );
  }
}

function bodyRect(widget: WidgetRect, scale: number): Region {
  return {
    x: widget.rect.x,
    y: widget.rect.y + DEFAULT_CODE_FONT.bodyTop * scale,
    width: widget.rect.width,
    height: widget.rect.height - DEFAULT_CODE_FONT.bodyTop * scale,
  };
}

async function readBodyRect(page: Page): Promise<Region> {
  const value = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  if (!value) throw new Error("Body rect unavailable: value=<missing>");
  return JSON.parse(value) as Region;
}

async function horizontalGradientEnergy(
  page: Page,
  region: Region,
): Promise<number> {
  const step = 0.5;
  const pixels = await readCanvasRegion(page, region, step);
  const rows = Math.ceil(region.height);
  const columns = rows === 0 ? 0 : Math.floor(pixels.length / rows);
  let energy = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const left = pixels[(column - 1) * rows + row];
      const right = pixels[column * rows + row];
      if (left && right) energy += Math.abs(luma(right) - luma(left));
    }
  }
  return energy;
}

function luma(pixel: Pixel): number {
  return 0.299 * pixel.red + 0.587 * pixel.green + 0.114 * pixel.blue;
}

function widgetFor(rects: readonly WidgetRect[], filePath: string): WidgetRect {
  const widget = rects.find((candidate) => candidate.filePath === filePath);
  if (widget) return widget;
  throw new Error(
    `Widget rect missing: filePath=${filePath} rects=${JSON.stringify(rects)}`,
  );
}

async function overlapRegion(page: Page): Promise<Region> {
  const rects = await readWidgetRects(page);
  const scale = Number(
    await page.getByTestId("canvas").getAttribute("data-text-metrics-scale"),
  );
  const first = bodyRect(widgetFor(rects, "a.ts"), scale);
  const second = bodyRect(widgetFor(rects, "b.ts"), scale);
  const canvas = await page.getByTestId("canvas").boundingBox();
  if (!canvas) throw new Error("Canvas bounds unavailable: width=0 height=0");
  const left = Math.max(0, first.x, second.x) + 6;
  const top = Math.max(0, first.y, second.y) + 6;
  const right =
    Math.min(canvas.width, first.x + first.width, second.x + second.width) - 6;
  const bottom =
    Math.min(canvas.height, first.y + first.height, second.y + second.height) -
    6;
  const region = { x: left, y: top, width: right - left, height: bottom - top };
  if (region.width <= 0 || region.height <= 0) {
    throw new Error(
      `Overlap region is empty: scale=${String(scale)} region=${JSON.stringify(region)} ` +
        `rects=${JSON.stringify(rects)}`,
    );
  }
  return region;
}

function classify(pixel: Pixel): "orange" | "green" | undefined {
  if (
    pixel.red >= pixel.green &&
    pixel.red >= pixel.blue &&
    pixel.red - pixel.blue >= 60
  )
    return "orange";
  if (
    pixel.green >= pixel.red &&
    pixel.green >= pixel.blue &&
    pixel.green - pixel.blue >= 40 &&
    pixel.green - pixel.red >= 30
  )
    return "green";
  return undefined;
}

async function readColorCounts(page: Page): Promise<ColorCounts> {
  const region = await overlapRegion(page);
  const pixels = await readCanvasRegion(page, region, 1);
  let orange = 0;
  let green = 0;
  for (const pixel of pixels) {
    const kind = classify(pixel);
    if (kind === "orange") orange += 1;
    if (kind === "green") green += 1;
  }
  return { orange, green, region };
}

async function expectTopColor(
  page: Page,
  color: "orange" | "green",
  minimum: number,
  label: string,
): Promise<void> {
  let counts: ColorCounts = {
    orange: 0,
    green: 0,
    region: { x: 0, y: 0, width: 0, height: 0 },
  };
  let lastReadError: unknown;
  const forbidden = color === "orange" ? "green" : "orange";
  try {
    await expect
      .poll(
        async () => {
          try {
            counts = await readColorCounts(page);
            lastReadError = undefined;
            return counts[color] >= minimum && counts[forbidden] === 0;
          } catch (error) {
            lastReadError = error;
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${label} stack colour mismatch: expected=${color} minimum=${String(minimum)} ` +
        `orange=${String(counts.orange)} green=${String(counts.green)} ` +
        `region=${JSON.stringify(counts.region)} ` +
        `lastReadError=${String(lastReadError)}\n${String(error)}`,
    );
  }
}

async function dragWidgetLeft(
  page: Page,
  widget: WidgetRect,
): Promise<{
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}> {
  const start = { x: widget.rect.x + 100, y: widget.rect.y + 16 };
  const end = { x: start.x - 4 * 100, y: start.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 4; step += 1)
    await page.mouse.move(start.x - step * 100, start.y);
  await page.mouse.up();
  await waitForTwoAnimationFrames(page);
  return { start, end };
}

function pointOutsideOverlap(
  widget: WidgetRect,
  scale: number,
  side: "left" | "right",
): { x: number; y: number } {
  const body = bodyRect(widget, scale);
  return {
    x: side === "left" ? body.x + 20 : body.x + body.width - 20,
    y: body.y + Math.min(30, body.height / 2),
  };
}

async function assertTransitionFrames(
  page: Page,
  firstTick: number,
): Promise<void> {
  const entries = (await readFrameLog(page)).filter(
    (entry) => entry.tick >= firstTick,
  );
  const violations = entries.filter((entry) => {
    const content = entry.drawnTileCount - entry.drawnLabelTileCount;
    return (
      (content > 0 && entry.drawnMinimapCount > 0) ||
      (content <= 0 && entry.drawnMinimapCount <= 0)
    );
  });
  const details = [
    ...new Set(entries.map((entry) => entry.detailLevel)),
  ].sort();
  expect(
    violations,
    `Transition representation violations=${JSON.stringify(violations)} entries=${String(entries.length)} ` +
      `firstTick=${String(firstTick)}`,
  ).toHaveLength(0);
  expect(
    details,
    `Transition detail levels=${JSON.stringify(details)} entries=${String(entries.length)} ` +
      `firstTick=${String(firstTick)}`,
  ).toEqual([0, 1]);
}

test("Displaying a file", async ({ page }) => {
  await installDirectoryMock(page, CRISP_LINES, "crisp.ts");
  await page.goto("/");
  await openFolder(page);
  await expectCanvasAttribute(page, "data-highlighted", "true");
  await waitForSettledTiles(page);
  const body = await readBodyRect(page);
  const region = {
    x: body.x + 48,
    y: body.y,
    width: 240,
    height: DEFAULT_CODE_FONT.lineHeight * 6,
  };
  const gpuEnergy = await horizontalGradientEnergy(page, region);
  const lineY =
    body.y +
    DEFAULT_CODE_FONT.lineHeight * (CRISP_LINES.split("\n").length - 0.5);
  await page.mouse.dblclick(body.x + 120, lineY);
  await expectCanvasAttribute(page, "data-editing", "true");
  let editorLines = 0;
  try {
    await expect
      .poll(async () => {
        editorLines = await page.locator(".monaco-editor .view-line").count();
        return editorLines;
      })
      .toBeGreaterThan(0);
  } catch (error) {
    throw new Error(
      `Monaco view-line count mismatch: expected>0 actual=${String(editorLines)} ` +
        `region=${JSON.stringify(region)}\n${String(error)}`,
    );
  }
  const monacoEnergy = await horizontalGradientEnergy(page, region);
  const ratio = monacoEnergy === 0 ? 0 : gpuEnergy / monacoEnergy;
  expect(
    gpuEnergy,
    `GPU gradient energy must be positive: gpu=${String(gpuEnergy)} ` +
      `monaco=${String(monacoEnergy)} region=${JSON.stringify(region)}`,
  ).toBeGreaterThan(0);
  expect(
    monacoEnergy,
    `Monaco gradient energy must be positive: gpu=${String(gpuEnergy)} ` +
      `monaco=${String(monacoEnergy)} region=${JSON.stringify(region)}`,
  ).toBeGreaterThan(0);
  expect(
    ratio,
    `GPU/Monaco gradient ratio must be at least 0.85: ratio=${String(ratio)} ` +
      `gpu=${String(gpuEnergy)} monaco=${String(monacoEnergy)} region=${JSON.stringify(region)}`,
  ).toBeGreaterThanOrEqual(0.85);
});

test("Releasing over another widget", async ({ page }) => {
  await installDirectoryMock(page, [
    { path: "a.ts", text: longStringFile() },
    { path: "b.ts", text: longCommentFile() },
  ]);
  await page.goto("/");
  await openFolder(page);
  await expectCanvasAttribute(page, "data-highlighted", "true");
  await waitForSettledTiles(page);
  const before = await readWidgetRects(page);
  const drag = await dragWidgetLeft(page, widgetFor(before, "b.ts"));
  await expectTopColor(
    page,
    "green",
    40,
    `Text after drag dragStart=${JSON.stringify(drag.start)} ` +
      `dragEnd=${JSON.stringify(drag.end)} rectsBefore=${JSON.stringify(before)}`,
  );
  const afterDrag = await readWidgetRects(page);
  const aAtText = widgetFor(afterDrag, "a.ts");
  const aPoint = pointOutsideOverlap(aAtText, 1, "left");
  await page.mouse.click(aPoint.x, aPoint.y);
  await expectTopColor(page, "orange", 40, "Text after a.ts click");
  await page.evaluate(() => window.__codeCanvasTest?.setCamera(60, 76, 0.2));
  await expectCanvasAttribute(page, "data-detail-level", "minimap");
  await expectTopColor(page, "orange", 8, "Minimap after a.ts click");
  const afterScale = await readWidgetRects(page);
  const bAtMinimap = widgetFor(afterScale, "b.ts");
  const bPoint = pointOutsideOverlap(bAtMinimap, 0.2, "right");
  await page.mouse.click(bPoint.x, bPoint.y);
  await expectTopColor(page, "green", 8, "Minimap after b.ts click");
});

test("Transition without flicker", async ({ page }) => {
  await installDirectoryMock(page, fortyLines(), "transition.ts");
  await page.goto("/");
  await openFolder(page);
  await expectCanvasAttribute(page, "data-highlighted", "true");
  await waitForSettledTiles(page);
  const body = await readBodyRect(page);
  const entries = await readFrameLog(page);
  const firstTick = entries[entries.length - 1]?.tick ?? -1;
  const point = { x: body.x + 120, y: body.y + 40 };
  await pinchZoomTo(page, 0.2, point);
  await expectCanvasAttribute(page, "data-detail-level", "minimap");
  await pinchZoomTo(page, 1, point);
  await expectCanvasAttribute(page, "data-detail-level", "text");
  await waitForSettledTiles(page);
  await assertTransitionFrames(page, firstTick);
});
