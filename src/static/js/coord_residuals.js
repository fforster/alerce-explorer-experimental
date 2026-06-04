/* Detection coordinate-residuals scatter plot.
 *
 * Each point is a detection's (Δra·cos(dec), Δdec) offset from the mean
 * position, in arcseconds. Color encodes MJD via a 5-stop viridis
 * approximation so a time-ordered drift (asteroid masquerading as a
 * transient) reads as a rainbow track rather than a random cloud.
 *
 * Source-of-truth: the live light-curve chart's `$lcRaw` (primary survey)
 * and `$lcXRaw` (matched cross-survey counterpart) — *not* the static
 * server payload. That way the scatter inherits the LC legend's band/
 * survey visibility (hidden bands drop out of the scatter too) and
 * absorbs any bands that arrive after first paint (cross-survey, FP).
 * Re-renders on the `lc:visibilityChanged` event the LC fires whenever
 * the user toggles a legend entry. Marker shape mirrors the LC: LSST is
 * a filled circle, ZTF a filled square — so two telescopes' worth of
 * residuals stay distinguishable on the same scatter.
 */
(function () {
  const VIRIDIS_STOPS = [
    [0.0, [68, 1, 84]],      // #440154
    [0.25, [59, 82, 139]],   // #3b528b
    [0.5, [33, 144, 140]],   // #21908c
    [0.75, [93, 200, 99]],   // #5dc863
    [1.0, [253, 231, 37]],   // #fde725
  ];

  // Same per-survey marker mapping the LC uses (kept duplicated rather
  // than reaching into lightcurve.js to avoid load-order coupling — the
  // residuals panel can land before or after lightcurve.js initializes).
  const SURVEY_POINT_STYLE = { lsst: "circle", ztf: "rect" };
  function pointStyleFor(survey) {
    return SURVEY_POINT_STYLE[survey] || "circle";
  }

  const charts = new WeakMap();

  function viridisColor(t) {
    // Linear interpolation between the nearest two stops.
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < VIRIDIS_STOPS.length; i++) {
      const [t1, c1] = VIRIDIS_STOPS[i - 1];
      const [t2, c2] = VIRIDIS_STOPS[i];
      if (t <= t2) {
        const f = t2 === t1 ? 0 : (t - t1) / (t2 - t1);
        const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
        const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
        const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
        return `rgb(${r},${g},${b})`;
      }
    }
    return "rgb(253,231,37)";
  }

  // Mirror of the LC visibility lookup: a det dataset on the LC chart is
  // the user's switch for that (survey, band) being included here. FP /
  // DR / overlay aren't asked about — only det datasets carry positions.
  function lcDetVisible(lcChart, survey, bandName) {
    if (!lcChart || !lcChart.data) return true;
    const datasets = lcChart.data.datasets;
    for (let i = 0; i < datasets.length; i++) {
      const ds = datasets[i];
      if (ds.$kind === "det" && ds.$survey === survey && ds.label === bandName) {
        return lcChart.isDatasetVisible(i);
      }
    }
    // Not represented yet (e.g. cross-survey LC arrived before its
    // legend entry got registered) — include by default.
    return true;
  }

  // Walk the LC chart's primary + cross-survey det bands, pull every
  // (ra, dec, mjd, identifier, has_stamp, band, survey) row, and skip
  // bands the user has hidden in the LC legend. Returns null when there
  // aren't enough surviving points to compute a residual against the
  // mean (need ≥2). The mean is the unweighted ra/dec of every
  // surviving detection, with cos(mean_dec) folded into Δra so the
  // scatter shows a true on-sky offset.
  function rowsFromLc(lcChart) {
    const sources = [];
    const primary = lcChart.$lcSurvey || "";
    if (lcChart.$lcRaw && Array.isArray(lcChart.$lcRaw.bands)) {
      sources.push({ survey: primary, bands: lcChart.$lcRaw.bands });
    }
    if (lcChart.$lcXRaw && Array.isArray(lcChart.$lcXRaw.bands) && lcChart.$lcXRaw.survey) {
      sources.push({ survey: lcChart.$lcXRaw.survey, bands: lcChart.$lcXRaw.bands });
    }
    const rows = [];
    for (const src of sources) {
      for (const band of src.bands) {
        if (!lcDetVisible(lcChart, src.survey, band.name)) continue;
        for (const p of (band.points || [])) {
          if (p == null) continue;
          if (!isFinite(p.mjd)) continue;
          if (!isFinite(p.ra) || !isFinite(p.dec)) continue;
          rows.push({
            ra: p.ra, dec: p.dec, mjd: p.mjd,
            band: band.name, survey: src.survey,
            identifier: p.identifier,
            has_stamp: !!p.has_stamp,
          });
        }
      }
    }
    return rows;
  }

  function computeResiduals(rows) {
    if (rows.length < 2) return null;
    let raSum = 0, decSum = 0;
    for (const r of rows) { raSum += r.ra; decSum += r.dec; }
    const meanRa = raSum / rows.length;
    const meanDec = decSum / rows.length;
    const cosDec = Math.cos(meanDec * Math.PI / 180);
    let mjdMin = Infinity, mjdMax = -Infinity;
    for (const r of rows) {
      if (r.mjd < mjdMin) mjdMin = r.mjd;
      if (r.mjd > mjdMax) mjdMax = r.mjd;
    }
    const points = rows.map((r) => ({
      d_ra: (r.ra - meanRa) * cosDec * 3600.0,
      d_dec: (r.dec - meanDec) * 3600.0,
      mjd: r.mjd,
      band: r.band,
      survey: r.survey,
      identifier: r.identifier,
      has_stamp: r.has_stamp,
    }));
    return {
      points, mean_ra: meanRa, mean_dec: meanDec,
      mjd_min: mjdMin, mjd_max: mjdMax,
    };
  }

  // Per-survey grouping at chart-build time so each survey gets its own
  // dataset (own marker shape, own legend slot if we ever turn the
  // legend on). Tooltip prefixes the survey label so identical bands
  // across telescopes are unambiguous.
  function buildDatasets(ctx) {
    const groups = new Map();
    for (const p of ctx.points) {
      const s = p.survey || "";
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(p);
    }
    const span = ctx.mjd_max > ctx.mjd_min ? ctx.mjd_max - ctx.mjd_min : 1;
    const datasets = [];
    const order = ["lsst", "ztf", ...Array.from(groups.keys()).filter((s) => s !== "lsst" && s !== "ztf")];
    for (const s of order) {
      const pts = groups.get(s);
      if (!pts || !pts.length) continue;
      const data = pts.map((p) => ({
        x: p.d_ra, y: p.d_dec,
        mjd: p.mjd, band: p.band, survey: p.survey,
        identifier: p.identifier, has_stamp: p.has_stamp,
      }));
      const colors = pts.map((p) => viridisColor((p.mjd - ctx.mjd_min) / span));
      datasets.push({
        label: s || "detections",
        data,
        backgroundColor: colors,
        borderColor: colors,
        pointStyle: pointStyleFor(s),
        pointRadius: 4,
        pointHoverRadius: 6,
      });
    }
    return datasets;
  }

  // Resolve the LC chart this residuals canvas is paired with. The
  // panel template stamps `data-lc-target` on the wrapper; look it up
  // through window.lcGetChart so we don't depend on import order.
  function lcChartFor(canvas) {
    const panel = canvas.closest("[data-coord-panel]");
    const lcCanvasId = panel && panel.dataset.lcTarget;
    if (!lcCanvasId) return null;
    return window.lcGetChart ? window.lcGetChart(lcCanvasId) : null;
  }

  function setStatus(canvas, n, info) {
    const panel = canvas.closest("[data-coord-panel]");
    if (!panel) return;
    const count = panel.querySelector("[data-coord-count]");
    if (count) count.textContent = `${n} pt${n === 1 ? "" : "s"}`;
    const range = panel.querySelector("[data-coord-mjd-range]");
    if (range) {
      if (info && info.mjd_min != null && info.mjd_max != null) {
        const pretty = (v) => v.toFixed(2);
        range.innerHTML =
          `<span>MJD ${pretty(info.mjd_min)}</span>` +
          `<span>MJD ${pretty(info.mjd_max)}</span>`;
        range.classList.remove("tw-hidden");
      } else {
        range.classList.add("tw-hidden");
      }
    }
  }

  function renderInto(canvas, ctx) {
    if (typeof Chart === "undefined") return;
    const prior = charts.get(canvas);
    if (prior) prior.destroy();
    if (!ctx || !ctx.points.length) {
      setStatus(canvas, 0, null);
      // Clear the canvas so a previous chart doesn't linger after the
      // user toggles every band off.
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const absMax = Math.max(
      ...ctx.points.flatMap((p) => [Math.abs(p.d_ra), Math.abs(p.d_dec)]),
      0.5,
    );
    const axisMax = absMax * 1.15;
    const datasets = buildDatasets(ctx);

    const chart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (_evt, elements) => {
          if (!elements.length) return;
          const { datasetIndex, index } = elements[0];
          const p = chart.data.datasets[datasetIndex].data[index];
          if (p?.has_stamp && p.identifier && window.setSelectedIdentifier) {
            // Each point carries its survey from buildDatasets; pair it
            // with the matched OID off the LC chart so cross-survey
            // clicks dispatch to the right stamp service.
            const lcChart = lcChartFor(canvas);
            const primaryOid = lcChart && lcChart.canvas
              ? lcChart.canvas.id.replace(/^lc-canvas-/, "")
              : "";
            const useOid = (lcChart && p.survey && p.survey !== lcChart.$lcSurvey)
              ? (lcChart.$lcXOid || primaryOid)
              : primaryOid;
            window.setSelectedIdentifier(p.identifier, p.survey, useOid);
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
            min: -axisMax,
            max: axisMax,
            title: { display: true, text: "Δ RA·cos(δ) [arcsec]", color: "#a6a6a6" },
            grid: { display: false },
            border: { color: "#a6a6a6" },
            ticks: { color: "#a6a6a6" },
          },
          y: {
            type: "linear",
            min: -axisMax,
            max: axisMax,
            title: { display: true, text: "Δ Dec [arcsec]", color: "#a6a6a6" },
            grid: { display: false },
            border: { color: "#a6a6a6" },
            ticks: { color: "#a6a6a6" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = item.raw;
                const surveyTag = p.survey ? `${p.survey.toUpperCase()} ` : "";
                const band = p.band ? ` · ${p.band}` : "";
                return `${surveyTag}Δra ${p.x.toFixed(3)}", Δdec ${p.y.toFixed(3)}" · MJD ${p.mjd.toFixed(3)}${band}`;
              },
            },
          },
          zoom: {
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              // No click handler here, so drag-zoom works without a modifier.
              drag: { enabled: true },
              mode: "xy",
            },
            pan: { enabled: true, mode: "xy", modifierKey: "ctrl" },
          },
        },
      },
    });
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom(),
      { once: false });
    charts.set(canvas, chart);
    setStatus(canvas, ctx.points.length, ctx);
  }

  function rebuildFor(canvas) {
    const lcChart = lcChartFor(canvas);
    if (!lcChart) {
      // LC isn't on screen yet (deferred swap order). Try again on the
      // next visibilityChanged event; meanwhile, leave the canvas blank.
      renderInto(canvas, null);
      return;
    }
    const rows = rowsFromLc(lcChart);
    const ctx = computeResiduals(rows);
    renderInto(canvas, ctx);
  }

  function initCanvas(canvas) {
    if (canvas.$coordBound) return;
    canvas.$coordBound = true;
    rebuildFor(canvas);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.coord-residuals-canvas").forEach(initCanvas);
  }

  // Two events drive a re-derivation:
  //   1. lc:dataChanged — the LC's $lcRaw / $lcXRaw was just (re)populated
  //      (initial fetch, FP merge, cross-survey arrival). Bands may have
  //      been added or replaced wholesale.
  //   2. lc:visibilityChanged — a legend entry was toggled. Bands array
  //      is unchanged, but the visible subset shifted.
  // Both produce the same response: walk every coord-residuals canvas
  // currently in the DOM and recompute its scatter from the live LC.
  function rebuildAll() {
    document.querySelectorAll("canvas.coord-residuals-canvas").forEach(rebuildFor);
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
  document.addEventListener("lc:dataChanged", rebuildAll);
  document.addEventListener("lc:visibilityChanged", rebuildAll);
})();
