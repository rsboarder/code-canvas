import { expect, test } from "@playwright/test";

import {
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
  readCanvasRegion,
} from "./support";

test.use({ deviceScaleFactor: 2 });

const SAMPLE_TEXT = 'export const answer: string = "forty-two";\n';

interface CanvasRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function readBodyRegion(
  page: Parameters<typeof readCanvasRegion>[0],
): Promise<CanvasRegion> {
  const value = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  if (!value) throw new Error("Widget body rect is missing");
  return JSON.parse(value) as CanvasRegion;
}

async function countColoredPixels(
  page: Parameters<typeof readCanvasRegion>[0],
): Promise<{ readonly count: number; readonly region: CanvasRegion }> {
  const region = await readBodyRegion(page);
  const pixels = await readCanvasRegion(page, region, 1);
  const count = pixels.filter((pixel) => {
    const channels = [pixel.red, pixel.green, pixel.blue];
    return Math.max(...channels) - Math.min(...channels) >= 60;
  }).length;
  return { count, region };
}

async function expectColoredPixels(
  page: Parameters<typeof readCanvasRegion>[0],
  minimum: number,
  label: string,
): Promise<void> {
  let result: Awaited<ReturnType<typeof countColoredPixels>> = {
    count: 0,
    region: { x: 0, y: 0, width: 0, height: 0 },
  };
  try {
    await expect
      .poll(
        async () => {
          result = await countColoredPixels(page);
          return result.count;
        },
        {
          timeout: 5000,
          message: `${label}: count and region did not reach the threshold`,
        },
      )
      .toBeGreaterThanOrEqual(minimum);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n${label}: count=${String(result.count)} region=${JSON.stringify(result.region)}`,
    );
  }
}

test("All shaders compile and link", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, SAMPLE_TEXT);
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);
  await expectColoredPixels(page, 20, "text body");

  await page.evaluate(() => {
    window.__codeCanvasTest?.setCamera(60, 76, 0.2);
  });
  await expectColoredPixels(page, 4, "minimap body");
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});

test("Context loss and restore", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await installDirectoryMock(page, SAMPLE_TEXT);
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);
  await expectColoredPixels(page, 20, "pre-loss text body");

  await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="canvas"]',
    );
    if (!canvas) throw new Error("Canvas is missing");
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 context is missing");
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("WEBGL_lose_context is unavailable");
    const lost = new Promise<void>((resolve) => {
      canvas.addEventListener(
        "webglcontextlost",
        () => {
          resolve();
        },
        { once: true },
      );
    });
    const restored = new Promise<void>((resolve) => {
      canvas.addEventListener(
        "webglcontextrestored",
        () => {
          resolve();
        },
        { once: true },
      );
    });
    extension.loseContext();
    await lost;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 0);
    });
    extension.restoreContext();
    await restored;
  });

  await expectColoredPixels(
    page,
    20,
    "restored text body did not regain coloured pixels",
  );
  await page.evaluate(() => {
    window.__codeCanvasTest?.setCamera(60, 76, 0.2);
  });
  await expectColoredPixels(page, 4, "restored minimap body");
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
