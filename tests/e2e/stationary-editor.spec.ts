import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  bodyPoint,
  installDirectoryMock,
  openFolder,
  readWidgetRects,
  type WidgetRect,
} from "./support";

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

interface FrameLogEntry {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface StationaryState {
  readonly widget: WidgetRect;
  readonly camera: FrameLogEntry;
  readonly scale: number;
  readonly editor: Box;
}

// Mirrors boardMetrics.edgeGrabScreenPx in src/app/main.ts:110.
const EDGE_GRAB_SCREEN_PX = 8;

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

async function readEditorBox(page: Page): Promise<Box> {
  const box = await page.locator(".monaco-editor").boundingBox();
  if (!box) throw new Error("Monaco bounding box is missing");
  return box;
}

async function readTopRenderedLine(
  page: Page,
): Promise<{ readonly text: string; readonly top: number }> {
  return page.locator(".monaco-editor .view-line").evaluateAll((lines) => {
    const topLine = lines
      .map((line) => ({
        text: line.textContent,
        top: line.getBoundingClientRect().top,
      }))
      .sort((left, right) => left.top - right.top)[0];
    if (!topLine) throw new Error("Top Monaco line is missing");
    return topLine;
  });
}

function widgetFor(rects: readonly WidgetRect[]): WidgetRect {
  const widget = rects[0];
  if (!widget)
    throw new Error(`Widget rect is missing: ${JSON.stringify(rects)}`);
  return widget;
}

function headerPoint(
  widget: WidgetRect,
  cameraScale: number,
): { x: number; y: number } {
  return {
    x: widget.rect.x + widget.rect.width / 2,
    y: widget.rect.y + (DEFAULT_CODE_FONT.bodyTop * cameraScale) / 2,
  };
}

function resizeCornerPoint(
  widget: WidgetRect,
  cameraScale: number,
): { x: number; y: number } {
  const band = EDGE_GRAB_SCREEN_PX / cameraScale;
  return {
    x: widget.rect.x + widget.rect.width + band / 2,
    y: widget.rect.y + widget.rect.height + band / 2,
  };
}

function expectWidgetRectToMatch(
  actual: WidgetRect,
  expected: WidgetRect,
): void {
  expect(actual.filePath).toBe(expected.filePath);
  expect(Math.abs(actual.rect.x - expected.rect.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(actual.rect.y - expected.rect.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(actual.rect.width - expected.rect.width)).toBeLessThanOrEqual(
    0.5,
  );
  expect(
    Math.abs(actual.rect.height - expected.rect.height),
  ).toBeLessThanOrEqual(0.5);
}

function expectBoxToMatch(actual: Box, expected: Box): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(1);
}

async function expectStationary(
  page: Page,
  expected: StationaryState,
): Promise<void> {
  await waitForTwoAnimationFrames(page);
  const canvas = page.getByTestId("canvas");
  const actualWidget = widgetFor(await readWidgetRects(page));
  const actualCamera = await readLastFrame(page);
  const actualEditor = await readEditorBox(page);
  expectWidgetRectToMatch(actualWidget, expected.widget);
  expect(
    Math.abs(actualCamera.cameraOffsetX - expected.camera.cameraOffsetX),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(actualCamera.cameraOffsetY - expected.camera.cameraOffsetY),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(actualCamera.cameraScale - expected.camera.cameraScale),
  ).toBeLessThanOrEqual(0.005);
  expect(
    Math.abs(
      Number(await canvas.getAttribute("data-text-metrics-scale")) -
        expected.scale,
    ),
  ).toBeLessThanOrEqual(0.005);
  expect(await canvas.getAttribute("data-editing")).toBe("true");
  expectBoxToMatch(actualEditor, expected.editor);
}

test("Attempt to drag the active widget", async ({ page }) => {
  await installDirectoryMock(page, "const answer = 42;\nreturn answer;\n");
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-highlighted", "true");

  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible();
  await waitForTwoAnimationFrames(page);

  const expectedWidget = widgetFor(await readWidgetRects(page));
  const expectedCamera = await readLastFrame(page);
  const expectedScale = Number(
    await canvas.getAttribute("data-text-metrics-scale"),
  );
  if (!Number.isFinite(expectedScale))
    throw new Error("Camera scale is missing");
  const expectedEditor = await readEditorBox(page);

  const header = headerPoint(expectedWidget, expectedCamera.cameraScale);
  await page.mouse.move(header.x, header.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      header.x + (120 * step) / 10,
      header.y + (80 * step) / 10,
    );
  }
  await page.mouse.up();
  await expectStationary(page, {
    widget: expectedWidget,
    camera: expectedCamera,
    scale: expectedScale,
    editor: expectedEditor,
  });

  const corner = resizeCornerPoint(expectedWidget, expectedCamera.cameraScale);
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(
      corner.x + (100 * step) / 10,
      corner.y + (100 * step) / 10,
    );
  }
  await page.mouse.up();
  await expectStationary(page, {
    widget: expectedWidget,
    camera: expectedCamera,
    scale: expectedScale,
    editor: expectedEditor,
  });
});

test("Swipe over the editor", async ({ page }) => {
  const text = Array.from(
    { length: 200 },
    (_, index) => `const line${String(index)} = ${String(index)};`,
  ).join("\n");
  await installDirectoryMock(page, text);
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-highlighted", "true");

  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible();
  await waitForTwoAnimationFrames(page);

  const beforeCamera = await readLastFrame(page);
  const beforeEditor = await readEditorBox(page);
  const beforeTopLine = await readTopRenderedLine(page);

  await page.mouse.move(
    beforeEditor.x + beforeEditor.width / 2,
    beforeEditor.y + beforeEditor.height / 2,
  );
  for (let event = 0; event < 4; event += 1) {
    await page.mouse.wheel(0, 800);
  }
  await waitForTwoAnimationFrames(page);

  const afterCamera = await readLastFrame(page);
  const afterEditor = await readEditorBox(page);
  const afterEditing = await canvas.getAttribute("data-editing");
  const afterTopLine = await readTopRenderedLine(page);

  expect(
    Math.abs(afterCamera.cameraOffsetX - beforeCamera.cameraOffsetX),
    `cameraOffsetX measured=${String(afterCamera.cameraOffsetX)} expected=${String(beforeCamera.cameraOffsetX)}`,
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(afterCamera.cameraOffsetY - beforeCamera.cameraOffsetY),
    `cameraOffsetY measured=${String(afterCamera.cameraOffsetY)} expected=${String(beforeCamera.cameraOffsetY)}`,
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(afterCamera.cameraScale - beforeCamera.cameraScale),
    `cameraScale measured=${String(afterCamera.cameraScale)} expected=${String(beforeCamera.cameraScale)}`,
  ).toBeLessThanOrEqual(0.005);
  expect(
    Math.abs(afterEditor.x - beforeEditor.x),
    `editor box measured=${JSON.stringify(afterEditor)} expected=${JSON.stringify(beforeEditor)}`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(afterEditor.y - beforeEditor.y),
    `editor box measured=${JSON.stringify(afterEditor)} expected=${JSON.stringify(beforeEditor)}`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(afterEditor.width - beforeEditor.width),
    `editor box measured=${JSON.stringify(afterEditor)} expected=${JSON.stringify(beforeEditor)}`,
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(afterEditor.height - beforeEditor.height),
    `editor box measured=${JSON.stringify(afterEditor)} expected=${JSON.stringify(beforeEditor)}`,
  ).toBeLessThanOrEqual(1);
  expect(
    afterEditing,
    `data-editing measured=${String(afterEditing)} expected=true`,
  ).toBe("true");
  expect(
    afterTopLine.text,
    `top line measured=${JSON.stringify(afterTopLine)} before=${JSON.stringify(beforeTopLine)}`,
  ).not.toBe(beforeTopLine.text);
});
