import { expect, test } from "@playwright/test";

import {
  bodyPoint,
  installDirectoryMock,
  openFolder,
  readMockFile,
} from "./support";

test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

async function expectMineSaved(
  page: Parameters<typeof installDirectoryMock>[0],
  directoryName: string,
): Promise<void> {
  await expect
    .poll(() => readMockFile(page, directoryName, "widget-000.tsx"), {
      timeout: 5000,
    })
    .toContain("x");
  await expect
    .poll(() => readMockFile(page, directoryName, "widget-000.tsx"), {
      timeout: 5000,
    })
    .toContain("y");
  const savedMine = await readMockFile(page, directoryName, "widget-000.tsx");
  expect(
    savedMine,
    `The mine version must include the original text; measured ${JSON.stringify(savedMine)}`,
  ).toContain("answer");
}

test("Conflict with an external change", async ({ page }) => {
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

  await page.evaluate(async (name) => {
    const opfs = await navigator.storage.getDirectory();
    const directory = await opfs.getDirectoryHandle(name);
    const file = await directory.getFileHandle("widget-000.tsx");
    const writable = await file.createWritable();
    await writable.write("const external = 1;\n");
    await writable.close();
  }, directoryName);
  await page.keyboard.type("y");
  await expect(page.getByTestId("save-conflict")).toBeVisible();
  const externalText = await readMockFile(
    page,
    directoryName,
    "widget-000.tsx",
  );
  expect(
    externalText,
    `The external version must remain on disk; measured ${JSON.stringify(externalText)}`,
  ).toBe("const external = 1;\n");

  await page.getByTestId("save-conflict-mine").click();
  await expect(page.getByTestId("save-conflict")).toBeHidden();
  await expectMineSaved(page, directoryName);
  await expect(canvas).toHaveAttribute("data-editing", "true");

  await page.evaluate(async (name) => {
    const opfs = await navigator.storage.getDirectory();
    const directory = await opfs.getDirectoryHandle(name);
    const file = await directory.getFileHandle("widget-000.tsx");
    const writable = await file.createWritable();
    await writable.write("const external = 2;\n");
    await writable.close();
  }, directoryName);
  await page.keyboard.type("z");
  await expect(page.getByTestId("save-conflict")).toBeVisible();
  const versionBeforeDisk = await canvas.getAttribute("data-content-version");
  expect(
    versionBeforeDisk,
    `The content version must be present before disk resolution; measured ${JSON.stringify(versionBeforeDisk)}`,
  ).not.toBeNull();

  await page.getByTestId("save-conflict-disk").click();
  await expect(canvas).toHaveAttribute("data-editing", "false");
  await expect(page.getByTestId("save-conflict")).toBeHidden();
  await expect
    .poll(() => canvas.getAttribute("data-content-version"), {
      timeout: 5000,
    })
    .not.toBe(versionBeforeDisk);
  await expect(canvas).toHaveAttribute("data-highlighted", "true");
  await page.waitForTimeout(1500);
  const diskText = await readMockFile(page, directoryName, "widget-000.tsx");
  expect(
    diskText,
    `The disk version must not be overwritten by the discarded draft; measured ${JSON.stringify(diskText)}`,
  ).toBe("const external = 2;\n");
});
