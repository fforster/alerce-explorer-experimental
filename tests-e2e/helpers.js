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
