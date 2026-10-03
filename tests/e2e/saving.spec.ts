import { expect, test } from "@playwright/test";

import {
  bodyPoint,
  installDirectoryMock,
  openFolder,
  readMockFile,
} from "./support";

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

test("Autosave", async ({ page }) => {
  const directoryName = await installDirectoryMock(
    page,
    "const answer = 42;\n",
  );
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-highlighted", "true");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.type("x");
  await expect
    .poll(() => readMockFile(page, directoryName, "widget-000.tsx"), {
      timeout: 5000,
    })
    .toContain("x");
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect(canvas).toHaveAttribute("data-content-version", "2");
});

test("Write error", async ({ page }) => {
  const directoryName = await installDirectoryMock(
    page,
    "const answer = 42;\n",
  );
  await page.goto("/");
  await openFolder(page);
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toHaveAttribute("data-highlighted", "true");
  await canvas.dblclick({ position: await bodyPoint(page) });
  await expect(canvas).toHaveAttribute("data-editing", "true");
  await page.evaluate(() => {
    const original = Reflect.get(
      FileSystemFileHandle.prototype,
      "createWritable",
    ) as unknown;
    if (typeof original !== "function") {
      throw new Error("File handle write method is unavailable");
    }
    const createWritable = original as (
      this: FileSystemFileHandle,
    ) => Promise<FileSystemWritableFileStream>;
    Object.defineProperty(window, "__codeCanvasFailWrites", {
      configurable: true,
      writable: true,
      value: false,
    });
    FileSystemFileHandle.prototype.createWritable = function () {
      const windowWithFlag = window as unknown as {
        __codeCanvasFailWrites: boolean;
      };
      if (windowWithFlag.__codeCanvasFailWrites) {
        return Promise.reject(
          new DOMException("Access revoked", "NotAllowedError"),
        );
      }
      return createWritable.call(this);
    };
  });
  await page.evaluate(() => {
    (
      window as unknown as { __codeCanvasFailWrites: boolean }
    ).__codeCanvasFailWrites = true;
  });
  await page.keyboard.type("x");
  await expect(page.getByTestId("write-error")).toBeVisible();
  await expect(
    readMockFile(page, directoryName, "widget-000.tsx"),
  ).resolves.toBe("const answer = 42;\n");
  await page.keyboard.press("Escape");
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await page.evaluate(() => {
    (
      window as unknown as { __codeCanvasFailWrites: boolean }
    ).__codeCanvasFailWrites = false;
  });
  await expect
    .poll(() => readMockFile(page, directoryName, "widget-000.tsx"), {
      timeout: 10000,
    })
    .toContain("x");
  await expect(page.getByTestId("write-error")).toBeHidden();
});
