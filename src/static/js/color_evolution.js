/* Color-evolution panel — GP-derived colors with proper covariance errors.
 *
 * Source of truth is the live light-curve chart's `$lcGp` bundle (set by
 * `lcSetGp`): a per-band posterior flux grid {band, lambda_eff, mjd[],
 * flux_mean[], flux_std[]} plus `cov_offdiag` — the same-time flux covariance
 * Cov(F_b, F_c) between every band pair. From those we form adjacent-band
 * colors (u−g, g−r, r−i, i−z, z−Y) in magnitudes and propagate their errors
 * with the FULL band-band covariance, not the marginal per-band σ:
 *
 *   C = m_blue − m_red = −2.5·log10(F_blue / F_red)            (blue = smaller λ)
 *   Var(C) = a²·[ V_blue/F_blue² + V_red/F_red² − 2·Σ_br/(F_blue F_red) ]
 *   a = 2.5/ln(10),  V = flux_std²,  Σ_br = cov_offdiag["blue|red"]
 *
 * Two views: color-vs-time (shaded ±1σ band per pair) and a color-color
 * diagram (selectable X/Y pairs, points colored by time) with proper 1σ error
 * ELLIPSES from the 2×2 color covariance — capturing the shared-band
 * correlation between e.g. g−r and r−i.
 *
 * Display transforms applied client-side: dereddening is a constant per-color
 * shift −(A_blue − A_red) in Der mode; the distance modulus cancels in a color;
 * per-band display offsets are NOT applied. Invalid points (flux not
 * significantly positive, SNR < 2) are dropped — "ignore invalid values first".
 *
 * The panel shares the residuals grid cell and is auto-shown over Position
 * Residuals whenever the GP overlay is selected (see lightcurve.js
 * `lc:gpChanged` + `window.lcGpState`); it reverts when GP is deselected.
 */
(function () {
  const AB_ZP_NJY = 31.4; // unused directly (cancels in a color) — kept for clarity
  const A_COEF = 2.5 / Math.LN10; // mag error per fractional flux error
  const COLOR_MIN_SNR = 2.0; // drop a band's point below this flux SNR
  const ELLIPSE_SAMPLES = 40; // boundary samples per 1σ error ellipse

  // Duplicated from lightcurve.js rather than reaching across modules, to avoid
  // load-order coupling (the panel can mount before or after lightcurve.js).
  const BAND_COLORS = {
    u: "#56B4E9", g: "#009E73", r: "#D55E00",
    i: "#E69F00", z: "#CC79A7", y: "#0072B2", unknown: "#888888",
  };
  function bandColor(b) { return BAND_COLORS[b] || BAND_COLORS.unknown; }
  function withAlpha(color, alpha) {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return color;
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
      .toString(16).padStart(2, "0");
    return color + a;
  }

  const VIRIDIS_STOPS = [
    [0.0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 144, 140]],
    [0.75, [93, 200, 99]], [1.0, [253, 231, 37]],
  ];
  function viridisColor(t) {
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

  const charts = new WeakMap();

  function covKey(a, b) { return [a, b].sort().join("|"); }

  // Resolve the LC chart this color canvas is paired with via the wrapper's
  // data-lc-target, through window.lcGetChart (no import-order dependency).
  function lcChartFor(canvas) {
    const panel = canvas.closest("[data-color-panel]");
    const lcCanvasId = panel && panel.dataset.lcTarget;
    if (!lcCanvasId) return null;
    return window.lcGetChart ? window.lcGetChart(lcCanvasId) : null;
  }

  function isVisible(canvas) {
    // tw-hidden on an ancestor (display:none) → offsetParent is null. Don't
    // build a Chart into a 0×0 canvas; wait until the slot is un-hidden.
    return !!(canvas && canvas.offsetParent !== null);
  }

  // The colors derive from the GP fit, so a band is gated on its GP-curve
  // visibility — NOT the detection visibility. Hiding the raw detections in the
  // LC legend leaves the GP curves (and hence the colors) on screen; hiding a
  // band's GP curve ("GP g") drops that band here too. A band is visible if any
  // GP mean dataset (`$gp`, not an envelope `$gpHelper`) for it is shown.
  function lcBandVisible(lcChart, bandName) {
    if (!lcChart || !lcChart.data) return true;
    const ds = lcChart.data.datasets;
    let found = false, anyVisible = false;
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (d.$gp && !d.$gpHelper && d.$band === bandName) {
        found = true;
        if (lcChart.isDatasetVisible(i)) anyVisible = true;
      }
    }
    return found ? anyVisible : true;
  }

  // Per-band A_λ = R_λ · E(B-V) in Der mode, else {} (reuses the same contract
  // as lightcurve.js computeExtByBand). The color shift is A_blue − A_red.
  function extByBand(lcChart) {
    if (!lcChart || lcChart.$lcDered !== "dered") return {};
    const ebv = lcChart.$lcEbv;
    if (!(ebv > 0)) return {};
    const R = lcChart.$lcExtR || {};
    const out = {};
    for (const [band, r] of Object.entries(R)) out[band] = r * ebv;
    return out;
  }

  // Build the full color model from the LC chart's live GP bundle. Returns
  // null when there's no usable fit or fewer than two visible bands.
  function buildColorModel(lcChart) {
    const gp = lcChart && lcChart.$lcGp;
    if (!gp || !gp.available || !Array.isArray(gp.grid) || !gp.grid.length) return null;
    const bandsAll = gp.grid
      .filter((g) => g && isFinite(g.lambda_eff) && Array.isArray(g.mjd) && g.mjd.length)
      .sort((a, b) => a.lambda_eff - b.lambda_eff);
    const bands = bandsAll.filter((g) => lcBandVisible(lcChart, g.band));
    if (bands.length < 2) return null;

    const x = bands[0].mjd;
    const n = x.length;
    const folded = !!gp.folded;
    const cov = gp.cov_offdiag || {};
    const ext = extByBand(lcChart);

    // Map band name → grid entry (for the color-color covariance, which needs
    // any band pair, not just adjacent ones).
    const byName = {};
    for (const g of bands) byName[g.band] = g;

    // Per-point flux + variance accessors with the SNR/positivity guard.
    function fluxVar(g, k) {
      const f = g.flux_mean[k];
      const s = g.flux_std[k] || 0;
      const v = Math.max(0, s * s);
      const ok = f > 0 && f > COLOR_MIN_SNR * Math.sqrt(v);
      return { f, v, ok };
    }
    function sigmaFlux(b, c, k) {
      if (b === c) {
        const g = byName[b];
        const s = g.flux_std[k] || 0;
        return Math.max(0, s * s);
      }
      const arr = cov[covKey(b, c)];
      return arr ? (arr[k] || 0) : 0;
    }

    // Adjacent visible pairs (blue = bluer, smaller λ).
    const pairs = [];
    for (let i = 0; i + 1 < bands.length; i++) {
      const blue = bands[i], red = bands[i + 1];
      const shift = (ext[blue.band] || 0) - (ext[red.band] || 0); // dereddening
      const color = new Array(n).fill(null);
      const sigma = new Array(n).fill(null);
      for (let k = 0; k < n; k++) {
        const B = fluxVar(blue, k), R = fluxVar(red, k);
        if (!B.ok || !R.ok) continue;
        const sbr = sigmaFlux(blue.band, red.band, k);
        let varC = A_COEF * A_COEF *
          (B.v / (B.f * B.f) + R.v / (R.f * R.f) - 2 * sbr / (B.f * R.f));
        varC = Math.max(0, varC);
        color[k] = (-2.5 * Math.log10(B.f / R.f)) - shift;
        sigma[k] = Math.sqrt(varC);
      }
      pairs.push({
        blue: blue.band, red: red.band, label: `${blue.band}−${red.band}`,
        color, sigma,
      });
    }
    if (!pairs.length) return null;

    // x-range for the time/phase colorbar (finite x values).
    let xmin = Infinity, xmax = -Infinity;
    for (let k = 0; k < n; k++) {
      if (!isFinite(x[k])) continue;
      if (x[k] < xmin) xmin = x[k];
      if (x[k] > xmax) xmax = x[k];
    }

    return {
      pairs, x, n, folded, xmin, xmax, byName, cov,
      // 2×2 color covariance between two pairs P, Q at grid index k (handles a
      // shared band; uses the full band-band flux covariance). Returns null if
      // any contributing band is invalid at k.
      colorCov(P, Q, k) {
        const bP = [P.blue, P.red], bQ = [Q.blue, Q.red];
        const vinfo = {};
        for (const nm of new Set([...bP, ...bQ])) {
          const fv = fluxVar(byName[nm], k);
          if (!fv.ok) return null;
          vinfo[nm] = fv;
        }
        // ∂C^P/∂F: −a/F for blue, +a/F for red.
        const gP = { [P.blue]: -A_COEF / vinfo[P.blue].f, [P.red]: A_COEF / vinfo[P.red].f };
        const gQ = { [Q.blue]: -A_COEF / vinfo[Q.blue].f, [Q.red]: A_COEF / vinfo[Q.red].f };
        let c = 0;
        for (const b of bP) for (const d of bQ) c += gP[b] * gQ[d] * sigmaFlux(b, d, k);
        return c;
      },
    };
  }

  function panelFor(canvas) { return canvas.closest("[data-color-panel]"); }

  function panelMode(canvas) {
    const p = panelFor(canvas);
    return (p && p.dataset.ceMode === "cc") ? "cc" : "time";
  }

  function setStatus(canvas, text) {
    const p = panelFor(canvas);
    const el = p && p.querySelector("[data-ce-status]");
    if (el) el.textContent = text || "";
  }

  // Show/hide the time/phase colorbar and label its endpoints with the
  // currently selected window (the slider sub-range), so the colorbar's
  // min/max track what's plotted. `win` defaults to the full extent.
  function setRange(canvas, model, win) {
    const p = panelFor(canvas);
    if (!p) return;
    const range = p.querySelector("[data-ce-range]");
    const wrap = p.querySelector("[data-ce-colorbar]");
    const bar = p.querySelector("[data-ce-bar]");
    const show = model && isFinite(model.xmin) && isFinite(model.xmax);
    const fMin = win ? win.fMin : 0;
    const fMax = win ? win.fMax : 1;
    if (range) {
      if (show) {
        const lo = win ? win.selMin : model.xmin;
        const hi = win ? win.selMax : model.xmax;
        const unit = model.folded ? "φ" : "MJD";
        const fmt = (v) => model.folded ? v.toFixed(2) : v.toFixed(1);
        range.innerHTML = `<span>${unit} ${fmt(lo)}</span><span>${unit} ${fmt(hi)}</span>`;
        // Sit the endpoint labels under the colored band (which spans the
        // window's horizontal extent), not the full bar.
        range.style.marginLeft = `${(fMin * 100).toFixed(2)}%`;
        range.style.width = `${((fMax - fMin) * 100).toFixed(2)}%`;
      } else {
        range.innerHTML = "";
      }
    }
    // Repaint the colorbar: full viridis drawn across the window's width, dimmed
    // outside it — so the colormap range stays complete and the colored part
    // narrows/moves with the limits.
    if (bar && show) bar.style.background = windowGradient(fMin, fMax);
    if (wrap) wrap.classList.toggle("tw-hidden", !show);
  }

  // The selected time window from the dual-range slider, as fractions of the
  // model's full extent and the corresponding absolute (time/phase) bounds.
  // Defaults to the full extent when the sliders are absent or untouched.
  function timeWindow(canvas, model) {
    const p = panelFor(canvas);
    const tmin = p && p.querySelector("[data-ce-tmin]");
    const tmax = p && p.querySelector("[data-ce-tmax]");
    let fMin = tmin ? (+tmin.value) / 1000 : 0;
    let fMax = tmax ? (+tmax.value) / 1000 : 1;
    if (fMin > fMax) { const t = fMin; fMin = fMax; fMax = t; }
    const ext = model.xmax - model.xmin;
    return {
      fMin, fMax,
      selMin: model.xmin + fMin * ext,
      selMax: model.xmin + fMax * ext,
    };
  }

  // Color-color points + per-point 1σ ellipses for the visible time window.
  // Points outside [selMin, selMax] are dropped; viridis spans the WINDOW so the
  // selection always uses the full color scale. The colorbar mirrors this: its
  // colored band is the full viridis drawn over the window's width (see
  // windowGradient), so points and bar stay matched as the handles move.
  function computeCC(model, xPair, yPair, win) {
    const span = win.selMax > win.selMin ? win.selMax - win.selMin : 1;
    const pts = [], colors = [], ellipses = [];
    for (let k = 0; k < model.n; k++) {
      const cx = xPair.color[k], cy = yPair.color[k];
      if (cx == null || cy == null) continue;
      const x = model.x[k];
      if (x < win.selMin || x > win.selMax) continue;
      const col = viridisColor((x - win.selMin) / span);
      pts.push({ x: cx, y: cy, mjd: x });
      colors.push(col);
      const cov = model.colorCov(xPair, yPair, k);
      const geo = ellipseGeometry(xPair.sigma[k] * xPair.sigma[k],
        yPair.sigma[k] * yPair.sigma[k], cov == null ? 0 : cov);
      ellipses.push({ cx, cy, a1: geo.a1, a2: geo.a2, theta: geo.theta, color: col });
    }
    return { pts, colors, ellipses };
  }

  // Colorbar background: the FULL viridis colormap (purple→yellow) drawn only
  // across the window's horizontal extent [fMin, fMax]; the rest of the bar is
  // dimmed grey to show the full time extent. So the colormap range is always
  // complete, but the colored part narrows/moves with the window, and a point
  // at window-fraction q sits under the bar colour viridis(q).
  function windowGradient(fMin, fMax) {
    const N = 8;
    const grey = "#30363d";
    const lo = (fMin * 100).toFixed(2), hi = (fMax * 100).toFixed(2);
    const stops = [`${grey} 0%`, `${grey} ${lo}%`];
    for (let i = 0; i <= N; i++) {
      const pos = (fMin + (fMax - fMin) * (i / N)) * 100;
      stops.push(`${viridisColor(i / N)} ${pos.toFixed(2)}%`);
    }
    stops.push(`${grey} ${hi}%`, `${grey} 100%`);
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }

  // Light re-window of an existing color-color chart on slider drag — mutates
  // the dataset + ellipses in place (no destroy/recreate) so dragging is smooth.
  function applyTimeWindow(canvas) {
    const chart = charts.get(canvas);
    if (!chart || !chart.$ceModel || !chart.$ceXPair) return; // cc charts only
    const model = chart.$ceModel;
    const win = timeWindow(canvas, model);
    const { pts, colors, ellipses } = computeCC(model, chart.$ceXPair, chart.$ceYPair, win);
    const ds = chart.data.datasets[0];
    ds.data = pts; ds.backgroundColor = colors; ds.borderColor = colors;
    chart.$ceEllipses = ellipses;
    chart.update("none");
    setStatus(canvas, `${pts.length} pts · ${chart.$ceXPair.label} vs ${chart.$ceYPair.label} · 1σ ellipses`);
    setRange(canvas, model, win);
  }

  // Populate / sync the two color-color pair <select>s from the present pairs,
  // preserving the user's current choice where still valid.
  function syncPairSelects(canvas, model) {
    const p = panelFor(canvas);
    if (!p) return { x: null, y: null };
    const labels = model ? model.pairs.map((pr) => pr.label) : [];
    const selX = p.querySelector("[data-ce-xpair]");
    const selY = p.querySelector("[data-ce-ypair]");
    function fill(sel, fallbackIdx) {
      if (!sel) return null;
      const prev = sel.value;
      sel.innerHTML = "";
      for (const lab of labels) {
        const o = document.createElement("option");
        o.value = lab; o.textContent = lab;
        sel.appendChild(o);
      }
      if (labels.includes(prev)) sel.value = prev;
      else if (labels.length) sel.value = labels[Math.min(fallbackIdx, labels.length - 1)];
      return sel.value || null;
    }
    return { x: fill(selX, 0), y: fill(selY, 1) };
  }

  function buildTimeDatasets(model) {
    const datasets = [];
    for (const pr of model.pairs) {
      const color = bandColor(pr.blue);
      const main = [], lo = [], hi = [];
      for (let k = 0; k < model.n; k++) {
        const x = model.x[k];
        const c = pr.color[k];
        main.push({ x, y: c });
        if (c == null) { lo.push({ x, y: null }); hi.push({ x, y: null }); }
        else { lo.push({ x, y: c - pr.sigma[k] }); hi.push({ x, y: c + pr.sigma[k] }); }
      }
      // Order matters: lo then hi(fill:'-1' → fills to lo), then the mean line.
      datasets.push({
        label: pr.label + "__lo", data: lo, borderColor: "transparent",
        pointRadius: 0, fill: false, spanGaps: false, $ceHelper: true, $cePair: pr.label,
      });
      datasets.push({
        label: pr.label + "__hi", data: hi, borderColor: "transparent",
        backgroundColor: withAlpha(color, 0.16), pointRadius: 0, fill: "-1",
        spanGaps: false, $ceHelper: true, $cePair: pr.label,
      });
      datasets.push({
        label: pr.label, data: main, borderColor: color, backgroundColor: color,
        pointRadius: 0, borderWidth: 2, fill: false, spanGaps: false,
        tension: 0.15, $cePair: pr.label,
      });
    }
    return datasets;
  }

  function renderTime(canvas, model) {
    const datasets = buildTimeDatasets(model);
    const xTitle = model.folded ? "Phase" : "MJD";
    const chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        // Markerless lines → use index/nearest-x interaction so hovering
        // anywhere along a curve surfaces the tooltip.
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: xTitle, color: "#8b949e" },
            grid: { display: false }, border: { color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
          y: {
            type: "linear",
            title: { display: true, text: "Color [mag]", color: "#8b949e" },
            grid: { display: false }, border: { color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: "#c9d1d9", boxWidth: 12, usePointStyle: true,
              filter: (item, data) => !data.datasets[item.datasetIndex].$ceHelper,
            },
            // Toggle the pair's mean line + its ±1σ band together.
            onClick: (_e, item, legend) => {
              const ch = legend.chart;
              const pair = ch.data.datasets[item.datasetIndex].$cePair;
              ch.data.datasets.forEach((ds, i) => {
                if (ds.$cePair === pair) {
                  const meta = ch.getDatasetMeta(i);
                  meta.hidden = meta.hidden === null ? !ch.data.datasets[i].hidden : !meta.hidden;
                }
              });
              ch.update();
            },
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = items[0]?.parsed?.x;
                if (x == null) return "";
                return model.folded ? `Phase ${x.toFixed(3)}` : `MJD ${x.toFixed(3)}`;
              },
              label: (item) => {
                const ds = item.dataset;
                if (ds.$ceHelper) return null;
                return `${ds.label}: ${item.parsed.y.toFixed(3)} mag`;
              },
            },
          },
          zoom: {
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, drag: { enabled: true }, mode: "xy" },
            pan: { enabled: true, mode: "xy", modifierKey: "ctrl" },
          },
        },
      },
    });
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom());
    charts.set(canvas, chart);
    const nPairs = model.pairs.length;
    setStatus(canvas, `${nPairs} color${nPairs === 1 ? "" : "s"} vs ${model.folded ? "phase" : "time"}`);
    setRange(canvas, null); // colorbar only meaningful in color-color mode
  }

  // Custom plugin: stroke a 1σ error ellipse around each color-color point.
  // The ellipse is sampled in DATA space and mapped to pixels, so anisotropic
  // axis scaling and the tilt (shared-band correlation) render correctly. Reads
  // the live `chart.$ceEllipses` so a slider re-window updates in place.
  function ellipsePlugin() {
    return {
      id: "ceEllipses",
      // Draw BEFORE the dataset so the ellipses sit behind the points (the
      // points must stay readable on top of their uncertainty regions).
      beforeDatasetsDraw(chart) {
        const { ctx, scales: { x: xs, y: ys } } = chart;
        ctx.save();
        for (const e of (chart.$ceEllipses || [])) {
          if (!isFinite(e.cx) || !isFinite(e.cy)) continue;
          ctx.beginPath();
          for (let t = 0; t <= ELLIPSE_SAMPLES; t++) {
            const th = (t / ELLIPSE_SAMPLES) * 2 * Math.PI;
            const ct = Math.cos(th), st = Math.sin(th);
            const dxd = e.a1 * ct * Math.cos(e.theta) - e.a2 * st * Math.sin(e.theta);
            const dyd = e.a1 * ct * Math.sin(e.theta) + e.a2 * st * Math.cos(e.theta);
            const px = xs.getPixelForValue(e.cx + dxd);
            const py = ys.getPixelForValue(e.cy + dyd);
            if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.strokeStyle = withAlpha2(e.color, 0.55);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.restore();
      },
    };
  }
  // rgb()-string alpha helper (viridis returns rgb(), not hex).
  function withAlpha2(rgb, a) {
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(rgb);
    if (!m) return rgb;
    return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  }

  // Eigendecomposition of the symmetric 2×2 color covariance → 1σ semi-axes
  // and tilt for the ellipse.
  function ellipseGeometry(varX, varY, cov) {
    const tr = varX + varY;
    const det = varX * varY - cov * cov;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    const a1 = Math.sqrt(Math.max(0, l1)), a2 = Math.sqrt(Math.max(0, l2));
    let theta;
    if (Math.abs(cov) < 1e-300) theta = varX >= varY ? 0 : Math.PI / 2;
    else theta = Math.atan2(l1 - varX, cov);
    return { a1, a2, theta };
  }

  function renderColorColor(canvas, model, picks) {
    const xPair = model.pairs.find((p) => p.label === picks.x);
    const yPair = model.pairs.find((p) => p.label === picks.y);
    if (!xPair || !yPair) { renderEmpty(canvas, "Pick two colors."); return; }
    const win = timeWindow(canvas, model);
    const { pts, colors, ellipses } = computeCC(model, xPair, yPair, win);
    if (!pts.length) {
      renderEmpty(canvas, "No valid color-color points in this time window.");
      return;
    }

    const chart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: {
        datasets: [{
          label: `${xPair.label} vs ${yPair.label}`,
          data: pts, backgroundColor: colors, borderColor: colors,
          pointRadius: 3, pointHoverRadius: 5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: `${xPair.label} [mag]`, color: "#8b949e" },
            grid: { display: false }, border: { color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
          y: {
            type: "linear",
            title: { display: true, text: `${yPair.label} [mag]`, color: "#8b949e" },
            grid: { display: false }, border: { color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = item.raw;
                const t = model.folded ? `φ ${p.mjd.toFixed(3)}` : `MJD ${p.mjd.toFixed(2)}`;
                return `${xPair.label} ${p.x.toFixed(3)}, ${yPair.label} ${p.y.toFixed(3)} · ${t}`;
              },
            },
          },
          zoom: {
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, drag: { enabled: true }, mode: "xy" },
            pan: { enabled: true, mode: "xy", modifierKey: "ctrl" },
          },
        },
      },
      plugins: [ellipsePlugin()],
    });
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom());
    // Stash the model + active pairs + ellipses so the time-window slider can
    // re-window in place without a full rebuild.
    chart.$ceModel = model;
    chart.$ceXPair = xPair;
    chart.$ceYPair = yPair;
    chart.$ceEllipses = ellipses;
    charts.set(canvas, chart);
    setStatus(canvas, `${pts.length} pts · ${xPair.label} vs ${yPair.label} · 1σ ellipses`);
    setRange(canvas, model, win);
  }

  function renderEmpty(canvas, text) {
    const prior = charts.get(canvas);
    if (prior) { prior.destroy(); charts.delete(canvas); }
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, canvas.width, canvas.height);
    setStatus(canvas, text || "");
    setRange(canvas, null);
  }

  function renderInto(canvas, model) {
    if (typeof Chart === "undefined") return;
    const prior = charts.get(canvas);
    if (prior) { prior.destroy(); charts.delete(canvas); }
    if (!model) { renderEmpty(canvas, "No GP colors available."); return; }
    // Toggle the color-color pair selectors with the mode.
    const p = panelFor(canvas);
    const mode = panelMode(canvas);
    const picks = syncPairSelects(canvas, model);
    if (p) {
      const ccCtrls = p.querySelector("[data-ce-cc-controls]");
      if (ccCtrls) ccCtrls.classList.toggle("tw-hidden", mode !== "cc");
    }
    if (mode === "cc") renderColorColor(canvas, model, picks);
    else renderTime(canvas, model);
  }

  function rebuildFor(canvas) {
    const lcChart = lcChartFor(canvas);
    if (!lcChart) { return; } // LC not mounted yet; a later event will retry
    if (!isVisible(canvas)) return; // don't build into a hidden (0×0) canvas
    const state = window.lcGpState
      ? window.lcGpState(lcChart.canvas.id)
      : { overlaySelected: false, gpReady: false };
    if (!state.gpReady) {
      renderEmpty(canvas, state.overlaySelected
        ? "Fitting Gaussian process…"
        : "Select the GP overlay (Light curve toolbar) to see color evolution.");
      return;
    }
    renderInto(canvas, buildColorModel(lcChart));
  }

  function rebuildAll() {
    document.querySelectorAll("canvas.color-evolution-canvas").forEach(rebuildFor);
  }

  // Auto-show the panel over Position Residuals when GP is the active overlay,
  // and revert when it isn't — without clobbering a user-opened periodogram or
  // airmass (those stay; the panel just doesn't seize the cell).
  function applyGpVisibility() {
    const ce = document.getElementById("color-evolution-slot");
    const cr = document.getElementById("coord-residuals-slot");
    const pg = document.getElementById("periodogram-slot");
    const am = document.getElementById("airmass-slot");
    if (!ce) return;
    const hidden = (el) => !el || el.classList.contains("tw-hidden");
    const otherOpen = !hidden(pg) || !hidden(am);
    // Any LC chart with GP selected drives the cell. Single detail view → one.
    const overlaySelected = anyGpOverlaySelected();
    if (overlaySelected && !otherOpen) {
      if (cr) cr.classList.add("tw-hidden");
      if (ce.classList.contains("tw-hidden")) {
        ce.classList.remove("tw-hidden");
        window.dispatchEvent(new Event("resize"));
      }
    } else if (!overlaySelected) {
      if (!ce.classList.contains("tw-hidden")) {
        ce.classList.add("tw-hidden");
        if (!otherOpen && cr) cr.classList.remove("tw-hidden");
        window.dispatchEvent(new Event("resize"));
      }
    }
  }

  function anyGpOverlaySelected() {
    const slot = document.getElementById("color-evolution-slot");
    const canvas = slot && slot.querySelector("canvas.color-evolution-canvas");
    if (!canvas) return false;
    const lcChart = lcChartFor(canvas);
    if (!lcChart || !window.lcGpState) return false;
    return !!window.lcGpState(lcChart.canvas.id).overlaySelected;
  }

  function onGpChanged() {
    applyGpVisibility();
    rebuildAll();
  }

  function initCanvas(canvas) {
    if (canvas.$ceBound) return;
    canvas.$ceBound = true;
    const p = panelFor(canvas);
    if (p) {
      const modeBtn = p.querySelector("[data-ce-mode-btn]");
      if (modeBtn) modeBtn.addEventListener("click", () => {
        p.dataset.ceMode = panelMode(canvas) === "cc" ? "time" : "cc";
        modeBtn.textContent = panelMode(canvas) === "cc" ? "Color–color" : "vs Time";
        rebuildFor(canvas);
      });
      p.querySelectorAll("[data-ce-xpair], [data-ce-ypair]").forEach((sel) =>
        sel.addEventListener("change", () => rebuildFor(canvas)));
      // Dual-handle time-window slider (color-color view). Clamp so the min
      // handle can't pass the max handle, then re-window the scatter in place.
      const tmin = p.querySelector("[data-ce-tmin]");
      const tmax = p.querySelector("[data-ce-tmax]");
      if (tmin) tmin.addEventListener("input", () => {
        if (tmax && +tmin.value > +tmax.value) tmin.value = tmax.value;
        applyTimeWindow(canvas);
      });
      if (tmax) tmax.addEventListener("input", () => {
        if (tmin && +tmax.value < +tmin.value) tmax.value = tmin.value;
        applyTimeWindow(canvas);
      });
    }
    // Reflect the current GP state on mount (e.g. after a detail-view swap with
    // GP already armed on the new chart — rare, but harmless).
    applyGpVisibility();
    rebuildFor(canvas);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.color-evolution-canvas").forEach(initCanvas);
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
  document.addEventListener("lc:gpChanged", onGpChanged);
  document.addEventListener("lc:dataChanged", rebuildAll);
  document.addEventListener("lc:visibilityChanged", rebuildAll);
})();
