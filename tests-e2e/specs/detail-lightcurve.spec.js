import { test, expect } from "@playwright/test";
import { installOfflineGuard, openGoldenDetail, waitForLcData, firstDatumY, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

test("row click opens the detail view and renders the light curve", async ({ page }) => {
  await openGoldenDetail(page);
  await expect(page.locator(`#lc-canvas-${GOLDEN.oid}`)).toBeVisible();
  // Not just present — Chart.js built a chart with the replayed detections.
  await waitForLcData(page);
});

test("the Flux/Mag toggle flips the light-curve axis projection", async ({ page }) => {
  await openGoldenDetail(page);
  await waitForLcData(page);

  const toggle = page.locator(`.lc-mode-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`);
  await expect(toggle).toHaveText(/Flux/);

  // The toggle re-projected the data (first datum's y moved), not just the label.
  const fluxY = await firstDatumY(page);
  await toggle.click();
  await expect(toggle).toHaveText(/Mag/);
  await expect.poll(() => firstDatumY(page)).not.toBe(fluxY);
});
