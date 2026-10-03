import { expect, test, type Page } from "@playwright/test";

import { installDirectoryMock, openFolder, readWidgetRects } from "./support";

test.describe.configure({ mode: "serial" });

interface FrameCamera {
  readonly cameraOffsetX: number;
  readonly cameraOffsetY: number;
  readonly cameraScale: number;
}

function sixtyLines(): string {
  return Array.from(
    { length: 60 },
    (_, index) => `const value${String(index)} = ${String(index)};`,
  ).join("\n");
}

async function lastFrameCamera(page: Page): Promise<FrameCamera> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    const frames = hook.frameLog();
    const frame = frames[frames.length - 1];
    if (!frame) throw new Error("Code Canvas frame log is empty");
    return {
      cameraOffsetX: frame.cameraOffsetX,
      cameraOffsetY: frame.cameraOffsetY,
      cameraScale: frame.cameraScale,
    };
  });
}

async function diagnostic(page: Page, filePath: string): Promise<string> {
  const [camera, rects] = await Promise.all([
    lastFrameCamera(page),
    readWidgetRects(page),
  ]);
  const rect = rects.find((entry) => entry.filePath === filePath);
  return `camera=${JSON.stringify(camera)} rect=${JSON.stringify(rect)}`;
}

test("Double click on the minimap", async ({ page }) => {
  await installDirectoryMock(page, [
    { path: "a.ts", text: sixtyLines() },
    { path: "b.ts", text: sixtyLines() },
    { path: "c.ts", text: sixtyLines() },
  ]);
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() => window.__codeCanvasTest?.setCamera(60, 76, 0.1));
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-detail-level", "minimap");

  const initialRects = await readWidgetRects(page);
  const target = initialRects[1];
  if (!target) throw new Error("Second widget rect is unavailable");
  const point = {
    x: target.rect.x + target.rect.width / 2,
    y: target.rect.y + target.rect.height / 2,
  };

  try {
    await canvas.dblclick({ position: point });
    await expect
      .poll(() => lastFrameCamera(page), { timeout: 5000 })
      .toMatchObject({ cameraScale: 1 });
    const camera = await lastFrameCamera(page);
    expect(Math.abs(camera.cameraScale - 1)).toBeLessThanOrEqual(1e-6);

    await expect(canvas).toHaveAttribute("data-editing", "false");
    await expect(canvas).toHaveAttribute("data-detail-level", "text", {
      timeout: 5000,
    });
    const viewport = await canvas.boundingBox();
    const rect = (await readWidgetRects(page)).find(
      (entry) => entry.filePath === target.filePath,
    );
    if (!viewport || !rect)
      throw new Error("Zoomed widget geometry is missing");
    expect(
      Math.abs(rect.rect.x + rect.rect.width / 2 - viewport.width / 2),
    ).toBeLessThanOrEqual(0.5);
    expect(Math.abs(rect.rect.y - 40)).toBeLessThanOrEqual(0.5);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${await diagnostic(page, target.filePath)}`);
  }
});
