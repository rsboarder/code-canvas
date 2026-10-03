import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_CODE_FONT } from "../../src/shared/font";
import {
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
  readCanvasColumn,
  readCanvasPixel,
  readWidgetRects,
  type Pixel,
} from "./support";

test.use({ deviceScaleFactor: 2 });

interface ShiftStats {
  readonly matches: number;
  readonly differences: number;
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

function compareAtShift(
  before: readonly Pixel[],
  after: readonly Pixel[],
  shift: number,
): ShiftStats {
  let matches = 0;
  let differences = 0;
  for (
    let index = 0;
    index < after.length && index + shift < before.length;
    index += 1
  ) {
    const expected = before[index + shift];
    const actual = after[index];
    if (
      expected?.red === actual?.red &&
      expected?.green === actual?.green &&
      expected?.blue === actual?.blue
    )
      matches += 1;
    else differences += 1;
  }
  return { matches, differences };
}

function columnDiagnostic(
  before: readonly Pixel[],
  after: readonly Pixel[],
  column: number,
  expectedShift: number,
): string {
  const atExpected = compareAtShift(before, after, expectedShift);
  let bestShift = 0;
  let best = compareAtShift(before, after, bestShift);
  for (let shift = 1; shift <= 150; shift += 1) {
    const current = compareAtShift(before, after, shift);
    if (current.matches > best.matches) {
      bestShift = shift;
      best = current;
    }
  }
  return `column x=${String(column)}: shift ${String(expectedShift)} differs ${String(atExpected.differences)} rows; best shift ${String(bestShift)} matches ${String(best.matches)} rows`;
}

function shiftedBy(
  before: readonly Pixel[],
  after: readonly Pixel[],
  shift: number,
): boolean {
  for (
    let index = 0;
    index < after.length && index + shift < before.length;
    index += 1
  ) {
    const expected = before[index + shift];
    const actual = after[index];
    if (
      expected?.red !== actual?.red ||
      expected?.green !== actual?.green ||
      expected?.blue !== actual?.blue
    )
      return false;
  }
  return true;
}

async function scrollUntil(page: Page, targetDeltaY: number): Promise<void> {
  let wheel = await readWheelCapture(page);
  while (wheel.deltaY < targetDeltaY) {
    await page.mouse.wheel(0, 1000);
    wheel = await readWheelCapture(page);
  }
}

async function expectTextAfterScroll(
  page: Page,
  columns: readonly number[],
  bodyTop: number,
  bodyBottom: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const samples = await Promise.all(
          columns.map((x) => readCanvasColumn(page, x, bodyTop, bodyBottom)),
        );
        const colors = new Set(
          samples
            .flat()
            .map(
              ({ red, green, blue }) =>
                `${String(red)},${String(green)},${String(blue)}`,
            ),
        );
        return colors.size >= 3;
      },
      { timeout: 5000 },
    )
    .toBe(true);
}

interface WheelCapture {
  readonly deltaY: number;
  readonly invalidMode: string | null;
}

async function installWheelCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="canvas"]',
    );
    if (!canvas) throw new Error("Canvas is unavailable");
    canvas.setAttribute("data-scroll-wheel-delta-y", "0");
    canvas.removeAttribute("data-scroll-wheel-invalid-mode");
    window.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
          canvas.setAttribute(
            "data-scroll-wheel-invalid-mode",
            String(event.deltaMode),
          );
          return;
        }
        const sum = Number(
          canvas.getAttribute("data-scroll-wheel-delta-y") ?? "0",
        );
        canvas.setAttribute(
          "data-scroll-wheel-delta-y",
          String(sum + event.deltaY),
        );
      },
      { capture: true },
    );
  });
}

async function readWheelCapture(page: Page): Promise<WheelCapture> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(
      '[data-testid="canvas"]',
    );
    if (!canvas) throw new Error("Canvas is unavailable");
    return {
      deltaY: Number(canvas.getAttribute("data-scroll-wheel-delta-y") ?? "0"),
      invalidMode: canvas.getAttribute("data-scroll-wheel-invalid-mode"),
    };
  });
}

async function readCameraScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const entries = window.__codeCanvasTest?.frameLog();
    return entries?.[entries.length - 1]?.cameraScale ?? 1;
  });
}

interface ShiftPollInput {
  readonly page: Page;
  readonly columns: readonly number[];
  readonly before: readonly (readonly Pixel[])[];
  readonly bodyTop: number;
  readonly bodyBottom: number;
  readonly expectedShift: number;
}

async function assertScrollShift(input: ShiftPollInput): Promise<void> {
  const canvas = input.page.getByTestId("canvas");
  let diagnostics = "";
  try {
    await expect
      .poll(
        async () => {
          const after = await Promise.all(
            input.columns.map((x) =>
              readCanvasColumn(
                input.page,
                x,
                input.bodyTop + 4,
                input.bodyBottom,
              ),
            ),
          );
          await canvas.screenshot({
            path: "test-results/content-scroll/after.png",
          });
          diagnostics = after
            .map((column, index) =>
              columnDiagnostic(
                input.before[index] ?? [],
                column,
                input.columns[index] ?? 0,
                input.expectedShift,
              ),
            )
            .join("\n");
          return after.every((column, index) =>
            shiftedBy(input.before[index] ?? [], column, input.expectedShift),
          );
        },
        { timeout: 3000 },
      )
      .toBe(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${diagnostics}`);
  }
}

test("Scrolling a long file", async ({ page }) => {
  const text = await readFile(
    "fixtures/reference-dataset/group-00/widget-000.tsx",
    "utf8",
  );
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, text, "widget-000.tsx");
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);

  const beforeRects = await readWidgetRects(page);
  const rect = beforeRects[0]?.rect;
  if (!rect) throw new Error("Scroll widget rect is unavailable");
  const canvasBox = await page.getByTestId("canvas").boundingBox();
  if (!canvasBox) throw new Error("Canvas bounds are unavailable");
  const bodyTop = rect.y + DEFAULT_CODE_FONT.bodyTop;
  const canvasBottom = canvasBox.y + canvasBox.height;
  const frameBottom = rect.y + rect.height;
  const columns = [60, 100, 140].map((offset) => rect.x + offset);
  await waitForSettledTiles(page);
  const canvas = page.getByTestId("canvas");
  await canvas.screenshot({ path: "test-results/content-scroll/before.png" });
  const before = await Promise.all(
    columns.map((x) =>
      readCanvasColumn(
        page,
        x,
        bodyTop + 4,
        Math.min(frameBottom, canvasBottom) - 4,
      ),
    ),
  );
  const header = await readCanvasPixel(page, rect.x + 60, rect.y + 16);

  await installWheelCapture(page);
  await page.mouse.move(rect.x + 100, bodyTop + 40);
  await page.mouse.wheel(0, 100);
  const wheel = await readWheelCapture(page);
  if (wheel.invalidMode)
    throw new Error(`Wheel deltaMode must be pixels, got ${wheel.invalidMode}`);
  if (!Number.isFinite(wheel.deltaY) || wheel.deltaY <= 0)
    throw new Error(
      `Wheel deltaY must be positive, got ${String(wheel.deltaY)}`,
    );
  const cameraScale = await readCameraScale(page);
  const expectedShift = wheel.deltaY / cameraScale;
  if (!Number.isInteger(expectedShift))
    throw new Error(
      `Expected a whole CSS-pixel shift, got ${String(expectedShift)}`,
    );
  const bodyEnd = Math.min(frameBottom, canvasBottom) - 4;
  const bodyBottom = bodyEnd - expectedShift;
  await assertScrollShift({
    page,
    columns,
    before,
    bodyTop,
    bodyBottom,
    expectedShift,
  });

  await scrollUntil(page, 4000);
  await expectTextAfterScroll(page, columns, bodyTop + 4, bodyEnd);

  expect(await readCanvasPixel(page, rect.x + 60, rect.y + 16)).toEqual(header);
  expect(await readWidgetRects(page)).toEqual(beforeRects);
});
