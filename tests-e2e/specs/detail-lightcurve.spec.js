import { test, expect } from "@playwright/test";
import { installOfflineGuard, openGoldenDetail, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

test("row click opens the detail view and renders the light curve", async ({ page }) => {
  await openGoldenDetail(page);

  const canvas = page.locator(`#lc-canvas-${GOLDEN.oid}`);
  await expect(canvas).toBeVisible();

  // The canvas isn't just present — Chart.js actually built a chart on it with
  // the replayed detections. Poll until the deferred LC fetch + render lands.
  await expect
    .poll(async () =>
      page.evaluate((oid) => {
        const cv = document.getElementById(`lc-canvas-${oid}`);
        const chart = window.Chart && cv && window.Chart.getChart(cv);
        if (!chart) return 0;
        return chart.data.datasets.reduce((n, ds) => n + (ds.data?.length || 0), 0);
      }, GOLDEN.oid),
    )
    .toBeGreaterThan(0);
});

test("the Flux/Mag toggle flips the light-curve axis projection", async ({ page }) => {
  await openGoldenDetail(page);

  const toggle = page.locator(`.lc-mode-toggle[data-target="lc-canvas-${GOLDEN.oid}"]`);
  await expect(toggle).toHaveText(/Flux/);

  // Snapshot the y of the first datapoint in flux space, toggle to mag, and
  // confirm both the button label and the projected value change — i.e. the
  // toggle re-projected the data, not just relabelled the button.
  const fluxY = await firstDatumY(page, GOLDEN.oid);
  await toggle.click();
  await expect(toggle).toHaveText(/Mag/);

  await expect
    .poll(async () => firstDatumY(page, GOLDEN.oid))
    .not.toBe(fluxY);
});

function firstDatumY(page, oid) {
  return page.evaluate((id) => {
    const cv = document.getElementById(`lc-canvas-${id}`);
    const chart = window.Chart && cv && window.Chart.getChart(cv);
    if (!chart) return null;
    for (const ds of chart.data.datasets) {
      const p = (ds.data || []).find((d) => d && typeof d.y === "number");
      if (p) return p.y;
    }
    return null;
  }, oid);
}
