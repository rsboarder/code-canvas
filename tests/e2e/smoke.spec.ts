import { expect, test } from "@playwright/test";

test("loads the Code Canvas page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Code Canvas");
});
