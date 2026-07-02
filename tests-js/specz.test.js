/* DOM-level tests for src/static/js/specz.js — the Aladin spec-z overlay
 * loader. It now fetches one JSON blob from /api/xmatch_overlay (the server-side
 * bulk-crossmatch cache) instead of querying VizieR per catalog from the
 * browser, groups the returned sources by catalog, and draws one Aladin
 * catalog layer per group. We stub `window.A` (Aladin) and `fetch`, so no
 * network or real Aladin is involved.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { loadScript } from "./helpers/load.js";

// Sources are grouped by CATEGORY (not catalog); all use the shared category
// colours (galaxies = dark green, stars = light blue).
const OVERLAY = [
  { cat_id: "desi", cat_name: "DESI", category: "host", ra: 150.1, dec: 2.2, z: 0.345, type: "GALAXY", sep: 1.2, label: "z = 0.345", color: "#2e7d32" },
  { cat_id: "desi", cat_name: "DESI", category: "host", ra: 150.2, dec: 2.3, z: 0.5, type: "GALAXY", sep: 2.0, label: "z = 0.5", color: "#2e7d32" },
  { cat_id: "sdss", cat_name: "SDSS DR16", category: "host", ra: 150.3, dec: 2.4, z: 0.1, type: "GALAXY", sep: 0.5, label: "z = 0.1", color: "#2e7d32" },
  { cat_id: "gaia", cat_name: "Gaia DR3", category: "stellar", ra: 151.0, dec: 3.0, z: null, type: "star", sep: 0.3, label: "π=5 mas", color: "#4fc3f7" },
];

beforeEach(() => {
  loadScript("src/static/js/specz.js"); // re-attaches window.loadSpecZOverlays
  // Minimal Aladin stub: source() echoes its args, catalog() collects sources.
  window.A = {
    source: (ra, dec, data) => ({ ra, dec, data }),
    catalog: (opts) => ({ opts, sources: [], addSources(s) { this.sources.push(...s); } }),
  };
});

describe("loadSpecZOverlays", () => {
  test("groups overlay sources by category and adds one layer each", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overlay: OVERLAY }) });
    const added = [];
    const aladin = { addCatalog: (c) => added.push(c) };
    const onLoad = vi.fn();

    await window.loadSpecZOverlays(aladin, "OID1", "lsst", onLoad);

    // One layer per category (3 galaxies, 1 star); stars are ordered first.
    expect(added).toHaveLength(2);
    // The host layer is qualified "specz" (spec-z galaxies only); the count
    // folds into the same paren.
    expect(added.map((c) => c.opts.name)).toEqual(["Stars (1)", "Galaxies (specz, 3)"]);
    const galaxies = added.find((c) => c.opts.name.startsWith("Galaxies"));
    expect(galaxies.opts.color).toBe("#2e7d32");
    expect(galaxies.sources).toHaveLength(3);
    // Each source carries structured click data (Source/ID/z) for the info bar.
    expect(galaxies.sources[0].data.Source).toBe("DESI");
    expect(galaxies.sources[0].data.z).toBe("0.34500");
    // onLoad fires once per category with the finished display label (which the
    // legend chip renders verbatim) + count.
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(onLoad).toHaveBeenCalledWith({ label: "Galaxies (specz, 3)", color: "#2e7d32", count: 3 });
  });

  test("queries the overlay endpoint with oid + survey", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overlay: [] }) });
    await window.loadSpecZOverlays({ addCatalog: vi.fn() }, "ZTF1", "ztf", vi.fn());
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain("/api/xmatch_overlay");
    expect(url).toContain("oid=ZTF1");
    expect(url).toContain("survey_id=ztf");
  });

  test("draws stellar/AGN markers that carry no redshift", async () => {
    const overlay = [
      { cat_id: "gaia_dr3", cat_name: "Gaia DR3", category: "stellar", ra: 10, dec: 20,
        z: null, type: "star", sep: 0.5, label: "π=5.0 mas, d≈200 pc", color: "#4fc3f7" },
    ];
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overlay }) });
    const added = [];
    await window.loadSpecZOverlays({ addCatalog: (c) => added.push(c) }, "OID", "ztf", vi.fn());
    expect(added).toHaveLength(1);
    expect(added[0].opts.name).toBe("Stars (1)");
    const src = added[0].sources[0];
    expect(src.data.z).toBeNull();                 // no redshift → no click→z
    expect(src.data.label).toContain("π=5.0 mas"); // info bar uses the server label
  });

  test("a failed fetch adds no catalogs (graceful)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const aladin = { addCatalog: vi.fn() };
    await window.loadSpecZOverlays(aladin, "OID1", "lsst", vi.fn());
    expect(aladin.addCatalog).not.toHaveBeenCalled();
  });

  test("returns a no-op when Aladin (window.A) is not loaded", async () => {
    window.A = undefined;
    global.fetch = vi.fn();
    const aladin = { addCatalog: vi.fn() };
    await window.loadSpecZOverlays(aladin, "OID1", "lsst", vi.fn());
    expect(aladin.addCatalog).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
