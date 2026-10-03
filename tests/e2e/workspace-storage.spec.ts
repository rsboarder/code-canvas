import { expect, test, type Page } from "@playwright/test";

import { installDirectoryMock, readWidgetRects } from "./support";

interface Point {
  readonly x: number;
  readonly y: number;
}

function sourceText(lineCount: number): string {
  return Array.from(
    { length: lineCount },
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

async function dispatchWheel(page: Page, point: Point): Promise<void> {
  const box = await page.getByTestId("canvas").boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: box.x + point.x,
    y: box.y + point.y,
    deltaX: 40,
    deltaY: 30,
  });
}

function expectRectClose(
  label: string,
  actual: number,
  expected: number,
  measured: string,
): void {
  expect(
    Math.abs(actual - expected),
    `${label} measured=${String(actual)} expected=${String(expected)} ${measured}`,
  ).toBeLessThanOrEqual(0.5);
}

test("Restart", async ({ page }) => {
  const files = Array.from({ length: 3 }, (_, index) => ({
    path: `file-${String(index)}.ts`,
    text: sourceText(60),
  }));
  const folderName = await installDirectoryMock(page, files);
  await page.goto("/");
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");

  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box is unavailable");
  const center = { x: box.width / 2, y: box.height / 2 };
  await dispatchWheel(page, center);
  await dispatchWheel(page, center);
  await dispatchWheel(page, center);
  await waitForTwoAnimationFrames(page);
  const recordedRects = await readWidgetRects(page);
  await page.waitForTimeout(1500);

  await page.reload();
  const reopenButton = page.getByTestId("reopen-folder");
  await expect(reopenButton).toBeVisible();
  await expect(reopenButton).toContainText(folderName);
  await reopenButton.click();
  await expect(canvas).toHaveAttribute("data-widget-count", "3");
  await waitForTwoAnimationFrames(page);

  const restoredRects = await readWidgetRects(page);
  const measured = `recorded=${JSON.stringify(recordedRects)} restored=${JSON.stringify(restoredRects)}`;
  expect(
    restoredRects.length,
    `widget count measured=${String(restoredRects.length)} expected=3 ${measured}`,
  ).toBe(3);
  for (const recorded of recordedRects) {
    const restored = restoredRects.find(
      (widget) => widget.filePath === recorded.filePath,
    );
    expect(
      restored,
      `missing restored widget file=${recorded.filePath} ${measured}`,
    ).toBeDefined();
    if (!restored) continue;
    for (const property of ["x", "y", "width", "height"] as const) {
      expectRectClose(
        `${recorded.filePath} ${property}`,
        restored.rect[property],
        recorded.rect[property],
        measured,
      );
    }
  }
  await expect(reopenButton).toBeHidden();
});
