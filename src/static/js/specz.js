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

    // Group the flat source list by catalog so each becomes one Aladin layer.
    const groups = new Map();
    for (const s of overlay) {
      if (!groups.has(s.cat_id)) groups.set(s.cat_id, []);
      groups.get(s.cat_id).push(s);
    }

    for (const items of groups.values()) {
      const first = items[0];
      const sources = [];
      for (const s of items) {
        if (s.ra == null || s.dec == null || s.z == null) continue;
        const zStr = fmt(s.z, 5);
        const data = {
          name: `${s.cat_name}: z = ${fmt(s.z, 4)}${s.type ? " · " + s.type : ""}`,
          z: zStr,
          Type: s.type || "?",
          Source: s.cat_name,
        };
        if (s.z_err != null) data.z_err = fmt(s.z_err, 5);
        if (s.sep != null) data.Separation = `${fmt(s.sep, 2)}″`;
        sources.push(window.A.source(s.ra, s.dec, data));
      }
      if (sources.length === 0) continue;

      const cat = window.A.catalog({
        name: `${first.cat_name} (${sources.length})`,
        sourceSize: first.size || 12,
        color: first.color || "#4fc3f7",
        shape: "circle",
        onClick: "showPopup",
      });
      aladin.addCatalog(cat);
      cat.addSources(sources);
      if (onLoad) onLoad({ name: first.cat_name, color: first.color, count: sources.length });
    }
  };
})();
