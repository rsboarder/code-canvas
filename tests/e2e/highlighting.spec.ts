import { expect, test } from "@playwright/test";

import {
  collectBrowserErrors,
  expectHighlighted,
  installDirectoryMock,
  openFolder,
} from "./support";

test.use({ deviceScaleFactor: 2 });

test("Multi-line constructs", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const text = [
    "const before = 1;",
    "/*",
    " * first comment line",
    " * second comment line",
    " * third comment line",
    " */",
    "const template = `",
    "alpha beta",
    "gamma delta",
    "`;",
    "// single-line comment",
    "const plain = `single line`;",
  ].join("\n");

  await installDirectoryMock(page, text);
  await page.goto("/");
  await openFolder(page);
  await expectHighlighted(page, browserErrors);

  const colors = await page.evaluate(() => {
    const hook = window.__codeCanvasTest;
    if (!hook) throw new Error("Code Canvas test hook is missing");
    return hook.cellColors();
  });
  const commentLineColors = [2, 3, 4].map((line) => {
    const cells = colors[line] ?? [];
    expect(cells.length).toBeGreaterThan(0);
    return cells.map((cell) => cell.colorIndex);
  });
  const singleLineComment = colors[10] ?? [];
  expect(singleLineComment.length).toBeGreaterThan(0);
  const commentColor = singleLineComment[0]?.colorIndex;
  expect(commentColor).not.toBe(0);
  for (const line of commentLineColors) {
    expect(line.every((colorIndex) => colorIndex === commentColor)).toBe(true);
  }
  expect(
    singleLineComment.every((cell) => cell.colorIndex === commentColor),
  ).toBe(true);
  expect(commentColor).not.toBe(colors[0]?.[0]?.colorIndex);

  const templateLine = colors[11] ?? [];
  const firstBacktick = templateLine.findIndex((cell) => cell.cluster === "`");
  let lastBacktick = -1;
  for (let index = templateLine.length - 1; index >= 0; index -= 1) {
    if (templateLine[index]?.cluster === "`") {
      lastBacktick = index;
      break;
    }
  }
  expect(firstBacktick).toBeGreaterThanOrEqual(0);
  expect(lastBacktick).toBeGreaterThan(firstBacktick);
  const templateColors = templateLine
    .slice(firstBacktick + 1, lastBacktick)
    .map((cell) => cell.colorIndex);
  expect(templateColors.length).toBeGreaterThan(0);
  const stringColor = templateColors[0];
  expect(stringColor).not.toBe(0);
  expect(templateColors.every((colorIndex) => colorIndex === stringColor)).toBe(
    true,
  );
  for (const line of [7, 8]) {
    const cells = colors[line] ?? [];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((cell) => cell.colorIndex === stringColor)).toBe(true);
  }
  expect(stringColor).not.toBe(commentColor);
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
});
