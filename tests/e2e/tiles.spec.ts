import { expect, test, type Page } from "@playwright/test";

import {
  MAX_ZOOM_STEP_LN,
  PINCH_WHEEL_DELTA_PER_LN_SCALE,
} from "../../src/shared/pinch";
import { installDirectoryMock, openFolder } from "./support";

test.use({ deviceScaleFactor: 2 });

const DEVICE_PIXEL_RATIO = 2;
// A CDP pinch ends 150 ms after the last wheel event (design D6 "Zoom"); the
// extra margin lets the raster workers' round trip and the tile upload
// complete before a crop or the test hook is read.
const GESTURE_SETTLE_WAIT_MS = 600;

const SAMPLE_TEXT = `export function widget(value: number): number {
  const scaled = value * 2;
  return scaled + 1;
}
`;

interface TileDebugSnapshot {
  readonly rasterScales: readonly number[];
  readonly timeToSharpMs: number | undefined;
}

interface FrameLogEntry {
  readonly tick: number;
  readonly missingTile: boolean;
  readonly drawnTileCount: number;
  readonly drawnFallbackTileCount: number;
  readonly lowestEpochDrawn: number;
  readonly cameraScale: number;
  readonly detailLevel: 0 | 1;
}

async function readTileDebug(page: Page): Promise<TileDebugSnapshot> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.tileDebug();
  });
}

async function readFrameLog(page: Page): Promise<readonly FrameLogEntry[]> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.frameLog();
  });
}

async function expectNoMissingFrom(
  page: Page,
  firstTick: number,
): Promise<void> {
  const entries = await readFrameLog(page);
  expect(
    entries
      .filter((entry) => entry.tick >= firstTick)
      .every((entry) => !entry.missingTile),
  ).toBe(true);
}

async function nextFrameTick(page: Page): Promise<number> {
  const entries = await readFrameLog(page);
  return (entries[entries.length - 1]?.tick ?? -1) + 1;
}

async function cameraScale(page: Page): Promise<number> {
  return Number(
    await page.getByTestId("canvas").getAttribute("data-text-metrics-scale"),
  );
}

// A real pinch: ctrl+wheel events through CDP's input pipeline, each step
// clamped to MAX_ZOOM_STEP_LN like a trackpad event (design D8 "Pinch
// follows the fingers"), then a wait past the gesture's idle timeout so
// GestureInput reports the end and the zoom settle (D6 "Zoom") begins.
async function pinchZoomTo(
  page: Page,
  target: number,
  point: { x: number; y: number },
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const MAX_STEPS = 60;
  for (let attempt = 0; attempt < MAX_STEPS; attempt += 1) {
    const remainingLn = Math.log(target / (await cameraScale(page)));
    if (Math.abs(remainingLn) < 1e-3) break;
    // Recomputed from the actual camera scale every iteration (not planned
    // up front) so an occasionally coalesced wheel event still converges.
    const step =
      Math.sign(remainingLn) *
      Math.min(Math.abs(remainingLn), MAX_ZOOM_STEP_LN);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: -step * PINCH_WHEEL_DELTA_PER_LN_SCALE,
      modifiers: 2,
    });
    await waitForTwoAnimationFrames(page);
  }
  await expect.poll(() => cameraScale(page)).toBeCloseTo(target, 2);
  await page.waitForTimeout(GESTURE_SETTLE_WAIT_MS);
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

async function captureFirstLineCrop(
  page: Page,
  artifactPath: string,
): Promise<void> {
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  const rectValue = await canvas.getAttribute("data-widget-body-rect");
  if (!box || !rectValue) throw new Error("Widget body rect is missing");
  const rect = JSON.parse(rectValue) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const scale = await cameraScale(page);
  await page.screenshot({
    path: artifactPath,
    clip: {
      x: box.x + rect.x,
      y: box.y + rect.y,
      width: Math.min(rect.width, 420 * scale),
      height: Math.min(rect.height, 24 * scale),
    },
  });
}

test("Text is re-rasterized at the settled zoom", async ({ page }) => {
  await installDirectoryMock(page, SAMPLE_TEXT);
  await page.goto("/");
  await openFolder(page);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const point = { x: box.x + 400, y: box.y + 150 };

  await captureFirstLineCrop(page, "test-results/tiles/zoom-1.png");

  // The CDP pinch converges the camera scale to within 0.005 of the target
  // (same tolerance the zoom loop polls for); the raster scale (camera scale
  // x DPR) carries twice that absolute tolerance.
  const RASTER_SCALE_TOLERANCE = 0.02;

  let gestureStart = await nextFrameTick(page);
  await pinchZoomTo(page, 1.37, point);
  await expectNoMissingFrom(page, gestureStart);
  await captureFirstLineCrop(page, "test-results/tiles/zoom-1.37-settled.png");
  const settled = await readTileDebug(page);
  const expectedRasterScale = 1.37 * DEVICE_PIXEL_RATIO;
  expect(settled.rasterScales.length).toBeGreaterThan(0);
  settled.rasterScales.forEach((scale) => {
    expect(Math.abs(scale - expectedRasterScale)).toBeLessThan(
      RASTER_SCALE_TOLERANCE,
    );
  });
  expect(settled.timeToSharpMs).toBeGreaterThanOrEqual(0);

  gestureStart = await nextFrameTick(page);
  await pinchZoomTo(page, 2, point);
  await expectNoMissingFrom(page, gestureStart);
  await captureFirstLineCrop(page, "test-results/tiles/zoom-2-settled.png");
  const atTwo = await readTileDebug(page);
  atTwo.rasterScales.forEach((scale) => {
    expect(Math.abs(scale - 2 * DEVICE_PIXEL_RATIO)).toBeLessThan(
      RASTER_SCALE_TOLERANCE,
    );
  });

  gestureStart = await nextFrameTick(page);
  await pinchZoomTo(page, 0.5, point);
  await expectNoMissingFrom(page, gestureStart);
  await captureFirstLineCrop(page, "test-results/tiles/zoom-0.5-settled.png");
  const atHalf = await readTileDebug(page);
  atHalf.rasterScales.forEach((scale) => {
    expect(Math.abs(scale - 0.5 * DEVICE_PIXEL_RATIO)).toBeLessThan(
      RASTER_SCALE_TOLERANCE,
    );
  });
});

test("Zoom out from 4.0 keeps text on screen", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await installDirectoryMock(page, SAMPLE_TEXT);
  await page.goto("/");
  await openFolder(page);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const point = { x: box.x + 400, y: box.y + 150 };
  await pinchZoomTo(page, 4, point);
  const gestureStart = await nextFrameTick(page);
  await pinchZoomTo(page, 0.5, point);
  await expectNoMissingFrom(page, gestureStart);
  expect(pageErrors).toHaveLength(0);
});

test("Highlighting arrives without an empty frame", async ({ page }) => {
  await installDirectoryMock(page, SAMPLE_TEXT);
  await page.goto("/");
  await openFolder(page);
  await expect
    .poll(async () =>
      (await readFrameLog(page)).some(
        (entry) => entry.drawnTileCount > 0 && !entry.missingTile,
      ),
    )
    .toBe(true);
  await expect(page.getByTestId("canvas")).toHaveAttribute(
    "data-highlighted",
    "true",
  );
  await expect
    .poll(async () => (await readTileDebug(page)).rasterScales.length)
    .toBeGreaterThan(0);
  const entries = await readFrameLog(page);
  const firstSharp = entries.find(
    (entry) => entry.drawnTileCount > 0 && !entry.missingTile,
  );
  if (!firstSharp) throw new Error("No sharp tile frame was logged");
  expect(
    entries
      .filter((entry) => entry.tick >= firstSharp.tick)
      .every((entry) => !entry.missingTile),
  ).toBe(true);
});
