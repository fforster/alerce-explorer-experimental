import { test, expect } from "@playwright/test";
import { installOfflineGuard, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

test("an OID search renders the object's row (from replay fixtures)", async ({ page }) => {
  await page.goto(`/?survey=${GOLDEN.survey}&oids=${GOLDEN.oid}`);
  const row = page.locator("tr.tw-cursor-pointer", { hasText: GOLDEN.oid });
  await expect(row).toBeVisible();
  // The row is the click target that opens the detail view.
  await expect(row).toHaveAttribute("hx-get", new RegExp(`/htmx/detail\\?oid=${GOLDEN.oid}`));
});
