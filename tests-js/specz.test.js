/* DOM-level tests for src/static/js/specz.js — the Aladin spec-z overlay
 * loader. It now fetches one JSON blob from /api/xmatch_overlay (the server-side
 * bulk-crossmatch cache) instead of querying VizieR per catalog from the
 * browser, groups the returned sources by catalog, and draws one Aladin
 * catalog layer per group. We stub `window.A` (Aladin) and `fetch`, so no
 * network or real Aladin is involved.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { loadScript } from "./helpers/load.js";

const OVERLAY = [
  { cat_id: "desi", cat_name: "DESI", ra: 150.1, dec: 2.2, z: 0.345, z_err: 0.001, type: "GALAXY", sep: 1.2, color: "#ff7f0e", size: 14 },
  { cat_id: "desi", cat_name: "DESI", ra: 150.2, dec: 2.3, z: 0.5, z_err: null, type: "GALAXY", sep: 2.0, color: "#ff7f0e", size: 14 },
  { cat_id: "sdss", cat_name: "SDSS DR16", ra: 150.3, dec: 2.4, z: 0.1, z_err: 1e-4, type: "GALAXY", sep: 0.5, color: "#4fc3f7", size: 12 },
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
  test("groups overlay sources by catalog and adds them to Aladin", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overlay: OVERLAY }) });
    const added = [];
    const aladin = { addCatalog: (c) => added.push(c) };
    const onLoad = vi.fn();

    await window.loadSpecZOverlays(aladin, "OID1", "lsst", onLoad);

    // One catalog layer per cat_id (desi has 2 sources, sdss 1).
    expect(added).toHaveLength(2);
    const desi = added.find((c) => c.opts.color === "#ff7f0e");
    const sdss = added.find((c) => c.opts.color === "#4fc3f7");
    expect(desi.sources).toHaveLength(2);
    expect(sdss.sources).toHaveLength(1);
    // Redshift is stringified to 5 dp on the source's data (click→z reads this).
    expect(desi.sources[0].data.z).toBe("0.34500");
    expect(desi.sources[0].data.Source).toBe("DESI");
    expect(desi.opts.sourceSize).toBe(14);
    // onLoad fires once per catalog with its count (drives the legend chips).
    expect(onLoad).toHaveBeenCalledTimes(2);
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
        z: null, type: "star", sep: 0.5, label: "π=5.0 mas, d≈200 pc", color: "#42a5f5", size: 12 },
    ];
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ overlay }) });
    const added = [];
    await window.loadSpecZOverlays({ addCatalog: (c) => added.push(c) }, "OID", "ztf", vi.fn());
    expect(added).toHaveLength(1);
    const src = added[0].sources[0];
    expect(src.data.z).toBeUndefined();          // no redshift → no click→z
    expect(src.data.name).toContain("π=5.0 mas"); // popup uses the server label
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
