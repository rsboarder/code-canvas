import { expect, test } from "@playwright/test";

import { installDirectoryMock, openFolder } from "./support";

test("Turning the overlay on", async ({ page }) => {
  await installDirectoryMock(page, "const value = 1;\n");
  await page.goto("/");
  await openFolder(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });

  const overlay = page.getByTestId("metrics-overlay");
  await page.keyboard.press("Shift+M");
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) throw new Error("Overlay geometry is unavailable");
  expect(box.x).toBeGreaterThan(viewport.width * 0.75);
  expect(box.y).toBeLessThan(viewport.height * 0.25);
  await expect(overlay).toContainText("FPS");
  await expect(overlay).toContainText("p99");
  await expect(overlay).toContainText("Visible widgets");
  await expect(overlay).toContainText("Detail Level");

  const firstUpdate = await overlay.getAttribute("data-updated-at");
  await expect
    .poll(() => overlay.getAttribute("data-updated-at"), { timeout: 1200 })
    .not.toBe(firstUpdate);

  await page.keyboard.press("Shift+M");
  await expect(overlay).toBeHidden();
});
