import { test, expect } from "@playwright/test";
import { installOfflineGuard, openGoldenDetail, waitForLcData, firstDatumY, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

// Dereddening (Obs→Der) applies a per-band Milky-Way extinction correction
// (Fitzpatrick 1999 R_λ × E(B-V)). E(B-V) is normally auto-fetched from the
// IRSA dust proxy (network-bound); the input also accepts a manual value,
// which is what we use to drive the correction offline.
test("Obs→Der re-projects the light curve via a manual E(B-V)", async ({ page }) => {
  await openGoldenDetail(page);
  await waitForLcData(page);

  const observedY = await firstDatumY(page);

  const dered = page.locator(`.lc-dered-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`);
  await expect(dered).toHaveText(/Obs/);

  // Guarded off until a positive E(B-V) is present.
  await dered.click();
  await expect(dered).toHaveText(/Obs/);
  expect(await firstDatumY(page)).toBe(observedY);

  await page.locator(`#lc-ebv-${GOLDEN.oid}`).fill("0.3");
  await dered.click();
  await expect(dered).toHaveText(/Der/);
  await expect.poll(() => firstDatumY(page)).not.toBe(observedY);
});

// Absolute + dereddened compose: both corrections active at once must differ
// from either alone — the projection pipeline applies them independently.
test("absolute and dereddened corrections compose", async ({ page }) => {
  await openGoldenDetail(page);
  await waitForLcData(page);

  const base = await firstDatumY(page);
  await page.locator(`#lc-redshift-${GOLDEN.oid}`).fill("0.05");
  await page.locator(`#lc-ebv-${GOLDEN.oid}`).fill("0.3");

  await page.locator(`.lc-abs-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`).click();
  const absOnly = await firstDatumY(page);
  expect(absOnly).not.toBe(base);

  await page.locator(`.lc-dered-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`).click();
  await expect.poll(() => firstDatumY(page)).not.toBe(absOnly);
});
