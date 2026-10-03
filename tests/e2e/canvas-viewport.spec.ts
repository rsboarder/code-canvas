import { expect, test, type Page } from "@playwright/test";

import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../../src/shared/pinch";
import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  bodyPoint,
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
  readCanvasRegion,
  readWidgetRects,
  type Pixel,
  type WidgetRect,
} from "./support";

interface Camera {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
}

interface FrameLogEntry extends Camera {
  readonly tick: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface WheelEventInput {
  readonly point: Point;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly modifiers?: number;
}

interface CloseExpectation {
  readonly label: string;
  readonly actual: number;
  readonly expected: number;
  readonly tolerance: number;
  readonly before: Camera;
  readonly after: Camera;
}

const twoHundredLines = Array.from(
  { length: 200 },
  (_, index) => `const line${String(index)} = ${String(index)};`,
).join("\n");

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

async function readLastFrame(page: Page): Promise<FrameLogEntry> {
  const frame = await page.evaluate(() => {
    const entries = window.__codeCanvasTest?.frameLog();
    return entries?.[entries.length - 1];
  });
  if (!frame) throw new Error("Code Canvas frame log is missing");
  return frame;
}

async function readFrames(page: Page): Promise<readonly FrameLogEntry[]> {
  return page.evaluate(() => window.__codeCanvasTest?.frameLog() ?? []);
}

async function openHighlightedFolder(page: Page): Promise<void> {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, twoHundredLines);
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);
  await waitForTwoAnimationFrames(page);
}

async function waitForSettledTiles(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const entries = window.__codeCanvasTest?.frameLog();
          const entry = entries?.[entries.length - 1];
          return (
            (entry?.drawnTileCount ?? 0) > 0 &&
            entry?.drawnUnhighlightedTileCount === 0
          );
        }),
      { timeout: 5000 },
    )
    .toBe(true);
  await waitForTwoAnimationFrames(page);
}

async function canvasScreenPoint(page: Page, point: Point): Promise<Point> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  return { x: box.x + point.x, y: box.y + point.y };
}

async function dispatchWheel(
  page: Page,
  input: WheelEventInput,
): Promise<void> {
  const screenPoint = await canvasScreenPoint(page, input.point);
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: screenPoint.x,
    y: screenPoint.y,
    deltaX: input.deltaX,
    deltaY: input.deltaY,
    modifiers: input.modifiers ?? 0,
  });
}

async function widgetBodyPoint(page: Page): Promise<Point> {
  const point = await bodyPoint(page);
  const rects = await readWidgetRects(page);
  const widget = rects[0];
  if (!widget) throw new Error("Widget rect is missing");
  const minimumBodyY = widget.rect.y + DEFAULT_CODE_FONT.bodyTop + 4;
  return { x: point.x, y: Math.max(point.y, minimumBodyY) };
}

async function emptyCanvasPoint(page: Page): Promise<Point> {
  const rects = await readWidgetRects(page);
  const canvas = await page.getByTestId("canvas").boundingBox();
  const button = await page.getByTestId("open-folder").boundingBox();
  if (!canvas || !button)
    throw new Error("Canvas or toolbar bounds are missing");
  const right = rects.reduce(
    (maximum, widget) => Math.max(maximum, widget.rect.x + widget.rect.width),
    0,
  );
  const x = right + 25;
  const y = Math.max(
    button.y + button.height + 20,
    DEFAULT_CODE_FONT.bodyTop + 20,
  );
  if (x > canvas.width - 20) {
    throw new Error(
      `Empty canvas point unavailable: x=${String(x)} canvasWidth=${String(canvas.width)} rects=${JSON.stringify(rects)}`,
    );
  }
  return { x, y };
}

async function installCtrlWheelCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const values: boolean[] = [];
    window.addEventListener("wheel", (event) => {
      if (event.ctrlKey || event.metaKey) values.push(event.defaultPrevented);
    });
    Object.defineProperty(window, "__canvasViewportCtrlWheel", {
      configurable: true,
      value: values,
    });
  });
}

async function readCtrlWheelCapture(page: Page): Promise<readonly boolean[]> {
  return page.evaluate(() => {
    const values = (
      window as Window & { __canvasViewportCtrlWheel?: boolean[] }
    ).__canvasViewportCtrlWheel;
    return values ? [...values] : [];
  });
}

async function readVisualViewportScale(page: Page): Promise<number> {
  return page.evaluate(() => window.visualViewport?.scale ?? 0);
}

function cameraText(before: Camera, after: Camera): string {
  return `cameraBefore=${JSON.stringify(before)} cameraAfter=${JSON.stringify(after)}`;
}

function expectClose(input: CloseExpectation): void {
  expect(
    Math.abs(input.actual - input.expected),
    `${input.label}: measured=${String(input.actual)} expected=${String(input.expected)} tolerance=${String(input.tolerance)} ${cameraText(input.before, input.after)}`,
  ).toBeLessThanOrEqual(input.tolerance);
}

function expectRectSetsEqual(
  actual: readonly WidgetRect[],
  expected: readonly WidgetRect[],
  before: Camera,
  after: Camera,
): void {
  expect(
    actual.length,
    `widget count: measured=${String(actual.length)} expected=${String(expected.length)} ${cameraText(before, after)}`,
  ).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const measured = actual[index];
    const wanted = expected[index];
    if (!measured || !wanted) continue;
    for (const key of ["x", "y", "width", "height"] as const) {
      expectClose({
        label: `widget ${String(index)} ${key}`,
        actual: measured.rect[key],
        expected: wanted.rect[key],
        tolerance: 0.01,
        before,
        after,
      });
    }
  }
}

function pixelDifferenceCount(
  before: readonly Pixel[],
  after: readonly Pixel[],
): number {
  let differences = 0;
  for (
    let index = 0;
    index < Math.min(before.length, after.length);
    index += 1
  ) {
    const left = before[index];
    const right = after[index];
    if (
      left?.red !== right?.red ||
      left?.green !== right?.green ||
      left?.blue !== right?.blue
    ) {
      differences += 1;
    }
  }
  return differences;
}

function zoomFactor(deltaY: number): number {
  const ln = Math.max(
    -MAX_ZOOM_STEP_LN,
    Math.min(MAX_ZOOM_STEP_LN, -deltaY / PINCH_WHEEL_DELTA_PER_LN_SCALE),
  );
  return Math.exp(ln);
}

function boardPointAt(point: Point, camera: Camera): Point {
  return {
    x: (point.x - camera.cameraOffsetX) / camera.cameraScale,
    y: (point.y - camera.cameraOffsetY) / camera.cameraScale,
  };
}

function screenPointForBoardPoint(point: Point, camera: Camera): Point {
  return {
    x: camera.cameraOffsetX + point.x * camera.cameraScale,
    y: camera.cameraOffsetY + point.y * camera.cameraScale,
  };
}

test("Trackpad pan", async ({ page }) => {
  await openHighlightedFolder(page);
  const before = await readLastFrame(page);
  const point = await emptyCanvasPoint(page);
  for (let index = 0; index < 5; index += 1) {
    await dispatchWheel(page, { point, deltaX: 30, deltaY: 20 });
  }
  await waitForTwoAnimationFrames(page);
  const after = await readLastFrame(page);
  expectClose({
    label: "camera offset x",
    actual: after.cameraOffsetX,
    expected: before.cameraOffsetX - 150,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "camera offset y",
    actual: after.cameraOffsetY,
    expected: before.cameraOffsetY - 100,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "camera scale",
    actual: after.cameraScale,
    expected: before.cameraScale,
    tolerance: 0.5,
    before,
    after,
  });
});

test("Pan by dragging empty space", async ({ page }) => {
  await openHighlightedFolder(page);
  const before = await readLastFrame(page);
  const point = await emptyCanvasPoint(page);
  const screenStart = await canvasScreenPoint(page, point);
  const boardPoint = boardPointAt(point, before);
  await page.mouse.move(screenStart.x, screenStart.y);
  await page.mouse.down({ button: "left" });
  for (let index = 1; index <= 10; index += 1) {
    await page.mouse.move(
      screenStart.x + index * 20,
      screenStart.y + index * 12,
    );
  }
  await page.mouse.up({ button: "left" });
  await waitForTwoAnimationFrames(page);
  const after = await readLastFrame(page);
  expectClose({
    label: "camera offset x",
    actual: after.cameraOffsetX,
    expected: before.cameraOffsetX + 200,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "camera offset y",
    actual: after.cameraOffsetY,
    expected: before.cameraOffsetY + 120,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "camera scale",
    actual: after.cameraScale,
    expected: before.cameraScale,
    tolerance: 0.5,
    before,
    after,
  });
  const shifted = screenPointForBoardPoint(boardPoint, after);
  expectClose({
    label: "board point release x",
    actual: shifted.x,
    expected: point.x + 200,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "board point release y",
    actual: shifted.y,
    expected: point.y + 120,
    tolerance: 0.5,
    before,
    after,
  });
});

test("Wheel over a widget with scrolling", async ({ page }) => {
  await openHighlightedFolder(page);
  await waitForSettledTiles(page);
  const body = await widgetBodyPoint(page);
  const before = await readLastFrame(page);
  const rectsBefore = await readWidgetRects(page);
  const widget = rectsBefore[0];
  if (!widget) throw new Error("Widget rect is missing");
  const region = {
    x: widget.rect.x + 20,
    y: widget.rect.y + DEFAULT_CODE_FONT.bodyTop + 10,
    width: Math.min(300, widget.rect.width - 40),
    height: Math.min(240, widget.rect.height - DEFAULT_CODE_FONT.bodyTop - 20),
  };
  await waitForTwoAnimationFrames(page);
  const pixelsBefore = await readCanvasRegion(page, region, 1);
  for (let index = 0; index < 3; index += 1) {
    await dispatchWheel(page, { point: body, deltaX: 0, deltaY: 300 });
  }
  await waitForTwoAnimationFrames(page);
  const after = await readLastFrame(page);
  const rectsAfter = await readWidgetRects(page);
  const pixelsAfter = await readCanvasRegion(page, region, 1);
  expectClose({
    label: "camera offset x",
    actual: after.cameraOffsetX,
    expected: before.cameraOffsetX,
    tolerance: 0.01,
    before,
    after,
  });
  expectClose({
    label: "camera offset y",
    actual: after.cameraOffsetY,
    expected: before.cameraOffsetY,
    tolerance: 0.01,
    before,
    after,
  });
  expectClose({
    label: "camera scale",
    actual: after.cameraScale,
    expected: before.cameraScale,
    tolerance: 0.01,
    before,
    after,
  });
  expectRectSetsEqual(rectsAfter, rectsBefore, before, after);
  const differences = pixelDifferenceCount(pixelsBefore, pixelsAfter);
  expect(
    differences,
    `sampled body pixels: measuredDifferences=${String(differences)} total=${String(pixelsAfter.length)} ${cameraText(before, after)}`,
  ).toBeGreaterThan(0);
});

test("Pinch-zoom toward a point", async ({ page }) => {
  await openHighlightedFolder(page);
  const point = await widgetBodyPoint(page);
  const before = await readLastFrame(page);
  const boardPoint = boardPointAt(point, before);
  for (let index = 0; index < 5; index += 1) {
    await dispatchWheel(page, {
      point,
      deltaX: 0,
      deltaY: -10,
      modifiers: 2,
    });
  }
  await waitForTwoAnimationFrames(page);
  const after = await readLastFrame(page);
  const expectedScale = before.cameraScale * Math.pow(zoomFactor(-10), 5);
  expectClose({
    label: "camera scale",
    actual: after.cameraScale,
    expected: expectedScale,
    tolerance: expectedScale * 1e-3,
    before,
    after,
  });
  const shifted = screenPointForBoardPoint(boardPoint, after);
  expectClose({
    label: "board point x",
    actual: shifted.x,
    expected: point.x,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "board point y",
    actual: shifted.y,
    expected: point.y,
    tolerance: 0.5,
    before,
    after,
  });
});

test("Zoom bounds", async ({ page }) => {
  await openHighlightedFolder(page);
  await page.evaluate(() => window.__codeCanvasTest?.setCamera(60, 76, 0.05));
  await waitForTwoAnimationFrames(page);
  await installCtrlWheelCapture(page);
  const before = await readLastFrame(page);
  const framesBefore = await readFrames(page);
  const lastTickBeforeGesture = framesBefore[framesBefore.length - 1]?.tick;
  if (lastTickBeforeGesture === undefined)
    throw new Error("Code Canvas frame log has no pre-gesture entry");
  const canvas = await page.getByTestId("canvas").boundingBox();
  if (!canvas) throw new Error("Canvas bounding box is unavailable");
  const point = {
    x: canvas.width / 2,
    y: canvas.height / 2,
  };
  for (let index = 0; index < 10; index += 1) {
    await dispatchWheel(page, {
      point,
      deltaX: 0,
      deltaY: 50,
      modifiers: 2,
    });
  }
  await waitForTwoAnimationFrames(page);
  const after = await readLastFrame(page);
  const framesAfter = await readFrames(page);
  const newFrames = framesAfter.filter(
    (frame) => frame.tick > lastTickBeforeGesture,
  );
  expect(
    newFrames.length,
    "No frame was drawn after the first ctrl wheel event",
  ).toBeGreaterThan(0);
  for (const frame of newFrames) {
    expectClose({
      label: "bounded camera scale",
      actual: frame.cameraScale,
      expected: 0.05,
      tolerance: 1e-9,
      before,
      after: frame,
    });
    expectClose({
      label: "bounded camera offset x",
      actual: frame.cameraOffsetX,
      expected: before.cameraOffsetX,
      tolerance: 1e-6,
      before,
      after: frame,
    });
    expectClose({
      label: "bounded camera offset y",
      actual: frame.cameraOffsetY,
      expected: before.cameraOffsetY,
      tolerance: 1e-6,
      before,
      after: frame,
    });
  }
  const prevented = await readCtrlWheelCapture(page);
  expect(prevented).toHaveLength(10);
  expect(prevented.every(Boolean)).toBe(true);
  expect(await readVisualViewportScale(page)).toBe(1);
  expectClose({
    label: "final camera scale",
    actual: after.cameraScale,
    expected: 0.05,
    tolerance: 1e-9,
    before,
    after,
  });
});

test("Browser zoom does not intercept the gesture", async ({ page }) => {
  await openHighlightedFolder(page);
  await installCtrlWheelCapture(page);
  const button = page.getByTestId("open-folder");
  const beforeButton = await button.boundingBox();
  if (!beforeButton)
    throw new Error("Open folder button bounds are unavailable");
  const before = await readLastFrame(page);
  const canvas = await page.getByTestId("canvas").boundingBox();
  if (!canvas) throw new Error("Canvas bounding box is unavailable");
  const point = { x: canvas.width / 2, y: canvas.height / 2 };
  for (let index = 0; index < 5; index += 1) {
    await dispatchWheel(page, {
      point,
      deltaX: 0,
      deltaY: -20,
      modifiers: 2,
    });
  }
  await waitForTwoAnimationFrames(page);
  const after = await readLastFrame(page);
  const afterButton = await button.boundingBox();
  if (!afterButton)
    throw new Error("Open folder button bounds are unavailable after zoom");
  expect(
    after.cameraScale > before.cameraScale,
    `camera scale increase: measured=${String(after.cameraScale)} start=${String(before.cameraScale)} ${cameraText(before, after)}`,
  ).toBe(true);
  const prevented = await readCtrlWheelCapture(page);
  expect(prevented).toHaveLength(5);
  expect(prevented.every(Boolean)).toBe(true);
  expect(await readVisualViewportScale(page)).toBe(1);
  expectClose({
    label: "open folder width",
    actual: afterButton.width,
    expected: beforeButton.width,
    tolerance: 0.5,
    before,
    after,
  });
  expectClose({
    label: "open folder height",
    actual: afterButton.height,
    expected: beforeButton.height,
    tolerance: 0.5,
    before,
    after,
  });
});
