import { test, expect } from "@playwright/test";
import { installOfflineGuard } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

test("app shell loads with the search form", async ({ page }) => {
  await page.goto("/");
  // Header + a Search control are the minimum proof the shell rendered.
  await expect(page).toHaveTitle(/ALeRCE/i);
  await expect(page.getByRole("button", { name: /search/i }).first()).toBeVisible();
});
