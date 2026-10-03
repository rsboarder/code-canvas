import { expect, type Page } from "@playwright/test";

let directoryCounter = 0;

export interface DirectoryMockFile {
  readonly path: string;
  readonly text: string;
}

export interface WidgetRect {
  readonly filePath: string;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface Pixel {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface CanvasRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(`PAGEERROR: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`CONSOLE: ${message.text()}`);
    }
  });
  return errors;
}

export async function expectHighlighted(
  page: Page,
  browserErrors: string[],
): Promise<void> {
  try {
    await expect(page.getByTestId("canvas")).toHaveAttribute(
      "data-highlighted",
      "true",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\nBrowser diagnostics:\n${browserErrors.join("\n")}`,
    );
  }
}

export async function readWidgetRects(
  page: Page,
): Promise<readonly WidgetRect[]> {
  return page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.widgetRects();
  });
}

export async function readCanvasPixel(
  page: Page,
  x: number,
  y: number,
): Promise<Pixel> {
  const pixels = await readCanvasColumn(page, x, y, y);
  const pixel = pixels[0];
  if (!pixel) throw new Error("Canvas pixel is unavailable");
  return pixel;
}

export async function readCanvasColumn(
  page: Page,
  x: number,
  startY: number,
  endY: number,
): Promise<readonly Pixel[]> {
  return readCanvasRegion(
    page,
    {
      x,
      y: startY,
      width: 1,
      height: endY - startY + 1,
    },
    1,
  );
}

export async function readCanvasRegion(
  page: Page,
  region: CanvasRegion,
  step: number,
): Promise<readonly Pixel[]> {
  const canvas = page.getByTestId("canvas");
  const box = await canvas.boundingBox();
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const canvasWidth = box?.width ?? 0;
  const canvasHeight = box?.height ?? 0;
  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(canvasWidth, region.x + region.width);
  const bottom = Math.min(canvasHeight, region.y + region.height);
  if (right <= left || bottom <= top) return [];
  const floorLeft = Math.floor(left);
  const floorTop = Math.floor(top);
  const screenshot = await page.screenshot({
    clip: {
      x: (box?.x ?? 0) + floorLeft,
      y: (box?.y ?? 0) + floorTop,
      width: Math.ceil(right) - floorLeft,
      height: Math.ceil(bottom) - floorTop,
    },
  });
  return page.evaluate(
    async ({
      base64,
      xStep,
      left: leftCss,
      top: topCss,
      right: rightCss,
      bottom: bottomCss,
      scale: imageScale,
    }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const raster = document.createElement("canvas");
      raster.width = image.naturalWidth;
      raster.height = image.naturalHeight;
      const context = raster.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas pixel reader is unavailable");
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(
        0,
        0,
        raster.width,
        raster.height,
      ).data;
      const leftPixel = Math.floor(leftCss) * imageScale;
      const topPixel = Math.floor(topCss) * imageScale;
      const pixels: Pixel[] = [];
      for (let cssX = leftCss; cssX < rightCss; cssX += xStep) {
        for (let cssY = topCss; cssY < bottomCss; cssY += 1) {
          const pixelX = Math.floor(cssX * imageScale) - leftPixel;
          const pixelY = Math.floor(cssY * imageScale) - topPixel;
          const pixelIndex = (pixelY * raster.width + pixelX) * 4;
          pixels.push({
            red: imageData[pixelIndex] ?? 0,
            green: imageData[pixelIndex + 1] ?? 0,
            blue: imageData[pixelIndex + 2] ?? 0,
          });
        }
      }
      return pixels;
    },
    {
      base64: screenshot.toString("base64"),
      xStep: step,
      left,
      top,
      right,
      bottom,
      scale,
    },
  );
}

export async function installDirectoryMock(
  page: Page,
  textOrFiles: string | readonly DirectoryMockFile[],
  path = "widget-000.tsx",
): Promise<string> {
  const directoryName = `reference-dataset-${String(directoryCounter++)}`;
  const files: readonly DirectoryMockFile[] =
    typeof textOrFiles === "string"
      ? [{ path, text: textOrFiles }]
      : textOrFiles;
  await page.addInitScript(
    (input: {
      readonly directoryName: string;
      readonly files: readonly DirectoryMockFile[];
    }) => {
      const directory = (async () => {
        const opfs = await navigator.storage.getDirectory();
        try {
          await opfs.removeEntry(input.directoryName, { recursive: true });
        } catch {
          // The first test run has no dataset directory.
        }
        const root = await opfs.getDirectoryHandle(input.directoryName, {
          create: true,
        });
        for (const inputFile of input.files) {
          const parts = inputFile.path.split("/").filter(Boolean);
          const fileName = parts.pop();
          if (!fileName) throw new Error("Mock file path is empty.");
          let parent = root;
          for (const part of parts) {
            parent = await parent.getDirectoryHandle(part, { create: true });
          }
          const file = await parent.getFileHandle(fileName, { create: true });
          const writable = await file.createWritable();
          await writable.write(inputFile.text);
          await writable.close();
        }
        return root;
      })();
      Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: () => directory,
      });
    },
    { directoryName, files },
  );
  return directoryName;
}

export async function readMockFile(
  page: Page,
  directoryName: string,
  path: string,
): Promise<string> {
  return page.evaluate(
    async ({ directoryName: name, path: filePath }) => {
      const opfs = await navigator.storage.getDirectory();
      let parent = await opfs.getDirectoryHandle(name);
      const parts = filePath.split("/").filter(Boolean);
      const fileName = parts.pop();
      if (!fileName) throw new Error("Mock file path is empty.");
      for (const part of parts) {
        parent = await parent.getDirectoryHandle(part);
      }
      const file = await parent.getFileHandle(fileName);
      return (await file.getFile()).text();
    },
    { directoryName, path },
  );
}

export async function bodyPoint(page: Page): Promise<{ x: number; y: number }> {
  const value = await page
    .getByTestId("canvas")
    .getAttribute("data-widget-body-rect");
  if (!value) throw new Error("Widget body rect is missing");
  const rect = JSON.parse(value) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  return { x: rect.x + Math.min(120, rect.width / 2), y: rect.y + 24 };
}

export async function openFolder(page: Page): Promise<void> {
  const canvas = page.getByTestId("canvas");
  await page.getByTestId("open-folder").click();
  await expect(canvas).toHaveAttribute("data-widget-count", /\d+/);
  await page.evaluate(() => {
    window.__codeCanvasTest?.setCamera(60, 76, 1);
  });
}
