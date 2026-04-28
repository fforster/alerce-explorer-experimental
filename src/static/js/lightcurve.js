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

  // Per-survey marker shape for *detections*. FP keeps its open-triangle
  // marker across surveys (the "FP-ness" of a point is more important than
  // its survey of origin for pattern recognition); the survey of origin is
  // disambiguated by the legend grouping + the tooltip prefix. DR is ZTF-
  // only by construction, so it inherits ZTF's shape.
  const SURVEY_POINT_STYLE = { lsst: "circle", ztf: "rect" };
  function pointStyleFor(survey) {
    return SURVEY_POINT_STYLE[survey] || "circle";
  }
  function surveyLabel(survey) {
    return survey === "lsst" ? "LSST" : (survey === "ztf" ? "ZTF" : (survey || ""));
  }

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
  // z / E(B-V) are deliberately NOT persisted: redshift should only come
  // from a TNS report (server pre-fills the input) or a host click in the
  // sky view; E(B-V) should only come from the IRSA dust proxy. Carrying
  // them in the URL would let an old query-string assume values for an
  // object that never had them confirmed.
  const LC_DEFAULTS = {
    mode: "flux", source: "diff", abs: "app", dered: "obs", fold: "off",
    drShown: false, drAlpha: 0.10,
    overlay: "none",
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
      fold:  p.get("lc_fold")   || LC_DEFAULTS.fold,
      drShown: p.get("lc_dr") === "on",
      drAlpha: num("lc_dr_alpha") ?? LC_DEFAULTS.drAlpha,
      overlay: p.get("lc_overlay") || LC_DEFAULTS.overlay,
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
      state.fold === LC_DEFAULTS.fold &&
      !state.drShown &&
      Math.abs(state.drAlpha - LC_DEFAULTS.drAlpha) < 1e-6 &&
      state.overlay === LC_DEFAULTS.overlay;
    if (!isDefault) window._lcState = state;
  })();

  function restoredLcState() {
    // Cache wins: it was written by the previous chart's state changes and
    // outlives HX-Push-Url wiping lc_* params from the address bar.
    return window._lcState || readLcStateFromUrl();
  }

  function cacheAndPushLcState(chart) {
    // z / ebv intentionally absent: they're derived from per-object sources
    // (TNS report, host-galaxy click, dust proxy) rather than user-toggled
    // UI state, so persisting them across navigation would leak one
    // object's redshift onto the next.
    const state = {
      mode: chart.$lcMode,
      source: chart.$lcSource,
      abs: chart.$lcAbs,
      dered: chart.$lcDered,
      fold: chart.$lcFold || "off",
      drShown: chart.$lcDrShown,
      drAlpha: chart.$lcDrAlpha,
      overlay: chart.$lcOverlay || "none",
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
    setOrDel("lc_fold",   state.fold,   LC_DEFAULTS.fold);
    // Stale lc_z / lc_ebv from older URLs/cached links should disappear on
    // first state push, so explicitly delete them whether or not they were
    // present in the incoming URL.
    url.searchParams.delete("lc_z");
    url.searchParams.delete("lc_ebv");
    setOrDel("lc_dr", state.drShown ? "on" : "off", "off");
    // Default alpha compared with a small epsilon so 0.10 from the URL
    // round-trips to "absent" instead of "0.1".
    const alphaIsDefault = Math.abs((state.drAlpha ?? LC_DEFAULTS.drAlpha) - LC_DEFAULTS.drAlpha) < 1e-6;
    setOrDel("lc_dr_alpha", alphaIsDefault ? null : state.drAlpha, null);
    setOrDel("lc_overlay", state.overlay, LC_DEFAULTS.overlay);
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

  // Fold projection: map MJD → phase ∈ [0,1), emit the same point twice at
  // phase and phase+1 so the user sees two cycles side-by-side (convention
  // inherited from the prototype — it makes transits/eclipses at the wrap
  // unambiguous). Non-finite period → no fold (defensive; the button only
  // renders when the server supplied a positive period).
  function foldDataset(points, period) {
    if (!(period > 0)) return points;
    const out = [];
    for (const p of points) {
      if (!p || !isFinite(p.x)) continue;
      // JS % can yield negatives for pre-epoch MJDs; normalize into [0,1).
      let phase = (p.x / period) % 1;
      if (phase < 0) phase += 1;
      out.push({ ...p, x: phase });
      out.push({ ...p, x: phase + 1 });
    }
    return out;
  }

  // ── Parametric-fit overlays ───────────────────────────────────────────────
  //
  // Three model shapes live here, ported from ../Feature_explorer — the same
  // flux/mag projection pipeline runs on the model as on detections, so an
  // active Abs/Der/Fold toggle re-projects the overlay too. Band params and
  // the "latest version" selection come pre-picked from the server, so the
  // client just evaluates the closed-form model on a grid and hands it to
  // Chart.js as a zero-point line dataset.
  //
  // Flux-unit note: the reference uses µJy (AB ZP 23.9); we use nJy (ZP 31.4).
  //   - SPM_A is stored in mJy; ×1e6 → nJy (the reference used ×1e3 for µJy).
  //   - FLEET / TDE return magnitudes directly; 10^((31.4-mag)/2.5) → nJy.

  // Per-band line style: each overlay gets a distinct dash pattern so three
  // overlays on the same chart would still read as distinct curves.
  const OVERLAY_DASH = { spm: [6, 4], fleet: [2, 3], tde: [5, 2, 1, 2] };

  // Convert a model magnitude into whatever the axis expects, applying the
  // same distMod + extinction corrections `projectPoint` applies to detections.
  // Returns null when the projection would need log of a non-positive number.
  function projectModel(mag, axisMode, distMod, extMag) {
    if (!isFinite(mag)) return null;
    const A = extMag || 0;
    const mu = distMod || 0;
    if (axisMode === "mag") return mag - A - mu;
    // Flux path: mag → flux (nJy) and then apply the A + μ scalings.
    const flux = Math.pow(10, (AB_ZP_NJY - mag) / 2.5);
    const scale = Math.pow(10, 0.4 * (A + mu));
    return flux * scale;
  }

  // Sánchez-Sáez+2021 Eq. A5 — exponential rise × plateau ratio β, joining to
  // an exponential decay through a sigmoid at t1 = t0 + γ.
  function spmFlux_mJy(t, A, beta, t0, gamma, tau_rise, tau_fall) {
    const clamp = (x) => Math.max(-500, Math.min(500, x));
    const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x)));
    const t1 = t0 + gamma;
    const denom = 1 + Math.exp(-clamp((t - t0) / tau_rise));
    const betaExp = Math.pow(Math.max(beta, 1e-10), (t - t0) / gamma);
    const rise = (A * (1 - betaExp)) / denom;
    const fall = (A * (1 - beta) * Math.exp(-Math.max(0, t - t1) / tau_fall)) / denom;
    const s = sigmoid((t - t1) / 3);
    return rise * (1 - s) + fall * s;
  }

  // Global MJD envelope (from all detection bands). SPM + TDE tail evaluate
  // on the full range; FLEET needs a per-band earliest-MJD reference so it
  // computes its own first_mjd inside computeFleetTraces.
  function mjdEnvelope(bands) {
    let lo = Infinity, hi = -Infinity;
    for (const b of bands || []) {
      for (const p of b.points || []) {
        if (!isFinite(p.mjd)) continue;
        if (p.mjd < lo) lo = p.mjd;
        if (p.mjd > hi) hi = p.mjd;
      }
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
    return { min: lo, max: hi };
  }

  // Project an overlay's {mjd, mag} grid through the active projection plus
  // (optional) fold, return a sorted {x,y} array ready for Chart.js. Returns
  // null for points the projection rejects (e.g. mag at non-positive flux
  // after extinction brings it below zero — shouldn't happen in practice).
  function projectOverlayGrid(gridMags, bandName, axisMode, distMod, extByBand, foldPeriod) {
    const extMag = (extByBand || {})[bandName] || 0;
    const pts = gridMags
      .map(({ mjd, mag }) => {
        const y = projectModel(mag, axisMode, distMod, extMag);
        return y == null || !isFinite(y) ? null : { x: mjd, y };
      })
      .filter(Boolean);
    return foldPeriod ? foldDataset(pts, foldPeriod) : pts;
  }

  function makeOverlayDataset(overlayKey, bandName, points) {
    const color = BAND_COLORS[bandName] || BAND_COLORS.unknown;
    const overlayLabel = overlayKey === "tde" ? "TDE tail" : overlayKey.toUpperCase();
    return {
      label: `${overlayLabel} ${bandName}`,
      data: points,
      borderColor: color,
      backgroundColor: "transparent",
      borderWidth: 1.5,
      borderDash: OVERLAY_DASH[overlayKey] || [6, 4],
      showLine: true,
      spanGaps: false,
      pointRadius: 0,
      pointHoverRadius: 0,
      // Draw overlay on top of DR (-1) and default points (0) so a thin
      // dashed line stays visible against a dense light curve.
      order: 2,
    };
  }

  function computeSPMTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod) {
    if (!fits || !fits.spm) return [];
    const env = mjdEnvelope(bands);
    if (!env) return [];
    const NJY_PER_MJY = 1e6;  // SPM_A is mJy; our flux axis is nJy.
    const traces = [];
    for (const [band, p] of Object.entries(fits.spm)) {
      if (!(p.gamma > 0 && p.tau_rise > 0 && p.tau_fall > 0)) continue;
      const grid = [];
      for (let i = 0; i < 100; i++) {
        const t = ((env.max - env.min) * i) / 99;
        const fluxNjy = spmFlux_mJy(t, p.A, p.beta, p.t0, p.gamma, p.tau_rise, p.tau_fall)
                      * NJY_PER_MJY;
        // Convert to mag via the survey ZP, skip non-positive (sigmoid tail
        // can undershoot zero with extreme params — render as a gap).
        if (!(fluxNjy > 0)) continue;
        const mag = AB_ZP_NJY - 2.5 * Math.log10(fluxNjy);
        grid.push({ mjd: env.min + t, mag });
      }
      const pts = projectOverlayGrid(grid, band, axisMode, distMod, extByBand, foldPeriod);
      if (pts.length) traces.push(makeOverlayDataset("spm", band, pts));
    }
    return traces;
  }

  // FLEET mag model — grows polynomially from t0, then levels to m0.
  //
  // Per-band time reference matches the FleetExtractor in
  // alercebroker/pipeline/lc_classifier (tde_extractor.py::FleetExtractor):
  //   observations = pd.concat([detections, forced_photometry])
  //   observations = observations[brightness > 1]   # > 1 µJy diff flux
  //   observations = observations[e_brightness > 0]
  //   first_mjd   = band_observations.sort_values("mjd").iloc[0]["mjd"]
  // — i.e. the earliest MJD across the UNION of detections and forced
  // photometry in that band, each filtered to (flux > 1 µJy AND σ > 0).
  // Dropping either source from the union shifts the anchor: FP-only
  // pushes it earlier (noise spikes that clear 1 µJy in the quiescent
  // baseline), alert-only pushes it later (misses the real FP onset).
  function fleetMag(t_norm, a, w, m0, t0) {
    const dt = t_norm - t0;
    return Math.exp(w * dt) - a * w * dt + m0;
  }

  function computeFleetTraces(fits, bands, fpBands, axisMode, distMod, extByBand, foldPeriod) {
    if (!fits || !fits.fleet) return [];
    const env = mjdEnvelope(bands);
    if (!env) return [];
    const FLUX_FLOOR_NJY = 1000;  // extractor threshold 1 µJy → 1000 nJy.
    // The extractor filters on `brightness > 1 µJy` where `brightness` is
    // SIGNED diff flux (positive = brightening, negative = dimming). Our
    // `pt.flux` is |diff flux| (ZTF psf_flux comes from a positive magpsf);
    // the sign lives in `pt.isdiffpos`. Without multiplying the sign back
    // in, dimming-event points (isdiffpos=−1) with large |flux| clear the
    // threshold and pull the per-band first_mjd far before the real trigger
    // (the original bug). LSST flux is already signed and isdiffpos=null,
    // which this guard treats as positive — the right default there.
    const pickBright = (pts) => (pts || [])
      .filter((pt) => {
        if (!isFinite(pt.mjd) || pt.e_flux == null || !(pt.e_flux > 0)) return false;
        const sign = pt.isdiffpos === -1 ? -1 : 1;
        return pt.flux * sign > FLUX_FLOOR_NJY;
      })
      .map((pt) => pt.mjd);
    const traces = [];
    for (const [band, p] of Object.entries(fits.fleet)) {
      const alertInBand = (bands || []).find((b) => b.name === band);
      const fpInBand = (fpBands || []).find((b) => b.name === band);
      const brightMjds = [
        ...pickBright(alertInBand?.points),
        ...pickBright(fpInBand?.points),
      ];
      if (!brightMjds.length) continue;
      const firstMjdBand = Math.min(...brightMjds);
      const grid = [];
      for (let i = 0; i < 100; i++) {
        const mjd = env.min + ((env.max - env.min) * i) / 99;
        const mag = fleetMag(mjd - firstMjdBand, p.a, p.w, p.m0, p.t0);
        if (!isFinite(mag)) continue;
        grid.push({ mjd, mag });
      }
      const pts = projectOverlayGrid(grid, band, axisMode, distMod, extByBand, foldPeriod);
      if (pts.length) traces.push(makeOverlayDataset("fleet", band, pts));
    }
    return traces;
  }

  // TDE tail model: mag(t) = mag0 + decay · 2.5 · log10(t - t_peak + 40).
  // t_peak is data-derived (not stored): brightest detection in-band passing
  // e_mag < 1.0 and mag < 30, matching the extractor. We only have fluxes in
  // the client, so we derive mag/e_mag from flux/eFlux (ZP 31.4 in nJy).
  function computeTDETailTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod) {
    if (!fits || !fits.tde) return [];
    const traces = [];
    for (const [band, p] of Object.entries(fits.tde)) {
      const inBand = (bands || []).find((b) => b.name === band);
      if (!inBand || !(inBand.points || []).length) continue;
      const bandDets = inBand.points
        .map((pt) => {
          if (!(pt.flux > 0) || !isFinite(pt.mjd)) return null;
          const mag = AB_ZP_NJY - 2.5 * Math.log10(pt.flux);
          const eMag = pt.e_flux != null && pt.e_flux > 0
            ? pt.e_flux / pt.flux / LN10_OVER_2P5 : null;
          if (!isFinite(mag) || mag >= 30) return null;
          if (eMag == null || !(eMag < 1.0)) return null;
          return { mjd: pt.mjd, mag };
        })
        .filter(Boolean);
      if (!bandDets.length) continue;
      const tPeak = bandDets.reduce((best, d) => (d.mag < best.mag ? d : best)).mjd;
      const bandMax = Math.max(...bandDets.map((d) => d.mjd));
      if (!(bandMax > tPeak)) continue;
      const grid = [];
      for (let i = 0; i < 100; i++) {
        const mjd = tPeak + ((bandMax - tPeak) * i) / 99;
        const dt = mjd - tPeak;
        if (dt <= 0) continue;
        const mag = p.mag0 + p.decay * 2.5 * Math.log10(dt + 40);
        if (!isFinite(mag)) continue;
        grid.push({ mjd, mag });
      }
      const pts = projectOverlayGrid(grid, band, axisMode, distMod, extByBand, foldPeriod);
      if (pts.length) traces.push(makeOverlayDataset("tde", band, pts));
    }
    return traces;
  }

  function buildOverlayDatasets(chart, axisMode, distMod, extByBand, foldPeriod) {
    const fits = chart.$lcFits;
    const key = chart.$lcOverlay;
    if (!fits || !key || key === "none") return [];
    const bands = (chart.$lcRaw && chart.$lcRaw.bands) || [];
    const fpBands = (chart.$lcRaw && chart.$lcRaw.fpBands) || [];
    let traces = [];
    if (key === "spm") traces = computeSPMTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod);
    else if (key === "fleet") traces = computeFleetTraces(fits, bands, fpBands, axisMode, distMod, extByBand, foldPeriod);
    else if (key === "tde") traces = computeTDETailTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod);
    // Stamp survey + kind so the legend grouper places overlays under the
    // primary survey's header (overlays derive from the primary's features
    // — LSST has no features endpoint today, so in practice they're ZTF).
    const survey = chart.$lcSurvey || "";
    for (const t of traces) {
      t.$survey = survey;
      t.$kind = "overlay";
    }
    return traces;
  }

  // ── Param info strip ──────────────────────────────────────────────────────
  // Per-band table of the fit parameters (plus χ² when present), shown under
  // the toolbar when an overlay is active. The server already pruned entries
  // that lacked any required param, so an overlay we armed is guaranteed to
  // have at least one band worth rendering.
  const OVERLAY_PARAM_LABELS = {
    spm:   [["A", "A", 3], ["beta", "β", 3], ["t0", "t₀", 2], ["gamma", "γ", 2],
            ["tau_rise", "τ↑", 2], ["tau_fall", "τ↓", 2], ["chi", "χ²", 3]],
    fleet: [["a", "a", 3], ["w", "w", 4], ["m0", "m₀", 2], ["t0", "t₀", 2],
            ["chi", "χ²", 2]],
    tde:   [["mag0", "m₀", 2], ["decay", "k", 3], ["decay_chi", "χ²", 2]],
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  }

  function renderOverlayInfo(chart) {
    const strip = document.querySelector(`.lc-overlay-info[data-target="${chart.canvas.id}"]`);
    if (!strip) return;
    const key = chart.$lcOverlay;
    const fits = chart.$lcFits;
    if (!key || key === "none" || !fits || !fits[key]) {
      strip.classList.add("tw-hidden");
      strip.innerHTML = "";
      return;
    }
    const perBand = fits[key];
    const spec = OVERLAY_PARAM_LABELS[key] || [];
    const lines = Object.entries(perBand)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([band, params]) => {
        const color = BAND_COLORS[band] || BAND_COLORS.unknown;
        const parts = spec.map(([k, label, digits]) => {
          const v = params[k];
          const disp = v != null && isFinite(v) ? v.toFixed(digits) : "—";
          return `${label}=<b>${escapeHtml(disp)}</b>`;
        });
        return `<span style="color:${color}">${escapeHtml(band)}</span>&nbsp;&nbsp;${parts.join("&nbsp;&nbsp;")}`;
      });
    strip.innerHTML = lines.join("<br>");
    strip.classList.remove("tw-hidden");
  }

  function buildDatasets(bands, fpBands, drBands, axisMode, sourceMode, distMod, extByBand, drAlpha, foldPeriod, survey) {
    const extFor = (name) => (extByBand || {})[name] || 0;
    const project = (band) => {
      const rows = band.points
        .map((p) => projectPoint(p, axisMode, sourceMode, distMod, extFor(band.name)))
        .filter(Boolean);
      return foldPeriod ? foldDataset(rows, foldPeriod) : rows;
    };
    const detStyle = pointStyleFor(survey);
    const det = bands.map((b) => ({
      label: b.name,
      $survey: survey,
      $kind: "det",
      data: project(b),
      backgroundColor: BAND_COLORS[b.name] || BAND_COLORS.unknown,
      borderColor: BAND_COLORS[b.name] || BAND_COLORS.unknown,
      pointStyle: detStyle,
      showLine: false,
      pointRadius: 3,
      pointHoverRadius: 5,
    }));
    // FP uses the same band colors but rendered as hollow triangles so they
    // read as distinct from detections without crowding the legend/tooltip.
    // FP rows don't carry a stamp identifier, so clicks on them are no-ops.
    const fp = (fpBands || []).map((b) => ({
      label: `${b.name} (FP)`,
      $survey: survey,
      $kind: "fp",
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
    // as tiny 10%-alpha markers in the band color, taking the survey's
    // detection shape (DR is ZTF-only today, so this is a square in
    // practice), and with a negative draw-order so det + FP always sit on
    // top of a dense DR crossmatch.
    const alpha = (typeof drAlpha === "number" && isFinite(drAlpha)) ? drAlpha : 0.10;
    const dr = (drBands || []).map((b) => {
      const base = BAND_COLORS[b.name] || BAND_COLORS.unknown;
      return {
        label: `${b.name} (DR)`,
        $survey: survey,
        $kind: "dr",
        data: project(b),
        backgroundColor: withAlpha(base, alpha),
        borderColor: withAlpha(base, alpha),
        borderWidth: 1,
        pointStyle: detStyle,
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
    const foldPeriod =
      chart.$lcFold === "fold" && chart.$lcPeriod > 0 ? chart.$lcPeriod : null;
    const primarySurvey = chart.$lcSurvey || "";
    const baseDatasets = buildDatasets(
      raw.bands, raw.fpBands, drBands, axisMode, sourceMode, distMod, extByBand,
      chart.$lcDrAlpha, foldPeriod, primarySurvey,
    );
    // Cross-survey overlay (the *other* survey's matched source). Stays empty
    // until /htmx/lc_xsurvey lands and `lcSetCrossSurvey` populates `$lcXRaw`.
    // Re-projects through the same axisMode/sourceMode/distMod/extByBand the
    // primary uses so the two telescopes' photometry stays comparable on every
    // toggle (Flux/Mag, App/Abs, Obs/Der, Fold).
    const xRaw = chart.$lcXRaw;
    const xDatasets = (xRaw && xRaw.survey)
      ? buildDatasets(
          xRaw.bands || [], xRaw.fpBands || [], [], axisMode, sourceMode,
          distMod, extByBand, chart.$lcDrAlpha, foldPeriod, xRaw.survey,
        )
      : [];
    const overlayDatasets = buildOverlayDatasets(chart, axisMode, distMod, extByBand, foldPeriod);
    chart.data.datasets = [...baseDatasets, ...xDatasets, ...overlayDatasets];
    renderOverlayInfo(chart);
    const x = chart.options.scales.x;
    if (foldPeriod) {
      x.title.text = `Phase (P = ${foldPeriod.toPrecision(6)} d)`;
      // Pin two cycles: [0, 2]. User can still zoom/pan from here.
      x.min = 0;
      x.max = 2;
    } else {
      x.title.text = "MJD";
      delete x.min;
      delete x.max;
    }
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
      data: { datasets: buildDatasets(bands, fpBands, [], initialAxisMode, initialSourceMode, null, null, null, null, data.survey || "") },
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
            // and FP triangles / DR markers would read as the wrong shape
            // despite being drawn correctly on the plot.
            //
            // generateLabels groups datasets by `$survey` and emits a
            // non-clickable header per group ("LSST:", "ZTF:") so the legend
            // reads like a sentence: `LSST: u g r i z y · ZTF: g r i`. The
            // header items carry no datasetIndex; the custom onClick below
            // ignores those, while real items toggle dataset visibility just
            // like Chart.js's default.
            onClick: (_e, legendItem, legend) => {
              const ci = legend.chart;
              // Survey header: toggle every dataset in that survey group as
              // a unit. "Hide all" wins when any member is currently visible
              // (one click ⇒ everything off); "show all" only when the whole
              // group is already hidden — mirrors Chart.js's per-item toggle
              // semantics, just lifted to the group.
              if (legendItem.datasetIndex == null) {
                const survey = legendItem.$survey;
                if (!survey) return;
                const indices = ci.data.datasets
                  .map((ds, i) => (ds.$survey === survey ? i : -1))
                  .filter((i) => i >= 0);
                if (!indices.length) return;
                const anyVisible = indices.some((i) => ci.isDatasetVisible(i));
                for (const i of indices) {
                  ci.getDatasetMeta(i).hidden = anyVisible ? true : false;
                }
                ci.update();
                return;
              }
              const meta = ci.getDatasetMeta(legendItem.datasetIndex);
              meta.hidden = meta.hidden === null
                ? !ci.data.datasets[legendItem.datasetIndex].hidden
                : null;
              ci.update();
            },
            labels: {
              color: "#c9d1d9",
              usePointStyle: true,
              boxWidth: 10,
              generateLabels: (ch) => {
                // Group order: LSST first, then ZTF, then anything else.
                // Within each group, preserve the dataset emission order
                // (det → FP → DR) since that's what `buildDatasets` returns.
                //
                // `fontColor` is repeated per item because a custom
                // generateLabels bypasses the global `labels.color` cascade
                // (Chart.js only inherits when it generates the labels
                // itself); without it the survey headers and band names
                // render in the dataset's own color rather than whitish.
                const TEXT = "#c9d1d9";
                const groups = new Map();
                ch.data.datasets.forEach((ds, i) => {
                  const survey = ds.$survey || "";
                  if (!groups.has(survey)) groups.set(survey, []);
                  groups.get(survey).push({
                    text: ds.label,
                    fillStyle: ds.backgroundColor,
                    strokeStyle: ds.borderColor,
                    lineWidth: ds.borderWidth || 1,
                    pointStyle: ds.pointStyle || pointStyleFor(survey),
                    fontColor: TEXT,
                    hidden: !ch.isDatasetVisible(i),
                    datasetIndex: i,
                  });
                });
                const ordered = [];
                const surveys = ["lsst", "ztf", ...Array.from(groups.keys()).filter((s) => s !== "lsst" && s !== "ztf")];
                for (const s of surveys) {
                  const items = groups.get(s);
                  if (!items || !items.length) continue;
                  if (s) {
                    // Header reflects group-visibility: when every member is
                    // hidden the header renders struck-through (same affordance
                    // Chart.js applies to a hidden series), so the user sees
                    // "the group is off". `$survey` is the key onClick uses
                    // to look up which datasets belong to the group.
                    const allHidden = items.every((it) => it.hidden);
                    ordered.push({
                      text: `${surveyLabel(s)}:`,
                      fillStyle: "transparent",
                      strokeStyle: "transparent",
                      lineWidth: 0,
                      pointStyle: "circle",
                      fontColor: TEXT,
                      hidden: allHidden,
                      $survey: s,
                      // No datasetIndex — onClick uses that to detect headers.
                    });
                  }
                  ordered.push(...items);
                }
                return ordered;
              },
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const p = ctx.raw;
                const err = p.e != null ? ` ± ${p.e.toPrecision(3)}` : "";
                const unit = chart.$lcMode === "mag" ? "mag" : "nJy";
                const xLabel = chart.$lcFold === "fold" && chart.$lcPeriod > 0
                  ? `phase ${p.x.toFixed(3)}`
                  : `MJD ${p.x.toFixed(3)}`;
                // Prefix with survey so two `g` series (one per telescope)
                // are unambiguous in the tooltip; legend drops the prefix
                // because it's already grouped under the survey header.
                const sLabel = surveyLabel(ctx.dataset.$survey);
                const prefix = sLabel ? `${sLabel} ` : "";
                return `${prefix}${ctx.dataset.label}: ${p.y.toPrecision(4)}${err} ${unit} @ ${xLabel}`;
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
    // Cross-survey overlay starts empty; lcSetCrossSurvey populates it from
    // the deferred /htmx/lc_xsurvey response when the conesearch finds a
    // counterpart on the other survey.
    chart.$lcXRaw = null;
    chart.$lcXOid = null;
    // Stashed so the CSV download can emit the survey name and the period
    // (for a fold-active export note) without re-parsing canvas.dataset.lc.
    chart.$lcSurvey = data.survey || "";
    // Parametric-fit bundle from the server; {} when none available. Used by
    // buildOverlayDatasets + renderOverlayInfo; the select's options are
    // pre-disabled server-side for overlays this object has no data for.
    chart.$lcFits = (data.parametric_fits && typeof data.parametric_fits === "object")
      ? data.parametric_fits : {};
    // Restore overlay only if the corresponding fit actually exists for this
    // object. An old URL from a different object might carry lc_overlay=spm
    // when this one only has fleet; demote to "none" rather than arming a
    // dead overlay.
    const restoredOverlay = restored.overlay && chart.$lcFits[restored.overlay]
      ? restored.overlay : "none";
    chart.$lcOverlay = restoredOverlay;
    chart.$lcMode = initialAxisMode;
    chart.$lcSource = initialSourceMode;
    chart.$lcAbs = restored.abs === "abs" ? "abs" : "app";
    chart.$lcZ = null;  // set below from input after pre-fill
    chart.$lcDered = restored.dered === "dered" ? "dered" : "obs";
    chart.$lcEbv = null;  // set below from input after pre-fill
    chart.$lcExtR = extR;
    // Fold: the period lives on the Fold button's data-lc-period, which
    // the deferred /htmx/lc_features fragment stamps once features arrive.
    // On the synchronous render path we don't yet have a period (the
    // template renders the button hidden + with empty data-lc-period), so
    // stash the *restored* fold intent on the chart and let `lcSetFeatures`
    // re-engage it when a positive period actually shows up.
    const foldBtn = document.querySelector(`.lc-fold-toggle[data-target="${canvas.id}"]`);
    const period = foldBtn ? parseFloat(foldBtn.dataset.lcPeriod) : NaN;
    chart.$lcPeriod = isFinite(period) && period > 0 ? period : null;
    chart.$lcFold = restored.fold === "fold" && chart.$lcPeriod ? "fold" : "off";
    chart.$lcFoldRestoreIntent = restored.fold === "fold";
    chart.$lcOverlayRestoreIntent = restored.overlay || null;
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

    // z / E(B-V) are NOT restored from cache or URL — they come from the
    // server-rendered input value (TNS pre-fill) or from the dust proxy
    // fetch below, so an old object's z can't bleed onto a new one. Sync
    // immediately so the chart picks up any TNS-supplied value the
    // template baked into the input's value attribute.
    const zInput = document.querySelector(`.lc-redshift-input[data-target="${canvas.id}"]`);
    if (zInput) syncRedshiftFromInput(chart, zInput, false);
    const ebvInput = document.querySelector(`.lc-ebv-input[data-target="${canvas.id}"]`);
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
    // Buttons that are binary and "this is either on or off" (rather than
    // projection toggles like Flux/Mag where every value is equally valid)
    // declare an `activeValue`. The label stays constant; we flip the text
    // and border to the accent color so the change is visible even while
    // the cursor is still hovering the button (a text-only flip would be
    // masked by hover:tw-text-text-primary).
    if (spec.activeValue) {
      const active = value === spec.activeValue;
      btn.classList.toggle("tw-text-accent", active);
      btn.classList.toggle("tw-border-accent", active);
      btn.classList.toggle("tw-text-text-muted", !active);
      btn.classList.toggle("tw-border-border", !active);
    }
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
    // Fold: fold-on vs fold-off is a binary state (not a projection axis
    // like flux/mag), so we keep the label constant and flip the text color
    // muted→primary via `activeValue` to signal whether folding is on.
    fold:   { btnSelector: ".lc-fold-toggle",   dataKey: "lcFold",   chartProp: "$lcFold",
              values: ["off", "fold"], labels: { off: "Fold", fold: "Fold" },
              activeValue: "fold",
              guard: (chart, v) => v !== "fold" || (chart.$lcPeriod > 0) },
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

  // Parametric-fit overlay picker (SPM / FLEET / TDE tail). Kept as a plain
  // <select> rather than a cycle button because the value space is 4-wide
  // and at most one overlay makes sense at a time (no "off" wrapper needed).
  function bindOverlaySelect(sel) {
    if (sel.$bound) return;
    sel.$bound = true;
    const canvas = document.getElementById(sel.dataset.target);
    const chart = canvas && charts.get(canvas);
    if (chart) {
      // Seed the dropdown from whatever state initCanvas restored — may have
      // been demoted from the URL's request if the overlay doesn't exist on
      // this object.
      sel.value = chart.$lcOverlay || "none";
    }
    sel.addEventListener("change", () => {
      const cv = document.getElementById(sel.dataset.target);
      const c = cv && charts.get(cv);
      if (!c) return;
      const next = sel.value;
      // Guard against a user picking a disabled option via keyboard (all
      // major browsers block this already, but belt-and-braces):
      if (next !== "none" && !(c.$lcFits && c.$lcFits[next])) {
        sel.value = c.$lcOverlay || "none";
        return;
      }
      c.$lcOverlay = next;
      applyModes(c);
      cacheAndPushLcState(c);
    });
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  //
  // One button → full snapshot of the plotted data. We re-run `projectPoint`
  // over raw det/FP/DR bands with the chart's current projection state, so
  // the CSV matches what the user sees after every toggle. Fold is
  // deliberately NOT applied: it's a display transform that would duplicate
  // every row (two cycles side-by-side), which is useless in a file; the
  // period lands in the metadata header instead.
  function pad2(n) { return String(n).padStart(2, "0"); }

  function filenameTimestamp() {
    // Local time so the filename lines up with the user's clock — easier to
    // pair with their notebook timestamps than UTC. `YYYYMMDDTHHMMSS`
    // (ISO-compact) keeps filenames sortable.
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
         + `T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }

  // All 16 projection combinations — axis × source × distance × extinction.
  // The export writes every combination as its own column so downstream
  // analysis never needs to re-run the transforms; abs cells stay empty
  // when z isn't set, der cells stay empty when E(B-V) isn't set, so a
  // consumer can tell "no data here" from "zero correction applied".
  const AXES = ["flux", "mag"];
  const SOURCES = ["diff", "sci"];
  const DISTS = ["app", "abs"];
  const EXTS = ["obs", "der"];

  function fmtNum(v) {
    // toPrecision(8) gives a balance between file size and round-trip
    // accuracy; empty string for null/NaN so the CSV cell is blank rather
    // than printing "null".
    if (v == null || !isFinite(v)) return "";
    return Number(v).toPrecision(8);
  }

  function downloadLcData(chart, oid) {
    const raw = chart.$lcRaw;
    if (!raw) return;
    // Compute distmod + A_band from the chart's current z / E(B-V),
    // independently of the Abs/Der toggle state — the export carries all
    // 16 projections, not just the active one. If z or E(B-V) is unset,
    // the corresponding abs/der columns stay empty so consumers can
    // distinguish "user hasn't provided this yet" from "the correction
    // was zero".
    const z = chart.$lcZ;
    const ebv = chart.$lcEbv;
    const extR = chart.$lcExtR || {};
    const distMod = (z > 0 && typeof window.cosmology !== "undefined")
      ? (isFinite(window.cosmology.distanceModulus(z))
         ? window.cosmology.distanceModulus(z) : null)
      : null;
    const extByBand = {};
    if (ebv > 0) {
      for (const [b, r] of Object.entries(extR)) extByBand[b] = r * ebv;
    }
    const survey = chart.$lcSurvey || "";
    const foldActive = chart.$lcFold === "fold" && chart.$lcPeriod > 0;
    const now = new Date();

    const lines = [];
    // Metadata header — `#`-prefixed so pandas/astropy can skip it with the
    // standard `comment="#"` option. Units and conventions are explicit
    // here so the column names can stay terse.
    lines.push("# ALeRCE light curve export");
    lines.push(`# oid: ${oid}`);
    lines.push(`# survey: ${survey}`);
    lines.push(`# downloaded_at: ${now.toISOString()}`);
    lines.push("# flux_unit: nJy (AB ZP = 31.4)");
    lines.push("# mag_unit: AB");
    lines.push("# column_schema: {axis}_{source}_{distance}_{extinction}");
    lines.push("#   axis=flux|mag, source=diff|sci, distance=app|abs, extinction=obs|der");
    lines.push("# error columns are prefixed with 'e_' (symmetric 1σ;"
      + " for mag the small-error linearization of the flux error)");
    if (z != null && z > 0) lines.push(`# redshift: ${z}`);
    else lines.push("# redshift: (unset — *_abs columns will be empty)");
    if (distMod != null) lines.push(`# distmod: ${distMod.toFixed(4)} mag (Planck 2018)`);
    if (ebv != null && ebv > 0) lines.push(`# ebv: ${ebv}`);
    else lines.push("# ebv: (unset — *_der columns will be empty)");
    if (Object.keys(extByBand).length > 0) {
      lines.push("# A_band (Fitzpatrick 1999, mag): "
        + Object.entries(extByBand).map(([k,v]) => `${k}=${v.toFixed(4)}`).join(", "));
    }
    if (foldActive) {
      lines.push(`# fold_period_days: ${chart.$lcPeriod}`);
      lines.push("# note: fold is a display transform; rows below are unfolded MJD.");
    }

    // Build the column header. Identity columns first, then the 32 value
    // + error columns in a deterministic order so two exports of the
    // same object always produce the same schema.
    const dataCols = [];
    for (const axis of AXES)
      for (const source of SOURCES)
        for (const dist of DISTS)
          for (const ext of EXTS) {
            const key = `${axis}_${source}_${dist}_${ext}`;
            dataCols.push(key, `e_${key}`);
          }
    lines.push(["phot_type", "band", "mjd", "identifier", ...dataCols].join(","));

    // Per-row: call projectPoint for each of the 16 combinations with the
    // appropriate distmod/extinction. projectPoint returns null when the
    // source flux is null (e.g. sci columns on a point without science
    // photometry, or mag on negative diff flux) → the cell stays empty.
    const emit = (phot_type, bandList) => {
      for (const band of bandList || []) {
        const A_band = extByBand[band.name] || 0;
        for (const p of band.points || []) {
          if (!isFinite(p.mjd)) continue;
          const cells = [];
          for (const axis of AXES)
            for (const source of SOURCES)
              for (const dist of DISTS)
                for (const ext of EXTS) {
                  // abs/der columns stay empty when the user hasn't
                  // provided z / E(B-V); otherwise route the active
                  // scalar through projectPoint so this export uses the
                  // exact same pipeline the chart does.
                  const dm = dist === "abs" ? (distMod != null ? distMod : NaN) : null;
                  const em = ext === "der" ? (ebv > 0 ? A_band : NaN) : 0;
                  if (Number.isNaN(dm) || Number.isNaN(em)) {
                    cells.push("", "");
                    continue;
                  }
                  const proj = projectPoint(p, axis, source, dm, em);
                  if (!proj) { cells.push("", ""); continue; }
                  cells.push(fmtNum(proj.y), fmtNum(proj.e));
                }
          const ident = p.identifier != null ? String(p.identifier) : "";
          lines.push([phot_type, band.name, p.mjd, ident, ...cells].join(","));
        }
      }
    };
    emit("alert_detection", raw.bands);
    emit("forced_photometry", raw.fpBands);
    // Only export ZTF DR when the user has it turned on — otherwise they'd
    // get archival points they never asked for, and in Diff mode those
    // points would silently drop (DR has no difference flux) making the
    // file subtly inconsistent with the plot.
    if (chart.$lcDrShown) emit("ztf_dr", chart.$lcDrBands);

    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${oid}_lightcurve_${filenameTimestamp()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke on next tick so the browser has had a chance to start the
    // download stream before the blob URL is freed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function bindDownloadButton(btn) {
    if (btn.dataset.lcDownloadBound === "1") return;
    btn.dataset.lcDownloadBound = "1";
    btn.addEventListener("click", () => {
      const canvas = document.getElementById(btn.dataset.target);
      const chart = canvas ? charts.get(canvas) : null;
      if (!chart) return;
      downloadLcData(chart, btn.dataset.oid || "");
    });
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
    scope.querySelectorAll(".lc-overlay-select").forEach(bindOverlaySelect);
    scope.querySelectorAll(".lc-download-btn").forEach(bindDownloadButton);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.lightcurve-canvas").forEach(initCanvas);
    initToggles(root);
  }

  // Public hooks for sibling modules (periodogram.js). The LC chart owns
  // $lcRaw/$lcFold/$lcPeriod state; these getters/setters let outside
  // code drive the same applyModes path the in-toolbar buttons use.
  window.lcGetChart = function (canvasOrId) {
    const c = (typeof canvasOrId === "string")
      ? document.getElementById(canvasOrId)
      : canvasOrId;
    return c ? charts.get(c) : null;
  };
  // Replace the chart's bands + fpBands with a freshly-shaped LC bundle
  // (from /htmx/lc_fp). Used after the deferred FP fetch lands, since
  // the synchronous render path serves detections-only data. The bundle
  // must be the same shape as `data-lc` on the canvas (shape_lightcurve
  // output). We also re-derive the buckets `applyModes` reads
  // (raw.bands / raw.fpBands), preserving any chart state the user has
  // toggled in the meantime (z, ebv, mode, source, fold, overlay).
  window.lcSetBundle = function (canvasId, bundle) {
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    if (!chart || !bundle || typeof bundle !== "object") return;
    chart.$lcRaw = {
      bands: bundle.bands || [],
      fpBands: bundle.forced_phot_bands || [],
    };
    applyModes(chart);
  };

  // Splice the matched cross-survey LC into the chart. Payload is the same
  // `shape_lightcurve` envelope the primary uses, plus `oid` (the matched
  // OID on the other survey) which we stash on the chart so a future
  // "open this on the other survey" affordance can read it back.
  // Tolerant: empty bundle / wrong-shape / null all leave the chart alone.
  // Also surfaces the matched OID in the Basic Information panel as a
  // clickable link — a full navigation to /?survey=<other>&oid=<other oid>
  // re-runs the explorer for that survey, so the user can drill into the
  // counterpart without copy-pasting the OID by hand.
  window.lcSetCrossSurvey = function (canvasId, bundle) {
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    if (!chart || !bundle || typeof bundle !== "object") return;
    const survey = bundle.survey;
    if (survey !== "lsst" && survey !== "ztf") return;
    chart.$lcXRaw = {
      survey,
      bands: bundle.bands || [],
      fpBands: bundle.forced_phot_bands || [],
    };
    chart.$lcXOid = bundle.oid || null;
    applyModes(chart);
    // Basic-info placeholder lives in a sibling panel of the LC; safe to
    // skip silently if the panel isn't in the DOM (e.g. listing view) or if
    // the placeholder is wired to a different OID (stale fragment during a
    // swap — don't smear the wrong cross-match onto the new object).
    if (bundle.oid) {
      const slot = document.getElementById("basic-info-xsurvey");
      const oid = canvasId.replace(/^lc-canvas-/, "");
      if (slot && slot.dataset.oid === oid) {
        const otherLabel = surveyLabel(survey);
        const url = `/?survey=${encodeURIComponent(survey)}&oid=${encodeURIComponent(bundle.oid)}`;
        const safeOid = String(bundle.oid).replace(/[&<>"']/g, (c) => (
          { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
        ));
        slot.innerHTML =
          `<span class="tw-text-text-secondary">Matched on ${otherLabel}:</span> ` +
          `<a class="mono tw-text-accent hover:tw-underline" ` +
              `href="${url}" ` +
              `title="Open this counterpart on ${otherLabel} in a new explorer view.">` +
          `${safeOid}</a>`;
        slot.classList.remove("tw-hidden");
      }
    }
  };

  // Reveal + populate the Fold button and the parametric-overlay picker
  // from the deferred /htmx/lc_features response. `features` shape:
  //   { multiband_period: number|null, parametric_fits: {spm,fleet,tde} }
  window.lcSetFeatures = function (canvasId, features) {
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    if (!chart || !features || typeof features !== "object") return;
    const period = features.multiband_period;
    if (period && period > 0) {
      const foldBtn = document.querySelector(
        `.lc-fold-toggle[data-target="${canvasId}"]`,
      );
      if (foldBtn) {
        foldBtn.dataset.lcPeriod = String(period);
        foldBtn.classList.remove("tw-hidden");
        foldBtn.title =
          `Click to fold the light curve at the multiband period (${
            period.toPrecision(7)
          } d) from the feature table. Two cycles are shown side-by-side.`;
      }
      chart.$lcPeriod = period;
      // Honor a restored fold intent that we couldn't satisfy at first
      // paint because the period wasn't known yet.
      if (chart.$lcFoldRestoreIntent && chart.$lcFold !== "fold") {
        chart.$lcFold = "fold";
        if (foldBtn) foldBtn.dataset.lcFold = "fold";
      }
    }
    const fits = (features.parametric_fits && typeof features.parametric_fits === "object")
      ? features.parametric_fits : {};
    chart.$lcFits = fits;
    const oid = canvasId.replace(/^lc-canvas-/, "");
    const overlayWrap = document.getElementById(`lc-overlay-wrap-${oid}`);
    if (overlayWrap && (fits.spm || fits.fleet || fits.tde)) {
      overlayWrap.classList.remove("tw-hidden");
      const sel = overlayWrap.querySelector(".lc-overlay-select");
      if (sel) {
        for (const opt of sel.options) {
          if (opt.value === "none") continue;
          opt.disabled = !fits[opt.value];
        }
        // Restore overlay choice from URL if the corresponding fit now
        // exists. Same gating logic initCanvas would have applied if it
        // had this data at first paint.
        const intent = chart.$lcOverlayRestoreIntent;
        if (intent && fits[intent] && chart.$lcOverlay !== intent) {
          chart.$lcOverlay = intent;
          sel.value = intent;
        }
      }
    }
    applyModes(chart);
  };

  // Apply ra/dec from the deferred /htmx/lc_info response: stamp them on
  // the canvas (so existing readers via canvas.dataset still work), reveal
  // the ZTF DR control, and kick off the same dust-proxy fetch the
  // synchronous render path used to do at initCanvas time.
  window.lcSetCoords = function (canvasId, ra, dec) {
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    if (!canvas) return;
    if (!(isFinite(ra) && isFinite(dec))) return;
    canvas.dataset.ra = String(ra);
    canvas.dataset.dec = String(dec);
    const oid = canvasId.replace(/^lc-canvas-/, "");
    // Reveal + stamp the ZTF DR overlay control. data-ra/data-dec on the
    // button itself is what the existing DR-toggle handler reads.
    const drWrap = document.getElementById(`lc-dr-wrap-${oid}`);
    if (drWrap) {
      drWrap.classList.remove("tw-hidden");
      const drBtn = drWrap.querySelector(".lc-dr-toggle");
      if (drBtn) {
        drBtn.dataset.ra = String(ra);
        drBtn.dataset.dec = String(dec);
      }
    }
    // Kick the dust-proxy fetch (same logic as initCanvas — we only fill
    // when the input is still empty, so a manually-typed override or a
    // pre-existing fetch can't be clobbered).
    const ebvInput = document.querySelector(
      `.lc-ebv-input[data-target="${canvasId}"]`,
    );
    if (chart && window.dust && ebvInput && !ebvInput.value) {
      window.dust.fetchEBV(ra, dec).then((res) => {
        if (!res || !(res.ebv > 0)) return;
        if (ebvInput.value) return;
        ebvInput.value = res.ebv.toFixed(4);
        ebvInput.title = `SF11=${(res.ebv_sf11 ?? NaN).toFixed(4)} · SFD98=${(res.ebv_sfd98 ?? NaN).toFixed(4)}`;
        ebvInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  };

  // Hide the deferred-load status strip once every pending loader has
  // swapped in. We detect "still pending" by looking for any descendant
  // that htmx hasn't replaced yet (the originals carry hx-trigger="load");
  // when none remain, we collapse the whole strip so the chart's flex-1
  // container reclaims the vertical space.
  window.lcMaybeHideLoadingStrip = function (oid) {
    const strip = document.getElementById("lc-loading-status-" + oid);
    if (!strip) return;
    if (strip.querySelector('[hx-trigger~="load"]')) return;
    strip.style.display = "none";
  };

  window.lcSetFoldPeriod = function (canvasId, period) {
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    if (!chart) return;
    if (period && period > 0) {
      chart.$lcPeriod = period;
      chart.$lcFold = "fold";
    } else {
      chart.$lcFold = "off";
    }
    applyModes(chart);
    cacheAndPushLcState(chart);
    // Keep the Fold button (when present) in sync with the actual state.
    // Without this, the next click on Fold would advance from a stale
    // dataset value and look like a no-op to the user.
    const foldBtn = document.querySelector(`.lc-fold-toggle[data-target="${canvasId}"]`);
    if (foldBtn) {
      foldBtn.dataset.lcFold = chart.$lcFold;
      if (period && period > 0) foldBtn.dataset.lcPeriod = String(period);
    }
  };

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
