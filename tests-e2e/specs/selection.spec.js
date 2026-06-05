import { test, expect } from "@playwright/test";
import { installOfflineGuard, openGoldenDetail, waitForLcData, GOLDEN } from "../helpers.js";

test.beforeEach(async ({ page }) => installOfflineGuard(page));

// Locate an *isolated* clickable detection (has_stamp marker with no other
// marker within a few pixels). Chart's onClick acts on the topmost element at
// the click pixel, so a crowded marker may resolve to a non-stamp point and
// select nothing; an isolated point is unambiguous. Returns its canvas-
// relative pixel, recomputed fresh each call so it survives chart rebuilds.
function findIsolatedDetection(page, oid) {
  return page.evaluate((id) => {
    const cv = document.getElementById(`lc-canvas-${id}`);
    const chart = cv && window.Chart && window.Chart.getChart(cv);
    if (!chart) return null;
    const a = chart.chartArea;
    const inset = 20;
    const ISO = 6;
    const all = [];
    for (let di = 0; di < chart.data.datasets.length; di++) {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) continue;
      for (let i = 0; i < meta.data.length; i++) {
        if (meta.data[i]) all.push({ di, i, x: meta.data[i].x, y: meta.data[i].y });
      }
    }
    for (const c of all) {
      if (!(c.x > a.left + inset && c.x < a.right - inset && c.y > a.top + inset && c.y < a.bottom - inset)) continue;
      const d = chart.data.datasets[c.di].data[c.i];
      if (!d || !d.has_stamp || !d.identifier) continue;
      const crowded = all.some((o) => (o.di !== c.di || o.i !== c.i) && Math.hypot(o.x - c.x, o.y - c.y) < ISO);
      if (!crowded) return { x: c.x, y: c.y, id: String(d.identifier) };
    }
    return null;
  }, oid);
}

// Cross-panel selection: clicking a detection on the light curve sets the
// global selection (window._selectedIdentifier), which drives the stamp panel
// and the highlight ring. Performs a real pixel click on a plotted point.
// Re-finds + re-clicks in a poll loop so a deferred-fragment chart rebuild
// (FP / cross-survey / ZTF-DR landing and moving the markers) can't race the
// click — the selection persists on window once it lands.
test("clicking a light-curve point selects that detection", async ({ page }) => {
  await openGoldenDetail(page);
  await waitForLcData(page);

  await expect
    .poll(
      async () => {
        const pt = await findIsolatedDetection(page, GOLDEN.oid);
        if (!pt) return null;
        await page.locator(`#lc-canvas-${GOLDEN.oid}`).click({ position: { x: pt.x, y: pt.y } });
        return page.evaluate(() => window._selectedIdentifier);
      },
      { intervals: [400, 600, 800, 1000, 1200], timeout: 25_000 },
    )
    .toEqual(expect.stringMatching(/^\d+$/)); // a real detection candid/measurement_id
});
