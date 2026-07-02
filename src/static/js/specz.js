/* Host-galaxy spec-z overlays for the Aladin panel.
 *
 * The spec-z catalog matches now come from the server-side bulk-crossmatch
 * cache (services/xmatch.py), warmed by the results-page prefetch, rather than
 * from per-object VizieR conesearches in the browser. We fetch one JSON blob
 * — `/api/xmatch_overlay?oid=…&survey_id=…` — group its sources by catalog,
 * and draw one Aladin catalog layer per group. Because the page-load prefetch
 * usually has the object warm, the overlay appears (near-)instantly.
 *
 * Each overlay source carries {cat_id, cat_name, ra, dec, z, z_err, type, sep,
 * color, size}; the colour/size come from the server registry so the markers
 * look like the old client-side overlay. Clicking a source still fires Aladin's
 * `objectClicked` (wired in aladin.js), which copies `obj.data.z` into the
 * per-oid `lc-redshift-{oid}` input.
 */
(function () {
  const REQUEST_TIMEOUT_MS = 20000;

  function fmt(v, digits) {
    const n = Number(v);
    return isNaN(n) ? null : n.toFixed(digits);
  }

  // Public entry point. aladin.js calls this after the main-object marker is
  // added, passing the object's oid + ALeRCE survey. `onLoad` is invoked once
  // per catalog that contributes at least one source (drives the legend chips).
  // Returns a Promise that resolves once the overlay has been drawn (or failed),
  // so callers can chain — though aladin.js fires it without awaiting so a slow
  // fetch can't delay the LSST-neighbours overlay.
  window.loadSpecZOverlays = async function (aladin, oid, survey, onLoad) {
    if (typeof window.A === "undefined") return;

    let overlay;
    try {
      const url = `${window.API_URL || ""}/api/xmatch_overlay`
        + `?oid=${encodeURIComponent(oid)}&survey_id=${encodeURIComponent(survey)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!resp.ok) return;
      overlay = (await resp.json()).overlay || [];
    } catch (e) {
      console.warn("spec-z overlay fetch failed:", e.message);
      return;
    }

    // Group sources by USE-CASE CATEGORY (not per catalog) so the sky shows one
    // layer per category, colour-coded with the shared schema (stars=light blue,
    // AGN=red, galaxies=dark green) and one grouped legend entry each — instead
    // of a chip per external catalog.
    const LABELS = { stellar: "Stars", agn: "AGN/QSO", host: "Galaxies" };
    // The host overlay is spec-z galaxies ONLY — the server drops any host
    // marker without a redshift (see xmatch.py overlay build), and the host
    // catalogs are spectroscopic-redshift surveys. Qualify the galaxy layer /
    // legend so the "Galaxies (specz, N)" label makes that explicit.
    const QUALIFIER = { host: "specz" };
    const ORDER = ["stellar", "agn", "host"];
    const groups = new Map();
    for (const s of overlay) {
      if (s.ra == null || s.dec == null) continue;
      const cat = s.category || "host";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(s);
    }

    for (const cat of ORDER) {
      const items = groups.get(cat);
      if (!items || !items.length) continue;
      const color = items[0].color || "#9ccc65";
      const sources = items.map((s) =>
        // Structured data feeds the Aladin info bar (aladin.js) on click, not a
        // popup. `z` is set only when present so click→redshift still works.
        window.A.source(s.ra, s.dec, {
          Source: s.cat_name,
          ID: s.name || "",
          label: s.label || "",
          z: s.z != null ? fmt(s.z, 5) : null,
          Type: s.type || null,
          Separation: s.sep != null ? `${fmt(s.sep, 2)}″` : null,
        }),
      );
      // One display name, shared by the Aladin layer control and the panel
      // legend chip. Fold any category qualifier + the count into a single
      // paren: "Galaxies (specz, 5)" for host, "Stars (3)" otherwise.
      const qual = QUALIFIER[cat];
      const name = qual
        ? `${LABELS[cat]} (${qual}, ${sources.length})`
        : `${LABELS[cat]} (${sources.length})`;
      const catalog = window.A.catalog({
        name,
        sourceSize: 12,
        color,
        shape: "circle",
        onClick: () => {},   // suppress Aladin's hard-to-close popup; the
                             // objectClicked handler fills the bottom info bar
      });
      aladin.addCatalog(catalog);
      catalog.addSources(sources);
      if (onLoad) onLoad({ label: name, color, count: sources.length });
    }
  };
})();
