/* Host-galaxy spec-z overlays for the Aladin panel.
 *
 * Queries 10 VizieR catalogs (conesearch, 3 arcmin) in parallel straight
 * from the browser — VizieR CORS is open, so no server round trip is
 * needed and each catalog appears as it returns. Failures are silent
 * (console.warn only) so one slow or unreachable catalog never blocks
 * the others.
 *
 * Each config entry mirrors the prototype: which table(s), which columns
 * hold ra/dec/z/e_z, whether z is stored as a radial velocity that needs
 * cz→z conversion, a filter for reliable redshifts (quality flag, etc.)
 * and a color/size for the Aladin overlay.
 *
 * Clicking any source is wired in aladin.js (via the global
 * `objectClicked` event); the z from `obj.data.z` is copied into the
 * per-oid `lc-redshift-{oid}` input.
 */
(function () {
  const C = 299792.458;       // km/s, for cz → z conversion
  const RADIUS_DEG = 0.05;    // 3 arcmin cone
  const REQUEST_TIMEOUT_MS = 20000;

  const SPEC_Z_CATALOGS = [
    {
      id: "desi", name: "DESI DR1", tables: ["V/161/zcatdr1"],
      raCol: "RAICRS", decCol: "DEICRS",
      zCol: "z", ezCol: "e_z", czConvert: false,
      typeLabel: (r) => [r.OType, r.SubType].filter(Boolean).join(" / "),
      filter:    (r) => r.ZWARN === "0",
      qualLabel: (r) => `ZWARN=${r.ZWARN}`,
      color: "#ff7f0e", size: 14,
    },
    {
      id: "sdss", name: "SDSS DR16", tables: ["V/154/sdss16"],
      raCol: "RA_ICRS", decCol: "DE_ICRS",
      zCol: "zsp", ezCol: "e_zsp", czConvert: false,
      typeLabel: (r) => [r.spCl, r.subCl].filter(Boolean).join(" / "),
      filter:    (r) => r.zsp && r.zsp.trim() !== "" && r.f_zsp === "0",
      qualLabel: (r) => `f_zsp=${r.f_zsp}`,
      color: "#4fc3f7", size: 12,
    },
    {
      id: "sdss_qso", name: "SDSS DR16 QSO", tables: ["VII/289/dr16q"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "z", ezCol: null, czConvert: false,
      typeLabel: (r) => r.Class || "QSO",
      filter:    (r) => r.z && r.z.trim() !== "",
      qualLabel: (r) => `r_z=${r.r_z || "?"}`,
      color: "#ce93d8", size: 12,
    },
    {
      id: "6dfgs", name: "6dFGS", tables: ["VII/259/6dfgs"],
      raCol: "_RAJ2000", decCol: "_DEJ2000",
      zCol: "cz", ezCol: "e_cz", czConvert: true,
      typeLabel: (r) => r.r_cz || "",
      filter:    (r) => parseFloat(r.q_cz) >= 3,
      qualLabel: (r) => `Q=${r.q_cz}`,
      color: "#81c784", size: 12,
    },
    {
      id: "gama", name: "GAMA DR4", tables: ["J/MNRAS/513/439/gamadr4"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "z", ezCol: null, czConvert: false,
      typeLabel: (r) => r.Survey || "",
      filter:    (r) => parseFloat(r.q_z) >= 3 && r.IsBest === "1",
      qualLabel: (r) => `nQ=${r.q_z}`,
      color: "#ef9a9a", size: 12,
    },
    {
      id: "2mrs", name: "2MRS", tables: ["J/ApJS/199/26/table3"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "cz", ezCol: "e_cz", czConvert: true,
      typeLabel: (r) => r.type || "",
      filter:    (r) => r.cz && r.cz.trim() !== "" && !isNaN(parseFloat(r.cz)),
      qualLabel: () => "",
      color: "#80cbc4", size: 12,
    },
    {
      id: "wigglez", name: "WiggleZ", tables: ["J/MNRAS/474/4151/wigglez"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "z", ezCol: "e_z", czConvert: false,
      typeLabel: (r) => r.Class || "",
      filter:    (r) => parseFloat(r.q_z) >= 3,
      qualLabel: (r) => `Q=${r.q_z}`,
      color: "#fff176", size: 12,
    },
    {
      id: "zcosmos", name: "zCOSMOS", tables: ["J/ApJS/184/218/table3"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "z", ezCol: null, czConvert: false,
      typeLabel: () => "GALAXY",
      filter:    (r) => parseFloat(r.CClass) >= 2.5,
      qualLabel: (r) => `CC=${r.CClass}`,
      color: "#f48fb1", size: 12,
    },
    {
      id: "vipers", name: "VIPERS PDR2",
      tables: ["J/A+A/609/A84/vipersw1", "J/A+A/609/A84/vipersw4"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "zsp", ezCol: null, czConvert: false,
      typeLabel: (r) => r.classFlag || "",
      filter:    (r) => parseFloat(r.zflg) >= 2.0,
      qualLabel: (r) => `zflg=${r.zflg}`,
      color: "#ffcc80", size: 12,
    },
    {
      id: "ozdes", name: "OzDES DR1", tables: ["J/MNRAS/472/273/ozdesdr1"],
      raCol: "RAJ2000", decCol: "DEJ2000",
      zCol: "z", ezCol: null, czConvert: false,
      typeLabel: (r) => r.types || "",
      filter:    (r) => { const f = parseFloat(r.Flag); return f === 3 || f === 4; },
      qualLabel: (r) => `Flag=${r.Flag}`,
      color: "#b0bec5", size: 12,
    },
  ];

  // Parse a VizieR VOTable XML response into an array of {col: value} rows.
  // Columns are keyed by FIELD @name and values are TD textContent — VizieR
  // returns everything stringified, so callers do their own parseFloat.
  function parseVOTable(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const names = [...doc.querySelectorAll("FIELD")].map((f) => f.getAttribute("name"));
    return [...doc.querySelectorAll("TR")].map((tr) => {
      const vals = [...tr.querySelectorAll("TD")].map((td) => td.textContent.trim());
      return Object.fromEntries(names.map((n, i) => [n, vals[i] ?? ""]));
    });
  }

  async function loadCatalog(aladin, cfg, ra, dec, onLoad) {
    if (typeof window.A === "undefined") return;
    const sources = [];

    for (const table of cfg.tables) {
      try {
        const url = `https://vizier.cds.unistra.fr/viz-bin/conesearch/${table}`
          + `?RA=${ra}&DEC=${dec}&SR=${RADIUS_DEG}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!resp.ok) continue;
        const rows = parseVOTable(await resp.text());

        for (const r of rows) {
          try { if (!cfg.filter(r)) continue; } catch { continue; }

          const raS  = parseFloat(r[cfg.raCol]);
          const decS = parseFloat(r[cfg.decCol]);
          if (isNaN(raS) || isNaN(decS)) continue;

          const rawZ = parseFloat(r[cfg.zCol]);
          if (isNaN(rawZ)) continue;
          const z = cfg.czConvert ? rawZ / C : rawZ;

          const rawEz = cfg.ezCol ? parseFloat(r[cfg.ezCol]) : NaN;
          const ez = cfg.czConvert && !isNaN(rawEz) ? rawEz / C : rawEz;

          let typeStr = ""; try { typeStr = cfg.typeLabel(r) || ""; } catch {}
          let qualStr = ""; try { qualStr = cfg.qualLabel(r) || ""; } catch {}

          const data = {
            name:   `${cfg.name}: z = ${z.toFixed(4)}${typeStr ? " · " + typeStr : ""}`,
            z:      z.toFixed(5),
            Type:   typeStr || "?",
            Source: cfg.name,
          };
          if (!isNaN(ez)) data.z_err = ez.toFixed(5);
          if (qualStr)    data.Quality = qualStr;

          sources.push(window.A.source(raS, decS, data));
        }
      } catch (e) {
        console.warn(`${cfg.name} (${table}) failed:`, e.message);
      }
    }

    if (sources.length === 0) return;
    const cat = window.A.catalog({
      name: `${cfg.name} (${sources.length})`,
      sourceSize: cfg.size,
      color: cfg.color,
      shape: "circle",
      onClick: "showPopup",
    });
    aladin.addCatalog(cat);
    cat.addSources(sources);
    console.log(`${cfg.name}: ${sources.length} spec-z source(s)`);
    if (onLoad) onLoad({ name: cfg.name, color: cfg.color, count: sources.length });
  }

  // Public entry point. aladin.js calls this after the main-object marker
  // is added; each catalog fires independently and `onLoad` is invoked when
  // a catalog finishes with at least one source (used for the legend chips).
  // Returns a Promise that resolves once every catalog has settled (resolved
  // or rejected) so callers that need to chain follow-on work can `await` it.
  // The current aladin.js does NOT await — it fires the LSST-neighbours
  // overlay in parallel so a slow VizieR endpoint can't delay the gray
  // squares the user came here to see.
  window.loadSpecZOverlays = function (aladin, ra, dec, onLoad) {
    return Promise.allSettled(
      SPEC_Z_CATALOGS.map((cfg) => loadCatalog(aladin, cfg, ra, dec, onLoad)),
    );
  };

  // Test-only surface: the pure VOTable parser (DOMParser-based, no network).
  window.__speczTest = { parseVOTable };
})();
