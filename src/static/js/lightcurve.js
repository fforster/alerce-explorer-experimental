/* Light-curve rendering via Chart.js (UMD, vendored).
 *
 * Contract: each <canvas class="lightcurve-canvas" data-lc='...JSON...'> is
 * initialized once on DOMContentLoaded, and again every time htmx swaps new
 * content in (htmx:afterSwap). Re-init destroys any prior chart on the same
 * canvas so detail-view swaps don't leak a chart instance.
 *
 * Two independent toggles control the projection, both handled client-side:
 *   - Diff/Sci: pick difference flux vs science (absolute) flux per point.
 *     Points without sci flux drop out of sci mode.
 *   - Flux/Mag: keep nJy or convert with AB ZP 31.4 (same constant as
 *     normalize.py). Points with flux ≤ 0 drop out of mag mode; Y axis is
 *     reversed in mag mode so brighter sits higher.
 */
(function () {
  const BAND_COLORS = {
    u: "#56B4E9",
    g: "#009E73",
    r: "#D55E00",
    i: "#E69F00",
    z: "#CC79A7",
    y: "#0072B2",
    unknown: "#888888",
  };

  const AB_ZP_NJY = 31.4;
  const LN10_OVER_2P5 = Math.log(10) / 2.5;

  // Append an alpha byte to a #RRGGBB color so DR can reuse the band palette
  // while reading as clearly subordinate to det/FP. Non-hex colors pass through.
  function withAlpha(color, alpha) {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return color;
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
    return color + a;
  }

  // Canvas element → Chart instance, so we can destroy before re-initializing.
  const charts = new WeakMap();

  // Persist LC panel configuration across object navigation. The browser URL
  // is the canonical form (share-link, reload), but the URL gets rewritten by
  // the server's HX-Push-Url on every detail swap — dropping lc_* params —
  // so we also keep an in-memory cache that survives the round trip. initCanvas
  // reads the cache first (fast, always fresh), then falls back to the URL.
  //
  // Only non-default values end up in the URL, matching the "dropped if
  // default" convention in routes/htmx.py::_share_url.
  const LC_DEFAULTS = {
    mode: "flux", source: "diff", abs: "app", dered: "obs",
    z: null, ebv: null, drShown: false, drAlpha: 0.10,
  };

  function readLcStateFromUrl() {
    const p = new URLSearchParams(window.location.search);
    const num = (k) => {
      const v = parseFloat(p.get(k));
      return isFinite(v) ? v : null;
    };
    return {
      mode:  p.get("lc_mode")   || LC_DEFAULTS.mode,
      source: p.get("lc_source") || LC_DEFAULTS.source,
      abs:   p.get("lc_abs")    || LC_DEFAULTS.abs,
      dered: p.get("lc_dered")  || LC_DEFAULTS.dered,
      z:     num("lc_z"),
      ebv:   num("lc_ebv"),
      drShown: p.get("lc_dr") === "on",
      drAlpha: num("lc_dr_alpha") ?? LC_DEFAULTS.drAlpha,
    };
  }

  // Seize the deep-link lc_* params synchronously on script load — the very
  // first detail swap sends back an HX-Push-Url that wipes them from the
  // address bar BEFORE initCanvas runs, so reading the URL later yields only
  // defaults. Stashed into the cache so restoredLcState picks it up.
  (function seedFromInitialUrl() {
    if (window._lcState) return;
    const state = readLcStateFromUrl();
    const isDefault =
      state.mode === LC_DEFAULTS.mode &&
      state.source === LC_DEFAULTS.source &&
      state.abs === LC_DEFAULTS.abs &&
      state.dered === LC_DEFAULTS.dered &&
      state.z == null && state.ebv == null &&
      !state.drShown &&
      Math.abs(state.drAlpha - LC_DEFAULTS.drAlpha) < 1e-6;
    if (!isDefault) window._lcState = state;
  })();

  function restoredLcState() {
    // Cache wins: it was written by the previous chart's state changes and
    // outlives HX-Push-Url wiping lc_* params from the address bar.
    return window._lcState || readLcStateFromUrl();
  }

  function cacheAndPushLcState(chart) {
    const state = {
      mode: chart.$lcMode,
      source: chart.$lcSource,
      abs: chart.$lcAbs,
      dered: chart.$lcDered,
      z: chart.$lcZ,
      ebv: chart.$lcEbv,
      drShown: chart.$lcDrShown,
      drAlpha: chart.$lcDrAlpha,
    };
    window._lcState = state;
    const url = new URL(window.location.href);
    const setOrDel = (key, val, def) => {
      if (val == null || val === "" || val === def) url.searchParams.delete(key);
      else url.searchParams.set(key, String(val));
    };
    setOrDel("lc_mode",   state.mode,   LC_DEFAULTS.mode);
    setOrDel("lc_source", state.source, LC_DEFAULTS.source);
    setOrDel("lc_abs",    state.abs,    LC_DEFAULTS.abs);
    setOrDel("lc_dered",  state.dered,  LC_DEFAULTS.dered);
    setOrDel("lc_z",      state.z,      null);
    setOrDel("lc_ebv",    state.ebv,    null);
    setOrDel("lc_dr", state.drShown ? "on" : "off", "off");
    // Default alpha compared with a small epsilon so 0.10 from the URL
    // round-trips to "absent" instead of "0.1".
    const alphaIsDefault = Math.abs((state.drAlpha ?? LC_DEFAULTS.drAlpha) - LC_DEFAULTS.drAlpha) < 1e-6;
    setOrDel("lc_dr_alpha", alphaIsDefault ? null : state.drAlpha, null);
    // replaceState (not pushState) so the back button still walks results →
    // detail and isn't polluted with an entry per toggle click.
    window.history.replaceState(window.history.state, "", url.toString());
  }

  // Error bars drawn as a post-render overlay. projectPoint emits yLo/yHi
  // in the active Y-axis units; in mag mode these come from the symmetric
  // flux error and are therefore asymmetric, with yHi = +∞ when the faint
  // side would need log of a non-positive number. In that case we drop
  // the end cap and let the bar reach the chart edge (visually: "arrow").
  const errorBarPlugin = {
    id: "lcErrorBars",
    afterDatasetsDraw(chart) {
      const { ctx, scales: { y }, chartArea } = chart;
      const reversed = y.options.reverse === true;
      chart.data.datasets.forEach((ds, di) => {
        if (!chart.isDatasetVisible(di)) return;
        const meta = chart.getDatasetMeta(di);
        const color = ds.borderColor || ds.backgroundColor || "#888";
        ctx.save();
        // Clip to the plot area so zoomed-in points whose error caps would
        // otherwise paint over the Y-axis labels and chart padding stay
        // inside the axes. Chart.js draws the point marker itself with its
        // own per-dataset clipping, but our overlay bypasses that.
        ctx.beginPath();
        ctx.rect(
          chartArea.left, chartArea.top,
          chartArea.right - chartArea.left,
          chartArea.bottom - chartArea.top,
        );
        ctx.clip();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ds.data.forEach((p, i) => {
          if (!p || p.yLo == null || p.yHi == null) return;
          const el = meta.data[i];
          if (!el) return;
          const xPx = el.x;
          // Skip points whose x is fully outside the plot — the clip above
          // would hide them anyway, but this spares a few arithmetic ops
          // and keeps the caps from drawing ghost pixels near the edges.
          if (xPx < chartArea.left - 1 || xPx > chartArea.right + 1) return;
          const loOpen = !isFinite(p.yLo);
          const hiOpen = !isFinite(p.yHi);
          // Open ends map to the plot edge in the direction of the infinity
          // (mag axis is reversed, so +∞ sits at the bottom edge).
          const pxLo = loOpen ? (reversed ? chartArea.top : chartArea.bottom)
                              : y.getPixelForValue(p.yLo);
          const pxHi = hiOpen ? (reversed ? chartArea.bottom : chartArea.top)
                              : y.getPixelForValue(p.yHi);
          const top = Math.min(pxLo, pxHi);
          const bot = Math.max(pxLo, pxHi);
          const topOpen = (top === pxLo && loOpen) || (top === pxHi && hiOpen);
          const botOpen = (bot === pxLo && loOpen) || (bot === pxHi && hiOpen);
          const cap = 3;
          ctx.beginPath();
          ctx.moveTo(xPx, Math.max(chartArea.top, top));
          ctx.lineTo(xPx, Math.min(chartArea.bottom, bot));
          if (!topOpen) { ctx.moveTo(xPx - cap, top); ctx.lineTo(xPx + cap, top); }
          if (!botOpen) { ctx.moveTo(xPx - cap, bot); ctx.lineTo(xPx + cap, bot); }
          ctx.stroke();
        });
        ctx.restore();
      });
    },
  };

  // Projection corrections composed in a fixed order:
  //   1. Milky-Way extinction per band (A_λ = R_λ · E(B-V)), applied BEFORE
  //      the distance modulus so absolute values are also dust-free.
  //      extMag comes in already multiplied by E(B-V); 0 means "don't apply".
  //   2. Distance modulus (Abs mode with z > 0). null means apparent.
  // In mag-space both are additive shifts (M = m − A − μ); in flux-space
  // they compose multiplicatively (10^(0.4·A) then 10^(0.4·μ)).
  //
  // Error bars are returned as (yLo, yHi) so the caller can draw them
  // without knowing the projection. In flux-space this is just y ± e
  // (symmetric). In mag-space it is asymmetric: upper/lower bounds are
  // computed from the symmetric flux error (flux ± eFlux) and then
  // converted — the faint side may go to +∞ when (flux − eFlux) ≤ 0,
  // which the renderer draws as an arrow reaching the chart edge.
  function projectPoint(p, axisMode, sourceMode, distMod, extMag) {
    const flux = sourceMode === "sci" ? p.sci_flux : p.flux;
    const eFlux = sourceMode === "sci" ? p.e_sci_flux : p.e_flux;
    if (flux == null) return null;
    const A = extMag || 0;
    const mu = distMod || 0;
    if (axisMode === "mag") {
      if (flux <= 0) return null;
      const mag = AB_ZP_NJY - 2.5 * Math.log10(flux) - A - mu;
      // Representative ± for the tooltip (small-error approximation).
      const e = eFlux != null && eFlux > 0 ? eFlux / flux / LN10_OVER_2P5 : null;
      let yLo = null, yHi = null;
      if (eFlux != null && eFlux > 0) {
        // Bright side: flux + e → smaller mag (finite as long as flux>0).
        yLo = AB_ZP_NJY - 2.5 * Math.log10(flux + eFlux) - A - mu;
        // Faint side: flux − e → larger mag, +∞ when non-positive.
        const fluxLo = flux - eFlux;
        yHi = fluxLo > 0
          ? AB_ZP_NJY - 2.5 * Math.log10(fluxLo) - A - mu
          : Infinity;
      }
      return { x: p.mjd, y: mag, e, yLo, yHi, identifier: p.identifier, has_stamp: p.has_stamp };
    }
    let y = flux;
    let e = eFlux;
    if (A !== 0) {
      const scaleA = Math.pow(10, 0.4 * A);
      y *= scaleA;
      if (e != null) e *= scaleA;
    }
    if (distMod != null) {
      const scaleD = Math.pow(10, 0.4 * distMod);
      y *= scaleD;
      if (e != null) e *= scaleD;
    }
    const yLo = e != null ? y - e : null;
    const yHi = e != null ? y + e : null;
    return { x: p.mjd, y, e, yLo, yHi, identifier: p.identifier, has_stamp: p.has_stamp };
  }

  function buildDatasets(bands, fpBands, drBands, axisMode, sourceMode, distMod, extByBand, drAlpha) {
    const extFor = (name) => (extByBand || {})[name] || 0;
    const project = (band) =>
      band.points
        .map((p) => projectPoint(p, axisMode, sourceMode, distMod, extFor(band.name)))
        .filter(Boolean);
    const det = bands.map((b) => ({
      label: b.name,
      data: project(b),
      backgroundColor: BAND_COLORS[b.name] || BAND_COLORS.unknown,
      borderColor: BAND_COLORS[b.name] || BAND_COLORS.unknown,
      showLine: false,
      pointRadius: 3,
      pointHoverRadius: 5,
    }));
    // FP uses the same band colors but rendered as hollow triangles so they
    // read as distinct from detections without crowding the legend/tooltip.
    // FP rows don't carry a stamp identifier, so clicks on them are no-ops.
    const fp = (fpBands || []).map((b) => ({
      label: `${b.name} (FP)`,
      data: project(b),
      backgroundColor: "transparent",
      borderColor: BAND_COLORS[b.name] || BAND_COLORS.unknown,
      borderWidth: 1,
      pointStyle: "triangle",
      showLine: false,
      pointRadius: 3,
      pointHoverRadius: 5,
    }));
    // DR points are archival science-only photometry; carry no flux (diff),
    // so projectPoint filters them out in Diff mode automatically. Rendered
    // as tiny 10%-alpha circles in the band color, and with a negative
    // draw-order so det + FP always sit on top of a dense DR crossmatch.
    const alpha = (typeof drAlpha === "number" && isFinite(drAlpha)) ? drAlpha : 0.10;
    const dr = (drBands || []).map((b) => {
      const base = BAND_COLORS[b.name] || BAND_COLORS.unknown;
      return {
        label: `${b.name} (DR)`,
        data: project(b),
        backgroundColor: withAlpha(base, alpha),
        borderColor: withAlpha(base, alpha),
        borderWidth: 1,
        pointStyle: "circle",
        showLine: false,
        pointRadius: 1.5,
        pointHoverRadius: 3,
        // Chart.js sorts datasets ascending by `order`; lower = drawn first
        // = back layer. Det/FP stay at default 0 so any DR points under them
        // get occluded rather than blotting out a real detection.
        order: -1,
      };
    });
    // Legend order: det → FP → DR. DR sits last so the archival overlay is
    // visually subordinate to the alert-driven series above it. Drawing
    // order is decoupled via the `order: -1` on DR datasets so the legend
    // position doesn't bring DR to the front visually.
    return [...det, ...fp, ...dr];
  }

  // Distance modulus only applied when Abs mode is armed AND z is valid AND
  // the cosmology module is loaded; any missing piece → apparent projection.
  function computeDistMod(chart) {
    if (chart.$lcAbs !== "abs") return null;
    const z = chart.$lcZ;
    if (!(z > 0)) return null;
    if (typeof window.cosmology === "undefined") return null;
    const mu = window.cosmology.distanceModulus(z);
    return isFinite(mu) ? mu : null;
  }

  // Per-band A_λ = R_λ · E(B-V) when Der mode is armed with a positive
  // E(B-V); empty object → no correction. Bands missing from R_λ (e.g.
  // "unknown") silently contribute 0, matching the survey-config contract.
  function computeExtByBand(chart) {
    if (chart.$lcDered !== "dered") return {};
    const ebv = chart.$lcEbv;
    if (!(ebv > 0)) return {};
    const R = chart.$lcExtR || {};
    const out = {};
    for (const [band, r] of Object.entries(R)) out[band] = r * ebv;
    return out;
  }

  function applyModes(chart) {
    const raw = chart.$lcRaw;
    if (!raw) return;
    const axisMode = chart.$lcMode;
    const sourceMode = chart.$lcSource;
    const distMod = computeDistMod(chart);
    const extByBand = computeExtByBand(chart);
    const dered = Object.keys(extByBand).length > 0;
    // Only surface DR bands when the user has toggled them on; projectPoint
    // still filters DR in Diff mode (flux=null), so this just avoids stale
    // legend entries when the feature is off.
    const drBands = chart.$lcDrShown ? (chart.$lcDrBands || []) : [];
    chart.data.datasets = buildDatasets(
      raw.bands, raw.fpBands, drBands, axisMode, sourceMode, distMod, extByBand,
      chart.$lcDrAlpha,
    );
    const y = chart.options.scales.y;
    const sciLabel = sourceMode === "sci" ? "science" : "diff";
    const absPrefix = distMod != null ? "Abs " : "";
    const deredSuffix = dered ? ", dered" : "";
    if (axisMode === "mag") {
      y.title.text = `${absPrefix}Magnitude (AB, ${sciLabel}${deredSuffix})`;
      y.reverse = true;
    } else {
      const at10pc = distMod != null ? " @ 10 pc" : "";
      y.title.text = `${absPrefix}Flux (nJy${at10pc}, ${sciLabel}${deredSuffix})`;
      y.reverse = false;
    }
    chart.update();
  }

  function initCanvas(canvas) {
    const payload = canvas.dataset.lc;
    if (!payload) return;
    let data;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      console.warn("lightcurve: bad JSON payload", e);
      return;
    }
    if (typeof Chart === "undefined") {
      console.warn("lightcurve: Chart.js not loaded yet");
      return;
    }

    const prior = charts.get(canvas);
    if (prior) prior.destroy();

    const bands = data.bands || [];
    const fpBands = data.forced_phot_bands || [];
    const hasScienceFlux = !!data.has_science_flux;
    // Apply whatever state the previous object left behind (cache first,
    // then URL). Surveys without science flux can't honor lc_source=sci —
    // the Diff/Sci button isn't even rendered — so pin to Diff regardless.
    const restored = restoredLcState();
    const initialAxisMode = restored.mode === "mag" ? "mag" : "flux";
    const initialSourceMode =
      hasScienceFlux && restored.source === "sci" ? "sci" : "diff";

    // Per-band R_λ map comes from SurveyConfig.extinction_r via the template;
    // missing attribute falls back to an empty dict so chart still renders.
    let extR = {};
    try { extR = JSON.parse(canvas.dataset.extR || "{}"); } catch { /* noop */ }

    const chart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: { datasets: buildDatasets(bands, fpBands, [], initialAxisMode, initialSourceMode, null, null) },
      plugins: [errorBarPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Toggles re-project every point (flux↔mag, app↔abs, obs↔der); the
        // tween between old and new positions muddles the comparison, so
        // skip it entirely and let each state snap in.
        animation: false,
        animations: { colors: false, numbers: false },
        transitions: { active: { animation: { duration: 0 } } },
        // Left-click stays available for stamp sync; drag-zoom requires shift
        // so it doesn't swallow clicks, and pan uses ctrl to keep the two
        // interactions distinct. Double-click resets the zoom (wired below).
        onClick: (_evt, elements) => {
          if (!elements.length) return;
          const { datasetIndex, index } = elements[0];
          const p = chart.data.datasets[datasetIndex].data[index];
          if (p?.has_stamp && p.identifier && window.setSelectedIdentifier) {
            window.setSelectedIdentifier(p.identifier);
          }
        },
        onHover: (evt, elements) => {
          const target = evt.native?.target;
          if (!target) return;
          const clickable = elements.some((el) => {
            const p = chart.data.datasets[el.datasetIndex].data[el.index];
            return p?.has_stamp && p.identifier;
          });
          target.style.cursor = clickable ? "pointer" : "default";
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "MJD", color: "#8b949e" },
            grid: { drawOnChartArea: false, drawTicks: true, tickColor: "#8b949e" },
            border: { display: true, color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
          y: {
            title: { display: true, text: "Flux (nJy, diff)", color: "#8b949e" },
            grid: { drawOnChartArea: false, drawTicks: true, tickColor: "#8b949e" },
            border: { display: true, color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
        },
        plugins: {
          legend: {
            position: "top",
            // usePointStyle mirrors each dataset's actual marker into the
            // legend — without it, Chart.js draws a generic filled rectangle
            // and FP triangles / DR open circles would read as "square" in
            // the legend despite being triangles/circles on the plot.
            // sort by datasetIndex so the negative `order` we use to push DR
            // to the back layer doesn't also shuffle it to the front of the
            // legend; the legend stays in array order (det → DR → FP).
            labels: {
              color: "#c9d1d9",
              usePointStyle: true,
              boxWidth: 10,
              sort: (a, b) => a.datasetIndex - b.datasetIndex,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const p = ctx.raw;
                const err = p.e != null ? ` ± ${p.e.toPrecision(3)}` : "";
                const unit = chart.$lcMode === "mag" ? "mag" : "nJy";
                return `${ctx.dataset.label}: ${p.y.toPrecision(4)}${err} ${unit} @ MJD ${p.x.toFixed(3)}`;
              },
            },
          },
          zoom: {
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              drag: { enabled: true, modifierKey: "shift" },
              mode: "xy",
            },
            pan: { enabled: true, mode: "xy", modifierKey: "ctrl" },
          },
        },
      },
    });
    chart.$lcRaw = { bands, fpBands };
    chart.$lcMode = initialAxisMode;
    chart.$lcSource = initialSourceMode;
    chart.$lcAbs = restored.abs === "abs" ? "abs" : "app";
    chart.$lcZ = null;  // set below from input after pre-fill
    chart.$lcDered = restored.dered === "dered" ? "dered" : "obs";
    chart.$lcEbv = null;  // set below from input after pre-fill
    chart.$lcExtR = extR;
    // DR starts hidden + unfetched. The button loads on first click (or at
    // bind-time pre-fetch) and caches the result on the chart so re-toggling
    // doesn't refetch. drAlpha comes from restored state so the DR layer
    // appears with the same transparency the user left it at.
    chart.$lcDrBands = [];
    chart.$lcDrShown = false;
    chart.$lcDrLoaded = false;
    chart.$lcDrAlpha = restored.drAlpha ?? LC_DEFAULTS.drAlpha;
    // Stash the restored-DR-intent so bindDrButton can flip it on after the
    // async fetch lands. We don't flip it here because the fetch hasn't run.
    chart.$lcDrRestoreShow = !!restored.drShown;
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom());
    charts.set(canvas, chart);

    // Pre-fill z / E(B-V) inputs from restored state BEFORE syncRedshift/EBV
    // run — otherwise the guards in those syncs would see empty inputs and
    // demote Abs→App / Der→Obs. An empty user-typed value takes precedence
    // over restored state (don't clobber a user's in-progress edit).
    const zInput = document.querySelector(`.lc-redshift-input[data-target="${canvas.id}"]`);
    if (zInput && !zInput.value && restored.z != null && restored.z > 0) {
      zInput.value = String(restored.z);
    }
    if (zInput) syncRedshiftFromInput(chart, zInput, false);
    const ebvInput = document.querySelector(`.lc-ebv-input[data-target="${canvas.id}"]`);
    if (ebvInput && !ebvInput.value && restored.ebv != null && restored.ebv > 0) {
      ebvInput.value = String(restored.ebv);
    }
    if (ebvInput) syncEbvFromInput(chart, ebvInput, false);

    // Apply the restored configuration to the chart (axis labels, dataset
    // projection, legend), then push the URL so the address bar reflects
    // the live state even after HX-Push-Url wiped lc_* on the swap.
    applyModes(chart);
    cacheAndPushLcState(chart);

    // Kick off the Milky-Way E(B-V) fetch if we have coords and the input
    // is still empty (don't clobber a user-entered override OR a restored
    // one). The proxy caches by (ra,dec) rounded to 0.01° so repeat calls
    // are cheap.
    const ra = parseFloat(canvas.dataset.ra);
    const dec = parseFloat(canvas.dataset.dec);
    if (isFinite(ra) && isFinite(dec) && window.dust && ebvInput && !ebvInput.value) {
      window.dust.fetchEBV(ra, dec).then((res) => {
        if (!res || !(res.ebv > 0)) return;
        if (ebvInput.value) return;  // user typed in while we were fetching
        ebvInput.value = res.ebv.toFixed(4);
        ebvInput.title = `SF11=${(res.ebv_sf11 ?? NaN).toFixed(4)} · SFD98=${(res.ebv_sfd98 ?? NaN).toFixed(4)}`;
        syncEbvFromInput(chart, ebvInput, true);
      });
    }
  }

  // Cycle buttons carry only the active value in their text + data attribute.
  // Click advances to the next value in `spec.values`; a guard can block the
  // advance (e.g. Abs requires z > 0) in which case the button stays put.
  function setCycleValue(btn, spec, value) {
    btn.dataset[spec.dataKey] = value;
    btn.textContent = spec.labels[value];
  }

  function bindCycleButton(btn, spec) {
    if (btn.$bound) return;
    btn.$bound = true;
    // Seed the button from the chart's actual state. initCanvas has already
    // applied restored (URL / cached) state to the chart, so this keeps the
    // button label in sync even when it diverges from the template's
    // hard-coded data-lc-* default.
    const canvas = document.getElementById(btn.dataset.target);
    const chart = canvas && charts.get(canvas);
    const initial = (chart && chart[spec.chartProp]) || btn.dataset[spec.dataKey];
    setCycleValue(btn, spec, initial);
    btn.addEventListener("click", () => {
      const cv = document.getElementById(btn.dataset.target);
      const c = cv && charts.get(cv);
      if (!c) return;
      const current = btn.dataset[spec.dataKey];
      const idx = spec.values.indexOf(current);
      const next = spec.values[(idx + 1) % spec.values.length];
      if (spec.guard && !spec.guard(c, next)) return;
      c[spec.chartProp] = next;
      setCycleValue(btn, spec, next);
      // New projection → new Y-axis range; the prior zoom window would
      // usually land on empty space, so reset to auto-fit first.
      if (c.resetZoom) c.resetZoom("none");
      applyModes(c);
      cacheAndPushLcState(c);
    });
  }

  const TOGGLE_SPECS = {
    mode:   { btnSelector: ".lc-mode-toggle",   dataKey: "lcMode",   chartProp: "$lcMode",
              values: ["flux", "mag"], labels: { flux: "Flux", mag: "Mag" } },
    source: { btnSelector: ".lc-source-toggle", dataKey: "lcSource", chartProp: "$lcSource",
              values: ["diff", "sci"], labels: { diff: "Diff", sci: "Sci" } },
    abs:    { btnSelector: ".lc-abs-toggle",    dataKey: "lcAbs",    chartProp: "$lcAbs",
              values: ["app", "abs"], labels: { app: "App", abs: "Abs" },
              guard: (chart, v) => v !== "abs" || (chart.$lcZ != null && chart.$lcZ > 0) },
    dered:  { btnSelector: ".lc-dered-toggle",  dataKey: "lcDered",  chartProp: "$lcDered",
              values: ["obs", "dered"], labels: { obs: "Obs", dered: "Der" },
              guard: (chart, v) => v !== "dered" || (chart.$lcEbv != null && chart.$lcEbv > 0) },
  };

  // Keeps chart state aligned with the z input. If the user clears z while
  // the chart is in Abs mode, the projection has nothing to scale by — fall
  // back to App so the plot stays meaningful rather than silently reverting
  // to apparent values without updating the button or axis label.
  function syncRedshiftFromInput(chart, input, redraw) {
    const z = parseFloat(input.value);
    const valid = isFinite(z) && z > 0;
    chart.$lcZ = valid ? z : null;
    if (!valid && chart.$lcAbs === "abs") {
      chart.$lcAbs = "app";
      const btn = document.querySelector(`.lc-abs-toggle[data-target="${input.dataset.target}"]`);
      if (btn) setCycleValue(btn, TOGGLE_SPECS.abs, "app");
    }
    if (redraw) applyModes(chart);
  }

  function bindRedshiftInput(input) {
    if (input.$bound) return;
    input.$bound = true;
    const handler = () => {
      const canvas = document.getElementById(input.dataset.target);
      const chart = canvas && charts.get(canvas);
      if (!chart) return;
      syncRedshiftFromInput(chart, input, true);
      cacheAndPushLcState(chart);
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
  }

  // Mirror of syncRedshiftFromInput for E(B-V): parses, caches, and demotes
  // the chart from Der → Obs if the value goes invalid while dereddening.
  function syncEbvFromInput(chart, input, redraw) {
    const ebv = parseFloat(input.value);
    const valid = isFinite(ebv) && ebv > 0;
    chart.$lcEbv = valid ? ebv : null;
    if (!valid && chart.$lcDered === "dered") {
      chart.$lcDered = "obs";
      const btn = document.querySelector(`.lc-dered-toggle[data-target="${input.dataset.target}"]`);
      if (btn) setCycleValue(btn, TOGGLE_SPECS.dered, "obs");
    }
    if (redraw) applyModes(chart);
  }

  function bindEbvInput(input) {
    if (input.$bound) return;
    input.$bound = true;
    const handler = () => {
      const canvas = document.getElementById(input.dataset.target);
      const chart = canvas && charts.get(canvas);
      if (!chart) return;
      syncEbvFromInput(chart, input, true);
      cacheAndPushLcState(chart);
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
  }

  // ZTF DR button: lazy-load the archival cone-search on first click, toggle
  // dataset visibility on subsequent clicks. DR is ZTF-only and needs coords,
  // so the template omits the button when either is missing — we don't need
  // a client-side guard here.
  function setDrButtonState(btn, chart) {
    const shown = chart.$lcDrShown;
    btn.dataset.lcDr = shown ? "on" : "off";
    btn.classList.toggle("tw-text-text-primary", shown);
    btn.classList.toggle("tw-text-text-muted", !shown);
    // The alpha slider is only useful when DR is visible; hide it otherwise
    // so it doesn't eat toolbar real estate and can't be dragged into
    // setting a transparency that would then apply on the next toggle-on.
    const slider = document.querySelector(`.lc-dr-alpha[data-target="${btn.dataset.target}"]`);
    if (slider) slider.classList.toggle("tw-hidden", !shown);
  }

  // DR points carry no difference flux, so they're invisible in Diff mode.
  // Flipping DR on from Diff would render as "nothing happened" — force Sci
  // so the user sees the overlay immediately. Only applies to surveys that
  // publish a science flux (the Diff/Sci button is absent otherwise, in
  // which case DR still shows because everything is already projected as
  // science flux).
  function forceSourceSci(chart, target) {
    if (chart.$lcSource === "sci") return;
    chart.$lcSource = "sci";
    const srcBtn = document.querySelector(`.lc-source-toggle[data-target="${target}"]`);
    if (srcBtn) setCycleValue(srcBtn, TOGGLE_SPECS.source, "sci");
  }

  async function fetchDr(chart, ra, dec) {
    try {
      const url = `/api/ztf_dr?ra=${encodeURIComponent(ra)}&dec=${encodeURIComponent(dec)}&radius=1.5`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (!resp.ok) return false;
      const data = await resp.json();
      chart.$lcDrBands = Array.isArray(data.bands) ? data.bands : [];
      chart.$lcDrLoaded = true;
      return true;
    } catch (e) {
      console.warn("ztf_dr: fetch failed", e);
      return false;
    }
  }

  // Memoized fetch: the pre-fetch kicked off at bind time and the on-click
  // path share the same in-flight promise, so a user-click arriving while
  // the pre-fetch is still in flight doesn't double-fire the request.
  // Failures clear the promise so a subsequent click can retry.
  function ensureDrLoaded(chart, ra, dec) {
    if (chart.$lcDrLoaded) return Promise.resolve(true);
    if (!isFinite(ra) || !isFinite(dec)) return Promise.resolve(false);
    if (!chart.$lcDrPromise) {
      chart.$lcDrPromise = fetchDr(chart, ra, dec).then((ok) => {
        if (!ok) chart.$lcDrPromise = null;
        return ok;
      });
    }
    return chart.$lcDrPromise;
  }

  // Label the button with the cone-match count ("(0)" when empty) so the
  // user gets an early signal; disable it when empty so a click can't ask
  // applyModes to render an empty dataset.
  function markDrEmpty(btn) {
    btn.textContent = "ZTF DR (0)";
    btn.disabled = true;
  }

  function bindDrButton(btn) {
    if (btn.$bound) return;
    btn.$bound = true;
    const canvas = document.getElementById(btn.dataset.target);
    const chart = canvas && charts.get(canvas);
    const ra = parseFloat(btn.dataset.ra);
    const dec = parseFloat(btn.dataset.dec);

    // Background pre-fetch at bind time so clicking is instant on good
    // connections, and so an empty cone is visible in the button label
    // without requiring a click. Silent by design — no "…" flash.
    // If restored state wanted DR visible (user had it on for the previous
    // object), flip the toggle automatically once the fetch lands.
    if (chart) {
      ensureDrLoaded(chart, ra, dec).then((ok) => {
        if (!ok) return;
        if (!chart.$lcDrBands.length) { markDrEmpty(btn); return; }
        if (chart.$lcDrRestoreShow) {
          chart.$lcDrRestoreShow = false;
          chart.$lcDrShown = true;
          setDrButtonState(btn, chart);
          applyModes(chart);
          cacheAndPushLcState(chart);
        }
      });
    }

    btn.addEventListener("click", async () => {
      if (!chart) return;
      // Fast path: pre-fetch already landed. Toggle visibility and return.
      if (chart.$lcDrLoaded) {
        if (!chart.$lcDrBands.length) { markDrEmpty(btn); return; }
        chart.$lcDrShown = !chart.$lcDrShown;
        if (chart.$lcDrShown) forceSourceSci(chart, btn.dataset.target);
        setDrButtonState(btn, chart);
        applyModes(chart);
        cacheAndPushLcState(chart);
        return;
      }
      // Slow path: user beat the pre-fetch. Show a transient "…" indicator
      // while we wait on the shared promise, then fall through to the same
      // toggle logic.
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "…";
      const ok = await ensureDrLoaded(chart, ra, dec);
      btn.disabled = false;
      btn.textContent = originalText;
      if (!ok) return;
      if (!chart.$lcDrBands.length) { markDrEmpty(btn); return; }
      chart.$lcDrShown = !chart.$lcDrShown;
      if (chart.$lcDrShown) forceSourceSci(chart, btn.dataset.target);
      setDrButtonState(btn, chart);
      applyModes(chart);
      cacheAndPushLcState(chart);
    });
  }

  function bindDrAlphaSlider(input) {
    if (input.$bound) return;
    input.$bound = true;
    // Seed the slider from the chart's restored alpha so the handle starts
    // at whatever transparency the user had set on the previous object.
    const canvas = document.getElementById(input.dataset.target);
    const chart = canvas && charts.get(canvas);
    if (chart && isFinite(chart.$lcDrAlpha)) input.value = String(chart.$lcDrAlpha);
    const handler = () => {
      const cv = document.getElementById(input.dataset.target);
      const c = cv && charts.get(cv);
      if (!c) return;
      const alpha = parseFloat(input.value);
      if (!isFinite(alpha)) return;
      c.$lcDrAlpha = Math.max(0, Math.min(1, alpha));
      // Only re-render when DR is actually being shown — otherwise the value
      // is just cached for the next toggle-on.
      if (c.$lcDrShown) applyModes(c);
      cacheAndPushLcState(c);
    };
    input.addEventListener("input", handler);
  }

  function initToggles(root) {
    const scope = root || document;
    for (const spec of Object.values(TOGGLE_SPECS)) {
      scope.querySelectorAll(spec.btnSelector).forEach((b) => bindCycleButton(b, spec));
    }
    scope.querySelectorAll(".lc-redshift-input").forEach(bindRedshiftInput);
    scope.querySelectorAll(".lc-ebv-input").forEach(bindEbvInput);
    scope.querySelectorAll(".lc-dr-toggle").forEach(bindDrButton);
    scope.querySelectorAll(".lc-dr-alpha").forEach(bindDrAlphaSlider);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.lightcurve-canvas").forEach(initCanvas);
    initToggles(root);
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
