import { test, expect } from "@playwright/test";
import { installOfflineGuard, openGoldenDetail, waitForLcData, firstDatumY, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

test("the Aladin sky-view panel renders for the object", async ({ page }) => {
  await openGoldenDetail(page);
  await expect(page.locator("#aladin-panel")).toBeVisible();
  // The host element carries the coords the spec-z overlay + neighbor search
  // use. (The Aladin Lite widget itself loads from a CDN and is out of scope
  // for the offline suite; this asserts the panel + its data wiring render.)
  await expect(page.locator(".aladin-host")).toHaveAttribute("data-oid", GOLDEN.oid);
});

// The redshift loop's payoff: a redshift (delivered by clicking a host-galaxy
// spec-z source in Aladin) lands in the LC redshift input and unlocks absolute
// magnitudes via the Planck-2018 distance modulus. The Aladin/VizieR click is
// network-bound; here we drive its end result — filling the redshift input —
// and assert the absolute projection that follows.
test("a host redshift unlocks the absolute-magnitude projection", async ({ page }) => {
  await openGoldenDetail(page);
  await waitForLcData(page);

  const apparentY = await firstDatumY(page);

  const abs = page.locator(`.lc-abs-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`);
  await expect(abs).toHaveText(/App/);

  // With no redshift, App→Abs is guarded off (no distance modulus to apply).
  await abs.click();
  await expect(abs).toHaveText(/App/);
  expect(await firstDatumY(page)).toBe(apparentY);

  // Provide the redshift a host-galaxy click would, then Abs re-projects.
  await page.locator(`#lc-redshift-${GOLDEN.oid}`).fill("0.05");
  await abs.click();
  await expect(abs).toHaveText(/Abs/);
  await expect.poll(() => firstDatumY(page)).not.toBe(apparentY);
});
