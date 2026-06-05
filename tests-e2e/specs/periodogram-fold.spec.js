import { test, expect } from "@playwright/test";
import { installOfflineGuard, openGoldenDetail, waitForLcData, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

// The periodogram runs entirely in the browser on the live LC data, then its
// best peak folds the main chart via window.lcSetFoldPeriod. This drives that
// whole pipeline: open the panel → compute → assert the LC folded.
test("computing the periodogram folds the light curve at the best peak", async ({ page }) => {
  await openGoldenDetail(page);
  await waitForLcData(page);

  await page.locator(`.lc-periodogram-btn[data-target="lc-canvas-${GOLDEN.oid}"]`).click();
  const panel = page.locator("[data-pg-panel]");
  await expect(panel).toBeVisible();

  // Narrow the period range and drop oversampling so the in-browser compute is
  // fast and deterministic in CI (the fold assertion doesn't depend on the
  // exact peak, only that a peak was found and applied).
  await panel.locator("[data-pg-min]").fill("1");
  await panel.locator("[data-pg-max]").fill("20");
  await panel.locator("[data-pg-oversample]").fill("1");
  await panel.locator("[data-pg-compute]").click();

  // compute() ends by selecting the best peak, which folds the main LC.
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const cv = document.getElementById(`lc-canvas-${id}`);
          const chart = window.Chart && cv && window.Chart.getChart(cv);
          return chart ? { fold: chart.$lcFold, period: chart.$lcPeriod } : null;
        }, GOLDEN.oid),
      { timeout: 45_000 },
    )
    .toEqual(expect.objectContaining({ fold: "fold" }));

  const period = await page.evaluate((id) => {
    const cv = document.getElementById(`lc-canvas-${id}`);
    return window.Chart.getChart(cv).$lcPeriod;
  }, GOLDEN.oid);
  expect(period).toBeGreaterThan(0);

  // The Fold button should now reflect the folded state.
  await expect(page.locator(`.lc-fold-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`))
    .toHaveAttribute("data-lc-fold", "fold");
});
