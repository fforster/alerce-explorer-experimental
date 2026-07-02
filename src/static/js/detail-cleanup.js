// Detail-view lifecycle cleanup — fixes the memory leak where every object you
// opened left its Chart.js charts (light curve, radar, periodogram, position
// residuals, airmass, colour evolution) and its Aladin instance alive in RAM.
//
// Why it leaks without this: each chart module stores its instance keyed on the
// *canvas element* (a per-module WeakMap, or `canvas._airmassChart`) and only
// destroys a "prior" chart when re-initialising the SAME canvas. But every
// object gets uniquely-IDed canvases (`lc-canvas-{oid}`, `radar-…-{oid}`, …),
// so navigating creates fresh canvases and the old charts are never destroyed.
// Chart.js keeps a strong reference to every live chart in its global registry
// (plus chartjs-plugin-zoom's Hammer listeners) until `.destroy()` is called —
// pinning the chart → its detached canvas → the whole detached detail subtree.
// Aladin instances additionally hold a WebGL context (browsers cap ~16 live)
// and tile buffers, and were never destroyed at all. Navigating objects grew
// the tab without bound until it slowed to a crawl / crashed and Aladin stopped
// booting ("too many WebGL contexts").
//
// The fix: before the detail subtree is swapped away, destroy every chart in it
// (generically, via `Chart.getChart(canvas)` — no need to reach into each
// module's private WeakMap) and every Aladin instance (`host.$aladin.destroy()`
// + a `torndown` flag so an in-flight async boot self-aborts, see aladin.js).
//
// Wiring — two entry points, because there are two swap mechanisms:
//   1. htmx:beforeSwap targeting #results-slot — covers opening a detail from
//      the table, prev/next object navigation, and the network-fallback Back
//      (all go through htmx.ajax / hx-get into #results-slot). At beforeSwap
//      time the OLD detail is still in the slot, so we can walk + destroy it.
//   2. window.teardownDetailView() — called from backToResults() BEFORE its
//      cache-restore path sets `#results-slot.innerHTML` directly (that path
//      bypasses htmx, so htmx:beforeSwap never fires for it).

(function () {
  function teardown(scope) {
    const root = scope || document.getElementById("results-slot");
    if (!root || !root.querySelectorAll) return;

    // Chart.js charts. Chart.getChart(canvas) returns the live instance bound to
    // that canvas (or undefined); .destroy() unregisters it from Chart's global
    // registry and tears down chartjs-plugin-zoom's Hammer listeners.
    if (window.Chart && typeof window.Chart.getChart === "function") {
      root.querySelectorAll("canvas").forEach((cv) => {
        const chart = window.Chart.getChart(cv);
        if (chart) { try { chart.destroy(); } catch (e) { /* already gone */ } }
        // airmass.js also keeps its own reference on the element.
        if (cv._airmassChart) cv._airmassChart = null;
      });
    }

    // Aladin instances. Flag the host first so an async boot still in flight
    // (aladin.js initHost awaiting the CDN / WebGL init) aborts instead of
    // attaching a fresh instance to this detached node.
    root.querySelectorAll(".aladin-host").forEach((host) => {
      host.dataset.torndown = "1";
      const a = host.$aladin;
      if (a) {
        try { if (typeof a.destroy === "function") a.destroy(); }
        catch (e) { /* build without destroy() */ }
        host.$aladin = null;
      }
      host.$stampFootprintLatest = null;
      host.$xmAllLayers = null;
    });

    // Stop Aladin's always-on fullscreen-watch poll — nothing left to watch,
    // and it pins the last view's node otherwise.
    if (typeof window.__aladinStopFullscreenWatch === "function") {
      try { window.__aladinStopFullscreenWatch(); } catch (e) { /* noop */ }
    }
  }

  // Destroy the current detail's heavy instances. Callers either let htmx swap
  // the DOM afterwards or (Back cache-restore) replace innerHTML themselves.
  window.teardownDetailView = teardown;

  // Safety net for every htmx-driven swap of #results-slot (open / nav / Back
  // network fallback). Old content is still present at beforeSwap time.
  document.body.addEventListener("htmx:beforeSwap", (evt) => {
    const t = evt.detail && evt.detail.target;
    if (t && t.id === "results-slot") teardown(t);
  });
})();
