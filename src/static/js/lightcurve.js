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

  // Canvas element → Chart instance, so we can destroy before re-initializing.
  const charts = new WeakMap();

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
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ds.data.forEach((p, i) => {
          if (!p || p.yLo == null || p.yHi == null) return;
          const el = meta.data[i];
          if (!el) return;
          const xPx = el.x;
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

  function buildDatasets(bands, fpBands, axisMode, sourceMode, distMod, extByBand) {
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
    return [...det, ...fp];
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
    chart.data.datasets = buildDatasets(
      raw.bands, raw.fpBands, axisMode, sourceMode, distMod, extByBand,
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
    const initialAxisMode = "flux";
    const initialSourceMode = "diff";

    // Per-band R_λ map comes from SurveyConfig.extinction_r via the template;
    // missing attribute falls back to an empty dict so chart still renders.
    let extR = {};
    try { extR = JSON.parse(canvas.dataset.extR || "{}"); } catch { /* noop */ }

    const chart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: { datasets: buildDatasets(bands, fpBands, initialAxisMode, initialSourceMode, null, null) },
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
            labels: { color: "#c9d1d9", boxWidth: 10 },
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
    chart.$lcAbs = "app";
    chart.$lcZ = null;
    chart.$lcDered = "obs";
    chart.$lcEbv = null;
    chart.$lcExtR = extR;
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom());
    charts.set(canvas, chart);

    // Seed redshift from the matching z input if it already has a value
    // (e.g. the user typed one before we initialized, or an htmx swap).
    const zInput = document.querySelector(`.lc-redshift-input[data-target="${canvas.id}"]`);
    if (zInput) syncRedshiftFromInput(chart, zInput, false);
    const ebvInput = document.querySelector(`.lc-ebv-input[data-target="${canvas.id}"]`);
    if (ebvInput) syncEbvFromInput(chart, ebvInput, false);

    // Kick off the Milky-Way E(B-V) fetch if we have coords and the input
    // is still empty (don't clobber a user-entered override). The proxy
    // caches by (ra,dec) rounded to 0.01° so repeat calls are cheap.
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
    setCycleValue(btn, spec, btn.dataset[spec.dataKey]);
    btn.addEventListener("click", () => {
      const canvas = document.getElementById(btn.dataset.target);
      const chart = canvas && charts.get(canvas);
      if (!chart) return;
      const current = btn.dataset[spec.dataKey];
      const idx = spec.values.indexOf(current);
      const next = spec.values[(idx + 1) % spec.values.length];
      if (spec.guard && !spec.guard(chart, next)) return;
      chart[spec.chartProp] = next;
      setCycleValue(btn, spec, next);
      // New projection → new Y-axis range; the prior zoom window would
      // usually land on empty space, so reset to auto-fit first.
      if (chart.resetZoom) chart.resetZoom("none");
      applyModes(chart);
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
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
  }

  function initToggles(root) {
    const scope = root || document;
    for (const spec of Object.values(TOGGLE_SPECS)) {
      scope.querySelectorAll(spec.btnSelector).forEach((b) => bindCycleButton(b, spec));
    }
    scope.querySelectorAll(".lc-redshift-input").forEach(bindRedshiftInput);
    scope.querySelectorAll(".lc-ebv-input").forEach(bindEbvInput);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.lightcurve-canvas").forEach(initCanvas);
    initToggles(root);
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
