import { expect } from "@playwright/test";

export const GOLDEN = { oid: "ZTF17aabopdz", survey: "ztf" };

// Make a test hermetic: allow only same-origin (the app + its vendored static
// assets) and abort every external request. Upstream ALeRCE data is already
// served from replay fixtures via the server; this blocks the browser-direct
// calls (Aladin CDN, IRSA dust proxy, VizieR spec-z, stamp images) so the
// suite needs no network and is fully deterministic. The app degrades
// gracefully when those fail.
export async function installOfflineGuard(page) {
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "127.0.0.1" || host === "localhost") return route.continue();
    return route.abort();
  });
}

// Open the golden object's detail view by driving the real UI: deep-link to
// the search results, then click the object's row (htmx GET /htmx/detail).
export async function openGoldenDetail(page) {
  await page.goto(`/?survey=${GOLDEN.survey}&oids=${GOLDEN.oid}`);
  const row = page.locator("tr.tw-cursor-pointer", { hasText: GOLDEN.oid });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator("#object-detail")).toBeVisible();
}

// Total number of plotted datapoints across all LC datasets (0 until the
// deferred fetch + Chart.js render lands).
export function lcPointCount(page, oid = GOLDEN.oid) {
  return page.evaluate((id) => {
    const cv = document.getElementById(`lc-canvas-${id}`);
    const chart = window.Chart && cv && window.Chart.getChart(cv);
    if (!chart) return 0;
    return chart.data.datasets.reduce((n, ds) => n + (ds.data?.length || 0), 0);
  }, oid);
}

// Wait until the light curve has rendered its data, so subsequent interactions
// (toggles, periodogram, selection) act on a populated chart.
export async function waitForLcData(page, oid = GOLDEN.oid) {
  await expect.poll(() => lcPointCount(page, oid), { timeout: 15_000 }).toBeGreaterThan(0);
}

// Wait until the LC has fully settled — the deferred FP / cross-survey / features
// fragments have all landed and stopped rebuilding the chart. Needed before any
// pixel-precise interaction (clicking a specific marker), since a mid-flight
// applyModes() rebuild moves the markers. Detects a point count stable across
// consecutive polls.
export async function waitForLcSettled(page, oid = GOLDEN.oid) {
  await waitForLcData(page, oid);
  let prev = -1;
  await expect
    .poll(
      async () => {
        const n = await lcPointCount(page, oid);
        const stable = n > 0 && n === prev;
        prev = n;
        return stable;
      },
      { intervals: [500, 500, 500, 500, 500], timeout: 15_000 },
    )
    .toBe(true);
}

// The projected y of the first datapoint that has one — the value every LC
// toggle re-projects. Used to prove a toggle changed the data, not just a label.
export function firstDatumY(page, oid = GOLDEN.oid) {
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
