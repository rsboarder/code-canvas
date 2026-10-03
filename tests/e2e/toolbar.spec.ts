import { expect, test, type Page } from "@playwright/test";

import {
  installDirectoryMock,
  openFolder,
  readWidgetRects,
  type WidgetRect,
} from "./support";

interface Camera {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
}

interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function sourceText(): string {
  return Array.from(
    { length: 60 },
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

async function readCanvasBox(page: Page): Promise<CanvasBox> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  return box;
}

function isInside(rect: WidgetRect["rect"], box: CanvasBox): boolean {
  return (
    rect.x >= box.x &&
    rect.y >= box.y &&
    rect.x + rect.width <= box.x + box.width &&
    rect.y + rect.height <= box.y + box.height
  );
}

function assertRectsInside(rects: readonly WidgetRect[], box: CanvasBox): void {
  for (const widget of rects) {
    expect(
      isInside(widget.rect, box),
      `rect=${JSON.stringify(widget.rect)} canvas=${JSON.stringify(box)} allRects=${JSON.stringify(rects)}`,
    ).toBe(true);
  }
}

function assertRectsEqual(
  actual: readonly WidgetRect[],
  expected: readonly WidgetRect[],
): void {
  expect(
    actual.map((widget) => widget.filePath),
    `measuredRects=${JSON.stringify(actual)} expectedRects=${JSON.stringify(expected)}`,
  ).toEqual(expected.map((widget) => widget.filePath));
  for (const expectedWidget of expected) {
    const actualWidget = actual.find(
      (widget) => widget.filePath === expectedWidget.filePath,
    );
    expect(
      actualWidget,
      `measuredRects=${JSON.stringify(actual)} expectedRects=${JSON.stringify(expected)}`,
    ).toBeDefined();
    if (!actualWidget) continue;
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(actualWidget.rect[key] - expectedWidget.rect[key]),
        `file=${expectedWidget.filePath} key=${key} measuredRects=${JSON.stringify(actual)} expectedRects=${JSON.stringify(expected)}`,
      ).toBeLessThanOrEqual(0.5);
    }
  }
}

test("Fit all and 100% buttons", async ({ page }) => {
  await installDirectoryMock(page, sourceText(), "toolbar.ts");
  await page.goto("/");
  await openFolder(page);

  const canvas = await readCanvasBox(page);
  const initialRects = await readWidgetRects(page);
  expect(
    initialRects.some((widget) => !isInside(widget.rect, canvas)),
    `initialRects=${JSON.stringify(initialRects)} canvas=${JSON.stringify(canvas)}`,
  ).toBe(true);

  await page.getByTestId("fit-all").click();
  await waitForTwoAnimationFrames(page);
  const fitRects = await readWidgetRects(page);
  assertRectsInside(fitRects, canvas);

  const fitFrame = await readLastFrame(page);
  const centreWorld = {
    x: (canvas.width / 2 - fitFrame.cameraOffsetX) / fitFrame.cameraScale,
    y: (canvas.height / 2 - fitFrame.cameraOffsetY) / fitFrame.cameraScale,
  };
  await page.getByTestId("zoom-100").click();
  await waitForTwoAnimationFrames(page);

  const zoomFrame = await readLastFrame(page);
  expect(
    Math.abs(zoomFrame.cameraScale - 1),
    `camera=${JSON.stringify(zoomFrame)} canvas=${JSON.stringify(canvas)}`,
  ).toBeLessThanOrEqual(1e-6);
  const zoomCentreWorld = {
    x: (canvas.width / 2 - zoomFrame.cameraOffsetX) / zoomFrame.cameraScale,
    y: (canvas.height / 2 - zoomFrame.cameraOffsetY) / zoomFrame.cameraScale,
  };
  expect(
    Math.abs(zoomCentreWorld.x - centreWorld.x),
    `centreWorld=${JSON.stringify(centreWorld)} zoomCentreWorld=${JSON.stringify(zoomCentreWorld)} camera=${JSON.stringify(zoomFrame)} canvas=${JSON.stringify(canvas)}`,
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(zoomCentreWorld.y - centreWorld.y),
    `centreWorld=${JSON.stringify(centreWorld)} zoomCentreWorld=${JSON.stringify(zoomCentreWorld)} camera=${JSON.stringify(zoomFrame)} canvas=${JSON.stringify(canvas)}`,
  ).toBeLessThanOrEqual(0.5);

  await page.keyboard.press("Shift+1");
  await waitForTwoAnimationFrames(page);
  assertRectsEqual(await readWidgetRects(page), fitRects);
});
