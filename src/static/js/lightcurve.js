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

  // Frequency ordering used by the per-band Offset toggle. Bands missing from
  // this table get rank 0 (no spread term — only the centering subtraction
  // applies). LSST's "y" arrives lowercase from the server; tolerate "Y" too
  // in case a future survey uses the upper-case convention.
  const BAND_RANK = { u: 0, g: 1, r: 2, i: 3, z: 4, y: 5, Y: 5 };

  const AB_ZP_NJY = 31.4;
  const LN10_OVER_2P5 = Math.log(10) / 2.5;

  // Faint-end cap for the y-axis in mag mode (mag, not flux). LSST's limiting
  // magnitude is ~26, and ZTF's is brighter still — anything fainter than this
  // is dominated by error-bar noise rather than signal. Without this, a single
  // low-SNR point with a multi-mag error bar can push the axis out to 32+.
  const MAG_AXIS_FAINT_CAP = 28;

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
  // Overlay is deliberately NOT persisted (neither URL nor cross-object cache):
  // it always starts "none" on each object so navigating through many objects
  // never auto-triggers an expensive fit (e.g. the GP) per object.
  const LC_DEFAULTS = {
    mode: "flux", source: "diff", abs: "app", dered: "obs", fold: "off",
    drShown: false, drAlpha: 0.10,
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
      Math.abs(state.drAlpha - LC_DEFAULTS.drAlpha) < 1e-6;
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
      // overlay intentionally omitted — see LC_DEFAULTS: it must not survive
      // navigation, so each object starts with the overlay off.
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
    // Overlay is not a URL param; strip any stale lc_overlay from older links.
    url.searchParams.delete("lc_overlay");
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
  function projectPoint(p, axisMode, sourceMode, distMod, extMag, offsetMag) {
    const flux = sourceMode === "sci" ? p.sci_flux : p.flux;
    const eFlux = sourceMode === "sci" ? p.e_sci_flux : p.e_flux;
    if (flux == null) return null;
    const A = extMag || 0;
    const mu = distMod || 0;
    // Per-band Offset toggle: m_new = m_old + Δ in mag space; equivalent
    // multiplicative 10^(−0.4·Δ) in flux space (errors scale by the same
    // factor so SNR is preserved). 0 = no shift.
    const dMag = offsetMag || 0;
    if (axisMode === "mag") {
      if (flux <= 0) return null;
      const mag = AB_ZP_NJY - 2.5 * Math.log10(flux) - A - mu + dMag;
      // Representative ± for the tooltip (small-error approximation).
      const e = eFlux != null && eFlux > 0 ? eFlux / flux / LN10_OVER_2P5 : null;
      let yLo = null, yHi = null;
      if (eFlux != null && eFlux > 0) {
        // Bright side: flux + e → smaller mag (finite as long as flux>0).
        yLo = AB_ZP_NJY - 2.5 * Math.log10(flux + eFlux) - A - mu + dMag;
        // Faint side: flux − e → larger mag, +∞ when non-positive.
        const fluxLo = flux - eFlux;
        yHi = fluxLo > 0
          ? AB_ZP_NJY - 2.5 * Math.log10(fluxLo) - A - mu + dMag
          : Infinity;
      }
      // `mjd` rides alongside `x` so the tooltip can format a UTC date
      // even in fold mode (where x becomes phase). foldDataset spreads
      // every field through, so this just needs to be added once here.
      return { x: p.mjd, y: mag, e, yLo, yHi, mjd: p.mjd, identifier: p.identifier, has_stamp: p.has_stamp };
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
    if (dMag !== 0) {
      const scaleO = Math.pow(10, -0.4 * dMag);
      y *= scaleO;
      if (e != null) e *= scaleO;
    }
    const yLo = e != null ? y - e : null;
    const yHi = e != null ? y + e : null;
    return { x: p.mjd, y, e, yLo, yHi, mjd: p.mjd, identifier: p.identifier, has_stamp: p.has_stamp };
  }

  // MJD → UTC ISO date for the tooltip. MJD 40587 = 1970-01-01T00:00:00 UTC,
  // so unix-seconds = (mjd - 40587) * 86400. Truncates to whole-second
  // precision so the tooltip stays compact ("YYYY-MM-DD HH:MM:SS UTC").
  // Non-finite / pre-1858 inputs return an empty string.
  //
  // `survey` selects the source time scale: LSST alerts carry
  // `midpointMjdTai` (atomic time, currently UTC + 37 s) so we must subtract
  // the offset before treating the seconds as a UTC instant. ZTF MJDs are
  // already UTC. See community.lsst.org thread "Question about
  // midpointMjdTai to UTC conversion in recent Rubin alerts" — multiple
  // brokers initially shipped the unconverted TAI string.
  const MJD_UNIX_EPOCH = 40587;
  const TAI_MINUS_UTC_SECONDS = 37; // since 2017-01-01; bump on next leap second
  function mjdToUtcString(mjd, survey) {
    if (!isFinite(mjd)) return "";
    let seconds = (mjd - MJD_UNIX_EPOCH) * 86400;
    if (survey === "lsst") seconds -= TAI_MINUS_UTC_SECONDS;
    const ms = seconds * 1000;
    if (!isFinite(ms)) return "";
    const d = new Date(ms);
    const iso = d.toISOString(); // "YYYY-MM-DDTHH:MM:SS.sssZ"
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
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
  const OVERLAY_DASH = { spm: [6, 4], fleet: [2, 3], tde: [5, 2, 1, 2], gp: [] };

  // Convert a model magnitude into whatever the axis expects, applying the
  // same distMod + extinction + band-offset corrections `projectPoint`
  // applies to detections. Returns null when the projection would need
  // log of a non-positive number.
  function projectModel(mag, axisMode, distMod, extMag, offsetMag) {
    if (!isFinite(mag)) return null;
    const A = extMag || 0;
    const mu = distMod || 0;
    const dMag = offsetMag || 0;
    if (axisMode === "mag") return mag - A - mu + dMag;
    // Flux path: mag → flux (nJy) and then apply the A + μ + offset scalings.
    const flux = Math.pow(10, (AB_ZP_NJY - mag) / 2.5);
    const scale = Math.pow(10, 0.4 * (A + mu - dMag));
    return flux * scale;
  }

  // Flux-input sibling of projectModel for the GP overlay, which carries its
  // posterior in difference-flux (nJy) rather than as a magnitude. Applies the
  // exact same A + μ + offset corrections as `projectPoint`'s flux/mag paths,
  // so the GP curves track the detections through every toggle. Difference
  // flux can be ≤ 0 (a fade below the reference); in mag mode such points have
  // no magnitude and become gaps, while in flux mode they're kept as-is.
  function projectFluxModel(flux, axisMode, distMod, extMag, offsetMag) {
    if (!isFinite(flux)) return null;
    const A = extMag || 0;
    const mu = distMod || 0;
    const dMag = offsetMag || 0;
    if (axisMode === "mag") {
      if (!(flux > 0)) return null;
      return AB_ZP_NJY - 2.5 * Math.log10(flux) - A - mu + dMag;
    }
    return flux * Math.pow(10, 0.4 * (A + mu - dMag));
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
  function projectOverlayGrid(gridMags, bandName, axisMode, distMod, extByBand, foldPeriod, offsetMag) {
    const extMag = (extByBand || {})[bandName] || 0;
    const pts = gridMags
      .map(({ mjd, mag }) => {
        const y = projectModel(mag, axisMode, distMod, extMag, offsetMag);
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

  function computeSPMTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod, offsetFor) {
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
      const pts = projectOverlayGrid(grid, band, axisMode, distMod, extByBand, foldPeriod, offsetFor(band));
      if (pts.length) {
        const ds = makeOverlayDataset("spm", band, pts);
        ds.$band = band;
        traces.push(ds);
      }
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

  function computeFleetTraces(fits, bands, fpBands, axisMode, distMod, extByBand, foldPeriod, offsetFor) {
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
      const pts = projectOverlayGrid(grid, band, axisMode, distMod, extByBand, foldPeriod, offsetFor(band));
      if (pts.length) {
        const ds = makeOverlayDataset("fleet", band, pts);
        ds.$band = band;
        traces.push(ds);
      }
    }
    return traces;
  }

  // TDE tail model: mag(t) = mag0 + decay · 2.5 · log10(t - t_peak + 40).
  // t_peak is data-derived (not stored): brightest detection in-band passing
  // e_mag < 1.0 and mag < 30, matching the extractor. We only have fluxes in
  // the client, so we derive mag/e_mag from flux/eFlux (ZP 31.4 in nJy).
  function computeTDETailTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod, offsetFor) {
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
      const pts = projectOverlayGrid(grid, band, axisMode, distMod, extByBand, foldPeriod, offsetFor(band));
      if (pts.length) {
        const ds = makeOverlayDataset("tde", band, pts);
        ds.$band = band;
        traces.push(ds);
      }
    }
    return traces;
  }

  // ── Multi-band Gaussian-Process overlay ───────────────────────────────────
  //
  // The GP posterior comes from the server (/htmx/lc_gp → lcSetGp) as a per-
  // band flux grid {survey, band, lambda_eff, mjd[], flux_mean[], flux_std[]}
  // in difference-flux nJy. Here we re-project each band through the active
  // Flux/Mag · App/Abs · Obs/Der · Fold state — exactly like the parametric
  // overlays — and emit a solid mean line plus a translucent ±2σ band.
  //
  // Each GP band is its own legend entry ("GP g", "GP r", …) under the overlay
  // header, so a specific band can be shown/hidden on its own — just like the
  // per-band SPM/FLEET/TDE entries. The mean line carries `$gp` and appears in
  // the legend; its ±2σ envelope edges also carry `$gpHelper` and are kept out
  // of the legend (the legend's onClick toggles them together with the mean).
  // Visibility survives mode toggles via the (survey, kind, label) snapshot,
  // and GP bands are NOT coupled to the detection legend — they're independent.
  const GP_BAND_ALPHA = "33"; // ~20% — appended to the 6-digit hex band color.

  // Project a band's flux grid to chart-y, keeping x (MJD or phase) and index
  // alignment — invalid points (e.g. a mag of non-positive flux) become null
  // so the mean line and the two envelope edges stay the same length and
  // Chart.js's fill-between lines up. `xArr` is already MJD (time fit) or
  // phase ∈ [0,1] (folded fit); no client-side folding happens here.
  function gpProjectFlux(fluxArr, xArr, axisMode, distMod, extMag, offsetMag) {
    const pts = new Array(fluxArr.length);
    for (let i = 0; i < fluxArr.length; i++) {
      const y = projectFluxModel(fluxArr[i], axisMode, distMod, extMag, offsetMag);
      pts[i] = { x: xArr[i], y: y == null || !isFinite(y) ? null : y };
    }
    return pts;
  }

  // For a folded (phase) fit, repeat the [0,1] grid at [1,2] so the curve
  // spans the two cycles the folded chart shows. No-op for a time fit.
  function gpCycles(pts, folded) {
    if (!folded) return pts;
    return pts.concat(pts.map((p) => ({ x: p.x + 1, y: p.y })));
  }

  function computeGPTraces(chart, axisMode, distMod, extByBand, foldPeriod, offsetFor) {
    const gp = chart.$lcGp;
    if (!gp || !gp.available || !Array.isArray(gp.grid)) return [];
    // The live fit must match the chart's current fold state AND period: a
    // phase fit only belongs on the folded axis, and a fit for an old period
    // is stale once the user picks a new one. On a mismatch draw nothing and
    // wait for ensureGpLoaded to fetch the right variant — spinner meanwhile.
    if (chart.$lcGpKey !== gpDesiredKey(chart)) return [];
    const folded = !!gp.folded;
    // Group all GP curves under the primary survey's overlay header (a pooled
    // band has no single survey), matching how SPM/FLEET/TDE present.
    const survey = chart.$lcSurvey || "";
    const traces = [];
    for (const g of gp.grid) {
      const band = g.band || "";
      const extMag = (extByBand || {})[band] || 0;
      const offsetMag = offsetFor(band);
      const color = BAND_COLORS[band] || BAND_COLORS.unknown;
      const mean = gpCycles(
        gpProjectFlux(g.flux_mean, g.mjd, axisMode, distMod, extMag, offsetMag), folded);
      if (!mean.some((p) => p.y != null)) continue;
      // ±2σ envelope as a filled band between two edge datasets — shown folded
      // too, since the phase-space fit makes it meaningful (not a smeared time
      // curve).
      const n = g.flux_mean.length;
      const lo = new Array(n), hi = new Array(n);
      for (let i = 0; i < n; i++) {
        const s = (g.flux_std[i] || 0) * 2;
        lo[i] = g.flux_mean[i] - s;
        hi[i] = g.flux_mean[i] + s;
      }
      const loPts = gpCycles(
        gpProjectFlux(lo, g.mjd, axisMode, distMod, extMag, offsetMag), folded);
      const hiPts = gpCycles(
        gpProjectFlux(hi, g.mjd, axisMode, distMod, extMag, offsetMag), folded);
      // Order matters: the upper edge fills to the dataset immediately before
      // it (fill: '-1'), which must be the lower edge.
      traces.push(makeGpEdgeDataset(survey, band, loPts, color, false));
      traces.push(makeGpEdgeDataset(survey, band, hiPts, color, true));
      traces.push(makeGpMeanDataset(survey, band, mean, color));
    }
    return traces;
  }

  function makeGpMeanDataset(survey, band, points, color) {
    return {
      label: `GP ${band}`,
      $survey: survey,
      $kind: "overlay",
      $band: band,
      $gp: true,
      data: points,
      borderColor: color,
      backgroundColor: "transparent",
      borderWidth: 1.75,
      borderDash: OVERLAY_DASH.gp,
      showLine: true,
      spanGaps: false,
      pointRadius: 0,
      pointHoverRadius: 0,
      order: 2,
    };
  }

  function makeGpEdgeDataset(survey, band, points, color, isUpper) {
    return {
      label: `GP ${band} ${isUpper ? "+2σ" : "−2σ"}`,
      $survey: survey,
      $kind: "overlay",
      $band: band,
      $gp: true,
      $gpHelper: true,
      data: points,
      borderColor: "transparent",
      backgroundColor: color + GP_BAND_ALPHA,
      borderWidth: 0,
      // Upper edge fills down to the lower edge (the dataset just before it);
      // the lower edge fills nothing.
      fill: isUpper ? "-1" : false,
      showLine: true,
      spanGaps: false,
      pointRadius: 0,
      pointHoverRadius: 0,
      order: 3, // behind the mean line + detections
    };
  }

  function buildOverlayDatasets(chart, axisMode, distMod, extByBand, foldPeriod, offsetMap, visibility) {
    const fits = chart.$lcFits;
    const key = chart.$lcOverlay;
    if (!key || key === "none") return [];
    if (key !== "gp" && !fits) return [];
    const bands = (chart.$lcRaw && chart.$lcRaw.bands) || [];
    const fpBands = (chart.$lcRaw && chart.$lcRaw.fpBands) || [];
    // Offset is keyed by band letter (a g overlay gets the same Δ as a g
    // detection on either survey). Falls back to 0 when Offset is off or
    // the band has no entry.
    const survey = chart.$lcSurvey || "";
    const offsetFor = (band) => (offsetMap && offsetMap.get(band)) || 0;
    let traces = [];
    if (key === "spm") traces = computeSPMTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod, offsetFor);
    else if (key === "fleet") traces = computeFleetTraces(fits, bands, fpBands, axisMode, distMod, extByBand, foldPeriod, offsetFor);
    else if (key === "tde") traces = computeTDETailTraces(fits, bands, axisMode, distMod, extByBand, foldPeriod, offsetFor);
    else if (key === "gp") traces = computeGPTraces(chart, axisMode, distMod, extByBand, foldPeriod, offsetFor);
    // Stamp survey + kind so the legend grouper places overlays under the
    // right survey's header. The parametric overlays derive from the primary
    // survey's features; GP traces already carry their own $survey (cross-
    // survey ZTF curves keep their survey under an LSST primary), so don't
    // clobber it.
    for (const t of traces) {
      if (!t.$survey) t.$survey = survey;
      if (!t.$kind) t.$kind = "overlay";
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
    // GP info comes from the fitted hyperparameters, not a per-band param
    // table. Show the kernel's two length scales (time + wavelength), the
    // amplitude, and the learned jitter, plus the data size that fed the fit.
    if (key === "gp") {
      // Folded GP is only defined in Sci mode (it fits the science light
      // curve) — nudge the user there instead of showing a stale/empty strip.
      if (chart.$lcFold === "fold" && chart.$lcPeriod > 0 && chart.$lcSource !== "sci") {
        strip.innerHTML =
          `GP&nbsp;&nbsp;<span style="color:#888">folding needs Sci flux mode — switch Diff→Sci</span>`;
        strip.classList.remove("tw-hidden");
        return;
      }
      const gp = chart.$lcGp;
      const hp = gp && gp.hyperparams;
      if (!gp || !gp.available || !hp || chart.$lcGpKey !== gpDesiredKey(chart)) {
        strip.classList.add("tw-hidden");
        strip.innerHTML = "";
        return;
      }
      const fmt = (v, d) => (v != null && isFinite(v) ? Number(v).toPrecision(d) : "—");
      // When folded the fit is in phase space: the time length scale is in
      // cycles, not days. σ_f / jitter are dimensionless (standardized units):
      // a fraction of each band's own scatter in sci/folded mode (per-band
      // standardization), or of the pooled global scale in diff mode (all bands
      // zero-anchored and divided by one scale — see services/gp.py).
      const lt = gp.folded
        ? `ℓ<sub>φ</sub>=<b>${fmt(hp.l_t_days, 3)}</b> cyc`
        : `ℓ<sub>t</sub>=<b>${fmt(hp.l_t_days, 3)}</b> d`;
      const parts = [
        lt,
        `ℓ<sub>λ</sub>=<b>${fmt(hp.l_lambda_kA, 3)}</b> kÅ`,
        `σ<sub>f</sub>=<b>${fmt(hp.sigma_f, 2)}</b>`,
        `jitter=<b>${fmt(hp.jitter, 2)}</b>`,
      ];
      const flux = gp.science ? "sci flux" : "diff flux";
      const tag = gp.folded
        ? `folded P=${fmt(gp.period, 6)} d · ${flux} · ${gp.n_points} det`
        : `${flux} · ${gp.n_points} det, ${gp.n_bands} bands`;
      strip.innerHTML =
        `GP&nbsp;&nbsp;${parts.join("&nbsp;&nbsp;")}` +
        `&nbsp;&nbsp;<span style="color:#888">(${tag})</span>`;
      strip.classList.remove("tw-hidden");
      return;
    }
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

  function buildDatasets(bands, fpBands, drBands, axisMode, sourceMode, distMod, extByBand, drAlpha, foldPeriod, survey, offsetMap) {
    const extFor = (name) => (extByBand || {})[name] || 0;
    const offsetFor = (name) =>
      (offsetMap && offsetMap.get(name)) || 0;
    const project = (band) => {
      const dMag = offsetFor(band.name);
      const rows = band.points
        .map((p) => projectPoint(p, axisMode, sourceMode, distMod, extFor(band.name), dMag))
        .filter(Boolean);
      return foldPeriod ? foldDataset(rows, foldPeriod) : rows;
    };
    const detStyle = pointStyleFor(survey);
    const det = bands.map((b) => ({
      label: b.name,
      $survey: survey,
      $kind: "det",
      $band: b.name,
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
    // ZTF FP triangles are rotated 180° (apex-down) so the survey is also
    // legible at a glance for forced photometry — LSST FP stays apex-up,
    // ZTF FP is the inverted variant. FP rows don't carry a stamp
    // identifier, so clicks on them are no-ops.
    const fpRotation = survey === "ztf" ? 180 : 0;
    const fp = (fpBands || []).map((b) => ({
      label: `${b.name} (FP)`,
      $survey: survey,
      $kind: "fp",
      $band: b.name,
      data: project(b),
      backgroundColor: "transparent",
      borderColor: BAND_COLORS[b.name] || BAND_COLORS.unknown,
      borderWidth: 1,
      pointStyle: "triangle",
      rotation: fpRotation,
      showLine: false,
      pointRadius: 3,
      pointHoverRadius: 5,
    }));
    // DR points are archival science-only photometry; carry no flux (diff),
    // so projectPoint filters them out in Diff mode automatically. Rendered
    // as small *open* squares in the band color so they're visually
    // distinct from both detections (filled survey shape) and forced
    // photometry (open triangles); the alpha modulates the border
    // opacity so the user can tone the DR cloud up/down without
    // re-fetching. A negative draw-order keeps det + FP on top of a
    // dense DR crossmatch.
    const alpha = (typeof drAlpha === "number" && isFinite(drAlpha)) ? drAlpha : 0.10;
    const dr = (drBands || []).map((b) => {
      const base = BAND_COLORS[b.name] || BAND_COLORS.unknown;
      return {
        label: `${b.name} (DR)`,
        // ZTF DR is always sourced from the ZTF data release, even on LSST
        // detail views (where the DR cone-search is the only path to a
        // pre-LSST archival history). Tagging $survey: "ztf" fixes the
        // legend header ("ZTF DR:" instead of "LSST DR:"), routes the
        // tooltip MJD→UTC through the ZTF (UTC) scale rather than LSST
        // (TAI), and keeps point styling consistent with the rest of the
        // ZTF series.
        $survey: "ztf",
        $kind: "dr",
        $band: b.name,
        data: project(b),
        // Hollow square: transparent fill + alpha-tinted border. The
        // border alpha lets the user fade the DR overlay via the slider
        // without touching the marker shape itself.
        backgroundColor: "transparent",
        borderColor: withAlpha(base, alpha),
        borderWidth: 1,
        pointStyle: "rect",
        showLine: false,
        pointRadius: 2.5,
        pointHoverRadius: 4,
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

  // ── Per-band Offset (visual band separation) ─────────────────────────────
  //
  // Builds a Map keyed by band letter → Δ_b (mag, rounded to 0.1) used by
  // buildDatasets / buildOverlayDatasets to separate bands on the Y axis
  // without losing the absolute scale (centering removes the band's typical
  // magnitude; rank × step adds a deterministic per-band shift).
  //
  // The map key is the band name alone — LSST g and ZTF g share the same
  // Δ, and so do detections, forced photometry, DR, and overlay traces of
  // that band. The centering statistic pools magnitudes from detections +
  // FP across both surveys (DR stays out so toggling it on/off doesn't
  // shift the centering of the rest of the chart).
  function statOf(values, kind) {
    if (!values.length) return 0;
    if (kind === "max") return Math.max(...values);
    if (kind === "min") return Math.min(...values);
    if (kind === "mean") {
      let s = 0;
      for (const v of values) s += v;
      return s / values.length;
    }
    // median (default): O(n log n) is plenty for the band sizes we plot.
    const sorted = values.slice().sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : 0.5 * (sorted[m - 1] + sorted[m]);
  }

  // Mags for the centering pool must mirror what projectPoint will actually
  // display: pick sci_flux when Sci mode is on, and subtract per-band A_λ
  // when Der is on. distMod is a single scalar applied to every band so it
  // cancels out of the mean-subtraction step and is intentionally not
  // applied here. Without this, the centering would be computed from a
  // different projection than the one shown on screen — bands aligned in
  // Diff would scatter back the moment the user toggled to Sci, and Der
  // toggles would re-skew the centering when the user expects them to be
  // a band-uniform shift.
  function magsOfBand(band, sourceMode, extMag) {
    const out = [];
    const A = extMag || 0;
    for (const p of band.points || []) {
      const flux = sourceMode === "sci" ? p.sci_flux : p.flux;
      if (!(flux > 0)) continue;
      out.push(AB_ZP_NJY - 2.5 * Math.log10(flux) - A);
    }
    return out;
  }

  function computeOffsetMap(chart, sourceMode, extByBand) {
    if (chart.$lcOffset !== "on") return new Map();
    const center = chart.$lcOffsetCenter || "median";
    const step = isFinite(chart.$lcOffsetStep) ? chart.$lcOffsetStep : 0;
    const out = new Map();
    // Pool magnitudes by band letter across both surveys and across det + FP
    // so a g band gets one Δ regardless of where the photometry came from.
    const pool = new Map();  // band → number[]
    const addBands = (bands) => {
      for (const b of bands || []) {
        const mags = magsOfBand(b, sourceMode, (extByBand || {})[b.name] || 0);
        if (!mags.length) continue;
        if (!pool.has(b.name)) pool.set(b.name, []);
        const arr = pool.get(b.name);
        for (const m of mags) arr.push(m);
      }
    };
    if (chart.$lcRaw) {
      addBands(chart.$lcRaw.bands);
      addBands(chart.$lcRaw.fpBands);
    }
    if (chart.$lcXRaw) {
      addBands(chart.$lcXRaw.bands);
      addBands(chart.$lcXRaw.fpBands);
    }
    if (!pool.size) return out;
    // Pass 1: raw per-band shift = −C_b − step × rank_b. The rank term is
    // *subtracted*: in mag mode the axis is reversed (brighter = up), so a
    // negative Δ for higher-rank bands pushes them upward — matching the
    // intuition that clicking ^ should move the redder bands up. In flux
    // mode the multiplicative factor 10^(−0.4·Δ) grows for negative Δ, so
    // higher-rank bands also move up. step is clamped to [0, ∞) by the
    // stepper bindings so this term only ever spreads, never compresses.
    const raws = [];
    for (const [band, mags] of pool) {
      const C = statOf(mags, center);
      const rank = BAND_RANK[band] != null ? BAND_RANK[band] : 0;
      raws.push({ band, raw: -C - step * rank });
    }
    // Pass 2: subtract the mean across all bands. A constant added to every
    // Δ_b just translates the whole chart vertically without separating the
    // bands, so removing it keeps the legend numbers as small as possible
    // (and centred on zero) while the visual separation is identical.
    let sum = 0;
    for (const r of raws) sum += r.raw;
    const meanRaw = sum / raws.length;
    for (const { band, raw } of raws) {
      // Round the *displayed* total to 0.1 mag so the legend value is what
      // actually got applied to the points.
      out.set(band, Math.round((raw - meanRaw) * 10) / 10);
    }
    return out;
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

  // Custom-event hooks for downstream panels (e.g. position residuals)
  // that derive from this chart's `$lcRaw` / `$lcXRaw` and the LC legend's
  // visibility. Two distinct events so consumers can do the cheap thing
  // when only the visible subset shifted (`lc:visibilityChanged`) vs the
  // full rebuild needed when bands themselves arrive or change
  // (`lc:dataChanged`). Both carry the canvas id in detail so multi-LC
  // pages (none today) can disambiguate.
  function emitVisibilityChanged(chart) {
    const id = chart && chart.canvas ? chart.canvas.id : null;
    document.dispatchEvent(new CustomEvent("lc:visibilityChanged", {
      detail: { canvasId: id },
    }));
  }

  function emitDataChanged(chart) {
    const id = chart && chart.canvas ? chart.canvas.id : null;
    document.dispatchEvent(new CustomEvent("lc:dataChanged", {
      detail: { canvasId: id },
    }));
  }

  // "GP is selected as the overlay AND the live bundle matches the desired
  // variant" — the signal the color-evolution panel uses to decide whether to
  // draw colors. overlaySelected alone (GP picked, fetch maybe in flight) drives
  // whether the panel seizes the residuals cell, so the panel stays put during
  // a Diff↔Sci / fold variant swap instead of flickering back to residuals.
  function gpReadyFor(chart) {
    return !!(chart && chart.$lcOverlay === "gp" && chart.$lcGp &&
              chart.$lcGpKey === gpDesiredKey(chart));
  }

  function emitGpChanged(chart) {
    const id = chart && chart.canvas ? chart.canvas.id : null;
    document.dispatchEvent(new CustomEvent("lc:gpChanged", {
      detail: {
        canvasId: id,
        overlaySelected: !!(chart && chart.$lcOverlay === "gp"),
        gpReady: gpReadyFor(chart),
      },
    }));
  }

  // Read GP overlay state for a chart by id — consumed by the color-evolution
  // panel and by the periodogram/airmass toggles (to pick the right slot to
  // restore when they close).
  window.lcGpState = function (canvasOrId) {
    const chart = window.lcGetChart ? window.lcGetChart(canvasOrId) : null;
    if (!chart) return { overlaySelected: false, gpReady: false };
    return { overlaySelected: chart.$lcOverlay === "gp", gpReady: gpReadyFor(chart) };
  };
  window.lcGpActive = function (canvasOrId) {
    return window.lcGpState(canvasOrId).overlaySelected;
  };

  // Stable per-dataset key used to remember legend visibility across
  // dataset rebuilds. (survey, kind, label) is invariant under every
  // projection toggle (Flux/Mag, Diff/Sci, App/Abs, Obs/Der, Fold) and
  // also across the deferred FP / cross-survey arrivals — only the
  // projected `data` array changes between rebuilds, never the identity.
  function visibilityKey(ds) {
    return `${ds.$survey || ""}|${ds.$kind || ""}|${ds.label || ""}`;
  }

  function snapshotVisibility(chart) {
    const out = new Map();
    const ds = chart.data && chart.data.datasets;
    if (!ds) return out;
    for (let i = 0; i < ds.length; i++) {
      out.set(visibilityKey(ds[i]), !chart.isDatasetVisible(i));
    }
    return out;
  }

  function applyVisibility(chart, snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    const ds = chart.data.datasets;
    for (let i = 0; i < ds.length; i++) {
      const key = visibilityKey(ds[i]);
      if (snapshot.has(key)) {
        chart.getDatasetMeta(i).hidden = snapshot.get(key);
      }
    }
  }

  function applyModes(chart) {
    const raw = chart.$lcRaw;
    if (!raw) return;
    // Snapshot legend toggles BEFORE we tear the datasets array down — index-
    // keyed `meta.hidden` would otherwise smear onto the wrong rebuilt entry
    // when the layout shifts (overlay armed, FP arrived, DR turned on, etc.).
    const visibility = snapshotVisibility(chart);
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
    // Per-(survey, band) Offset map: empty when the toggle is off, so the
    // 5th projectPoint arg degenerates to 0 and nothing shifts. Stashed on
    // the chart so the legend's generateLabels can read the same Δ values
    // and append " ± X.X" suffixes consistent with what the points show.
    const offsetMap = computeOffsetMap(chart, sourceMode, extByBand);
    chart.$lcOffsetMap = offsetMap;
    const baseDatasets = buildDatasets(
      raw.bands, raw.fpBands, drBands, axisMode, sourceMode, distMod, extByBand,
      chart.$lcDrAlpha, foldPeriod, primarySurvey, offsetMap,
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
          distMod, extByBand, chart.$lcDrAlpha, foldPeriod, xRaw.survey, offsetMap,
        )
      : [];
    const overlayDatasets = buildOverlayDatasets(chart, axisMode, distMod, extByBand, foldPeriod, offsetMap, visibility);
    chart.data.datasets = [...baseDatasets, ...xDatasets, ...overlayDatasets];
    // New entries (e.g. just-arrived FP / xsurvey / freshly-armed overlay)
    // aren't in the snapshot and stay visible by default. Existing keys
    // restore whatever the legend toggled them to before the rebuild.
    applyVisibility(chart, visibility);
    renderOverlayInfo(chart);
    // The overlay picker is always available: the GP option fits the raw light
    // curve directly (no feature-extractor data) and re-projects through fold
    // just like the detections, so — unlike the parametric SPM/FLEET/TDE fits,
    // which the picker only enables once their feature rows arrive — the wrap
    // stays visible in every mode, fold included.
    const foldOverlayOid = chart.canvas.id.replace(/^lc-canvas-/, "");
    const foldOverlayWrap = document.getElementById(`lc-overlay-wrap-${foldOverlayOid}`);
    if (foldOverlayWrap) foldOverlayWrap.classList.remove("tw-hidden");
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
    // Notify the color-evolution panel: a re-projection can change the GP
    // variant (Diff↔Sci, fold) or the dereddening shift the panel applies.
    // Idempotent — the panel only rebuilds when it's the visible cell.
    emitGpChanged(chart);
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
          const ds = chart.data.datasets[datasetIndex];
          const p = ds && ds.data[index];
          if (p?.has_stamp && p.identifier && window.setSelectedIdentifier) {
            // Dispatch by the dataset's $survey so cross-survey clicks
            // (a ZTF point on an LSST view, or vice versa) hit the
            // matching survey's stamp service. The OID switches between
            // the primary (canvas id is `lc-canvas-{oid}`) and the
            // matched cross-survey OID (`chart.$lcXOid`) accordingly.
            const dsSurvey = ds.$survey || chart.$lcSurvey || "";
            const primaryOid = chart.canvas.id.replace(/^lc-canvas-/, "");
            const useOid = (dsSurvey && dsSurvey !== chart.$lcSurvey)
              ? (chart.$lcXOid || primaryOid)
              : primaryOid;
            window.setSelectedIdentifier(p.identifier, dsSurvey, useOid);
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
            title: { display: true, text: "MJD", color: "#a6a6a6" },
            grid: { drawOnChartArea: false, drawTicks: true, tickColor: "#a6a6a6" },
            border: { display: true, color: "#a6a6a6" },
            ticks: { color: "#a6a6a6" },
          },
          y: {
            title: { display: true, text: "Flux (nJy, diff)", color: "#a6a6a6" },
            grid: { drawOnChartArea: false, drawTicks: true, tickColor: "#a6a6a6" },
            border: { display: true, color: "#a6a6a6" },
            ticks: {
              color: "#a6a6a6",
              // Default Chart.js tick formatter rounds the mantissa to a
              // single significant figure for very large / small values
              // (e.g. "1e20" for an absolute flux of 1.18e20 nJy), which
              // makes neighboring ticks indistinguishable. Force scientific
              // notation with one decimal in the mantissa whenever |v|
              // crosses the engineering-notation threshold; mid-range
              // values keep the default locale formatter (compact in mag
              // mode and ordinary flux mode).
              callback(value) {
                if (typeof value !== "number" || !isFinite(value)) return value;
                const abs = Math.abs(value);
                if (abs !== 0 && (abs >= 1e5 || abs < 1e-3)) {
                  // toExponential(1) → "1.2e+20"; strip the redundant "+"
                  // sign on positive exponents to match the user's
                  // expected "1.1e20" form.
                  return value.toExponential(1).replace("e+", "e");
                }
                // Mid-range path: Chart.js's default formatter passes the
                // raw float to Intl.NumberFormat, which faithfully prints
                // IEEE-754 binary noise (e.g. an Abs-mag tick computed as
                // -19.400000000000006 renders as "-19.4000000000006").
                // Round to 7 sig figs and Number() back to drop the
                // trailing zeros — yields "-19.4" / "20.5" / "1000" for
                // the values we actually plot.
                return Number(value.toPrecision(7)).toString();
              },
            },
            // Chart.js auto-fits the y-axis to point `y` values only, which
            // can clip error bars whose lo/hi extends past the brightest /
            // faintest detection. Walk every visible point's projected
            // (yLo, yHi) and widen the data range here so the bars stay
            // inside the plot area. Non-finite caps (open ends in mag mode)
            // are skipped — the errorBarPlugin already paints them as
            // arrows that reach the edge.
            //
            // When the user has defined an arbitrary zoom window (wheel,
            // shift-drag box-zoom, ctrl-drag pan), respect those limits
            // verbatim — extending past them would silently undo the
            // zoom. The errorBarPlugin clips to chartArea so bars that
            // extend outside the zoom window just get cropped, which is
            // the expected behavior.
            afterDataLimits(scale) {
              const ch = scale.chart;
              if (typeof ch.isZoomedOrPanned === "function" && ch.isZoomedOrPanned()) {
                return;
              }
              let lo = scale.min;
              let hi = scale.max;
              ch.data.datasets.forEach((ds, di) => {
                if (!ch.isDatasetVisible(di)) return;
                const data = ds.data || [];
                for (let i = 0; i < data.length; i++) {
                  const p = data[i];
                  if (!p) continue;
                  if (p.yLo != null && isFinite(p.yLo) && p.yLo < lo) lo = p.yLo;
                  if (p.yHi != null && isFinite(p.yHi) && p.yHi > hi) hi = p.yHi;
                }
              });
              if (isFinite(lo)) scale.min = lo;
              if (isFinite(hi)) scale.max = hi;
              // In mag mode, clamp the faint edge to MAG_AXIS_FAINT_CAP so a
              // low-SNR point with a multi-mag error bar can't blow the axis
              // out to 32+. Skip the cap when every point is already fainter
              // than the cap (preserves the chart for an edge-case object whose
              // detections all sit beyond it). The errorBarPlugin paints the
              // clipped end as an open arrow at the chart edge, matching how
              // it already handles non-finite caps from negative-flux points.
              if (ch.$lcMode === "mag"
                  && isFinite(scale.max) && scale.max > MAG_AXIS_FAINT_CAP
                  && isFinite(scale.min) && scale.min < MAG_AXIS_FAINT_CAP) {
                scale.max = MAG_AXIS_FAINT_CAP;
              }
            },
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
              // Group header: toggle every dataset in that (survey, kind)
              // bucket as a unit. "Hide all" wins when any member is
              // currently visible (one click ⇒ everything off); "show all"
              // only when the whole group is already hidden — mirrors
              // Chart.js's per-item toggle semantics, just lifted to the
              // subgroup. $kind being undefined on a header collapses to
              // "all kinds for this survey" (defensive fallback).
              if (legendItem.datasetIndex == null) {
                const survey = legendItem.$survey;
                const kind = legendItem.$kind;
                if (!survey) return;
                const indices = ci.data.datasets
                  .map((ds, i) => {
                    if (ds.$survey !== survey) return -1;
                    if (kind && ds.$kind !== kind) return -1;
                    return i;
                  })
                  .filter((i) => i >= 0);
                if (!indices.length) return;
                const anyVisible = indices.some((i) => ci.isDatasetVisible(i));
                for (const i of indices) {
                  ci.getDatasetMeta(i).hidden = anyVisible ? true : false;
                }
                ci.update();
                emitVisibilityChanged(ci);
                return;
              }
              const idx = legendItem.datasetIndex;
              const ds0 = ci.data.datasets[idx];
              const meta = ci.getDatasetMeta(idx);
              meta.hidden = meta.hidden === null ? !ds0.hidden : null;
              // A GP mean line owns a ±2σ envelope (kept out of the legend);
              // toggle the envelope edges in lockstep so the band follows.
              if (ds0 && ds0.$gp) {
                const nowHidden = meta.hidden === null ? !!ds0.hidden : meta.hidden;
                ci.data.datasets.forEach((d, j) => {
                  if (d.$gpHelper && d.$survey === ds0.$survey && d.$band === ds0.$band) {
                    ci.getDatasetMeta(j).hidden = nowHidden;
                  }
                });
              }
              ci.update();
              emitVisibilityChanged(ci);
            },
            labels: {
              color: "#ededed",
              usePointStyle: true,
              boxWidth: 10,
              generateLabels: (ch) => {
                // Two-level grouping: by survey first, then by kind within
                // each survey. Header form is "<Survey> <kind>:", e.g.
                //   LSST det: u g r i z y · LSST FP: u g r i z y ·
                //   ZTF det: g r i · ZTF FP: g r i
                // The (FP)/(DR) suffixes are stripped from the displayed
                // band labels because the kind is already in the header
                // — keeps each entry to a single character or two.
                //
                // Hidden datasets are dimmed (text + marker recolored to
                // a muted grey) instead of struck-through; we always set
                // `hidden: false` on the legend item to suppress Chart.js's
                // built-in strikethrough, and override fillStyle / strokeStyle
                // / fontColor to signal the disabled state visually.
                //
                // `fontColor` is repeated per item because a custom
                // generateLabels bypasses the global `labels.color` cascade
                // (Chart.js only inherits when it generates the labels
                // itself); without it the survey headers and band names
                // render in the dataset's own color rather than whitish.
                const TEXT = "#ededed";
                const DIMMED = "#555555";
                const KIND_LABEL = { det: "det", fp: "FP", dr: "DR", overlay: "overlay" };
                const KIND_ORDER = ["det", "fp", "dr", "overlay"];
                // Strip the kind suffix from the dataset label since the
                // header already names it. "g (FP)" → "g", "SPM g" → "SPM g".
                const stripSuffix = (text, kind) => {
                  if (kind === "fp") return text.replace(/\s*\(FP\)\s*$/, "");
                  if (kind === "dr") return text.replace(/\s*\(DR\)\s*$/, "");
                  return text;
                };
                // Per-band Offset suffix: " + 0.5" / " − 0.3" / "" when zero
                // or off. Reads from the same map applyModes built and stashed,
                // so the displayed Δ matches what was actually applied to the
                // points. Headers never get a suffix (offset is per-band).
                const offsetMap = ch.$lcOffsetMap;
                const offOn = ch.$lcOffset === "on";
                const offsetSuffix = (ds) => {
                  if (!offOn || !offsetMap) return "";
                  const d = offsetMap.get(ds.$band || "");
                  if (d == null || d === 0) return "";
                  return ` ${d > 0 ? "+" : "−"} ${Math.abs(d).toFixed(1)}`;
                };
                // groups[survey][kind] → [item, …]
                const groups = new Map();
                ch.data.datasets.forEach((ds, i) => {
                  // GP ±2σ envelope edges aren't their own legend rows — they
                  // toggle together with their mean line (see the onClick
                  // handler). The GP mean line itself IS a legend row.
                  if (ds.$gpHelper) return;
                  const survey = ds.$survey || "";
                  const kind = ds.$kind || "other";
                  const realHidden = !ch.isDatasetVisible(i);
                  const fill = realHidden ? DIMMED : ds.backgroundColor;
                  const stroke = realHidden ? DIMMED : ds.borderColor;
                  const fontColor = realHidden ? DIMMED : TEXT;
                  // Parametric-fit overlays (SPM / FLEET / TDE) render as
                  // dashed lines on the chart, not as point markers — the
                  // dataset has pointRadius:0 + showLine:true + borderDash.
                  // Mirror that in the legend with pointStyle:"line" so the
                  // swatch shows the matching dash pattern instead of an
                  // empty square (which read as "no marker style" rather
                  // than "model curve" for overlay rows).
                  const isOverlay = kind === "overlay";
                  if (!groups.has(survey)) groups.set(survey, new Map());
                  const byKind = groups.get(survey);
                  if (!byKind.has(kind)) byKind.set(kind, []);
                  byKind.get(kind).push({
                    text: stripSuffix(ds.label, kind) + offsetSuffix(ds),
                    fillStyle: fill,
                    strokeStyle: stroke,
                    lineWidth: ds.borderWidth || 1,
                    pointStyle: isOverlay
                      ? "line"
                      : (ds.pointStyle || pointStyleFor(survey)),
                    lineDash: isOverlay ? (ds.borderDash || []) : undefined,
                    // Mirror the dataset's marker rotation into the legend
                    // (ZTF FP triangles render apex-down on the chart, so
                    // their legend swatch must too — otherwise LSST FP and
                    // ZTF FP look identical in the legend).
                    rotation: ds.rotation || 0,
                    fontColor,
                    // Always false: Chart.js applies strikethrough when
                    // hidden=true. Real visibility is preserved on the
                    // dataset (meta.hidden) so onClick toggles correctly.
                    hidden: false,
                    datasetIndex: i,
                  });
                });
                const ordered = [];
                const surveys = ["lsst", "ztf", ...Array.from(groups.keys()).filter((s) => s !== "lsst" && s !== "ztf")];
                for (const s of surveys) {
                  const byKind = groups.get(s);
                  if (!byKind) continue;
                  const kinds = [
                    ...KIND_ORDER.filter((k) => byKind.has(k)),
                    ...Array.from(byKind.keys()).filter((k) => !KIND_ORDER.includes(k)),
                  ];
                  for (const k of kinds) {
                    const items = byKind.get(k);
                    if (!items || !items.length) continue;
                    if (s) {
                      // Header reflects group-visibility via the same dim
                      // color the disabled band entries use; clicking it
                      // toggles every member of the (survey, kind) bucket.
                      // $survey + $kind together are the key onClick uses
                      // to look up the right datasets.
                      const allHidden = items.every(
                        (_it, idx) => !ch.isDatasetVisible(items[idx].datasetIndex),
                      );
                      const headerLabel = KIND_LABEL[k] || k;
                      // Overlay models (GP / SPM / FLEET / TDE) aren't tied to a
                      // telescope — a GP band can even pool both — so their
                      // header is just "overlay:", no survey prefix.
                      ordered.push({
                        text: k === "overlay"
                          ? `${headerLabel}:`
                          : `${surveyLabel(s)} ${headerLabel}:`,
                        fillStyle: "transparent",
                        strokeStyle: "transparent",
                        lineWidth: 0,
                        pointStyle: "circle",
                        fontColor: allHidden ? DIMMED : TEXT,
                        hidden: false,
                        $survey: s,
                        $kind: k,
                        // No datasetIndex — onClick uses that to detect headers.
                      });
                    }
                    ordered.push(...items);
                  }
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
                // Time portion: phase shown only in fold mode; MJD always;
                // UTC always (derived from the underlying MJD even when
                // the X axis is folded to phase, so the user can map a
                // phase back to a calendar epoch).
                const folded = chart.$lcFold === "fold" && chart.$lcPeriod > 0;
                const mjd = isFinite(p.mjd) ? p.mjd : p.x;
                const utc = mjdToUtcString(mjd, ctx.dataset.$survey);
                const utcSuffix = utc ? ` (${utc})` : "";
                const xLabel = folded
                  ? `phase ${p.x.toFixed(3)} · MJD ${mjd.toFixed(3)}${utcSuffix}`
                  : `MJD ${mjd.toFixed(3)}${utcSuffix}`;
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
    // Overlay always starts off on a fresh object — it isn't persisted (URL or
    // cache), so navigating through many objects never auto-arms an expensive
    // fit (GP) per object. The user re-picks it from the toolbar each time.
    chart.$lcOverlay = "none";
    chart.$lcGp = null;          // live GP fit (time- or phase-domain)
    chart.$lcGpKey = null;       // which variant $lcGp holds ("time" / "fold:P")
    chart.$lcGpCache = {};        // key → fitted bundle, so fold toggles are instant
    chart.$lcGpInflight = null;   // Set of variant keys currently being fetched
    chart.$lcMode = initialAxisMode;
    chart.$lcSource = initialSourceMode;
    chart.$lcAbs = restored.abs === "abs" ? "abs" : "app";
    chart.$lcZ = null;  // set below from input after pre-fill
    chart.$lcDered = restored.dered === "dered" ? "dered" : "obs";
    chart.$lcEbv = null;  // set below from input after pre-fill
    chart.$lcExtR = extR;
    // Per-band Offset state — ephemeral, NOT persisted across object
    // navigation (z and ebv aren't either; offset is similarly object-
    // specific because the centering values it depends on differ per
    // object). Defaults: off, min centering, 0.5 mag step → activating
    // immediately shows bands aligned at their brightest with a 0.5 mag
    // per-rank spread (≈ visible separation right away). The +/− stepper
    // tunes the spread from there.
    chart.$lcOffset = "off";
    chart.$lcOffsetCenter = "min";
    chart.$lcOffsetStep = 0.5;
    chart.$lcOffsetMap = null;
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
    chart.$lcOverlayRestoreIntent = null;  // overlay is never restored
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
    // (Overlay starts "none" on every object, so there's nothing to fetch
    // here — the user arms an overlay from the toolbar, which lazily fetches.)
    // First-paint signal for downstream panels (position residuals etc.)
    // that derive from $lcRaw / $lcXRaw — they listen on this and can
    // build their initial render against whatever bands the server sent.
    emitDataChanged(chart);

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
      // Folding on/off — and, while folded, Diff↔Sci — change which GP variant
      // is needed (folded GP fits the folded *science* light curve, allowed
      // only in Sci mode). Swap to the matching fit.
      if ((spec.chartProp === "$lcFold" || spec.chartProp === "$lcSource")
          && c.$lcOverlay === "gp") ensureGpLoaded(c);
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

  // Read live ra/dec off the button — the deferred /htmx/lc_info fragment
  // stamps these *after* bindDrButton has already run, so capturing them
  // in the closure at bind time would freeze them as NaN and the handler
  // would silently no-op forever. Returns NaN/NaN if still not stamped.
  function drCoordsFromBtn(btn) {
    return [parseFloat(btn.dataset.ra), parseFloat(btn.dataset.dec)];
  }

  // Pre-fetch helper, exposed so lcSetCoords can kick the request off the
  // moment ra/dec land — keeps the "instant on click" UX even when the
  // bind-time fetch had to bail because coords weren't known yet.
  function tryPrefetchDr(canvasId) {
    const btn = document.querySelector(`.lc-dr-toggle[data-target="${canvasId}"]`);
    if (!btn) return;
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    if (!chart || chart.$lcDrLoaded) return;
    const [ra, dec] = drCoordsFromBtn(btn);
    if (!isFinite(ra) || !isFinite(dec)) return;
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

  function bindDrButton(btn) {
    if (btn.$bound) return;
    btn.$bound = true;
    const canvas = document.getElementById(btn.dataset.target);
    const chart = canvas && charts.get(canvas);

    // Background pre-fetch at bind time when coords are already known
    // (no deferred /htmx/lc_info gate). When they aren't, lcSetCoords
    // calls tryPrefetchDr the moment they arrive, so we get the same
    // "instant on click" UX without re-binding.
    tryPrefetchDr(btn.dataset.target);

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
      // Slow path: user beat the pre-fetch. Read coords from the button's
      // live data attrs (lcSetCoords stamps them after the bind has run,
      // so anything captured in the bind-time closure would still be
      // NaN — the original ZTF18aaylgug regression). Show a transient
      // "…" indicator while we wait on the shared promise, then fall
      // through to the same toggle logic.
      const [ra, dec] = drCoordsFromBtn(btn);
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
      // GP isn't a feature-extractor fit — it's computed on demand from the
      // raw LC — so it bypasses the $lcFits guard and instead lazily fetches
      // its posterior the first time it's picked (the spinner shows meanwhile;
      // lcSetGp re-renders when it lands).
      if (next === "gp") {
        c.$lcOverlay = "gp";
        ensureGpLoaded(c);
        applyModes(c);
        cacheAndPushLcState(c);
        return;
      }
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
    // oid is quoted in the comment so visual inspection signals the same
    // intent the data rows do: this is a string, not a number — LSST oids
    // are 18-digit ints that some consumers (Excel especially) will silently
    // coerce to scientific notation if treated as numeric.
    lines.push(`# oid: "${oid}"`);
    lines.push(`# primary_survey: ${survey}`);
    lines.push("# note: per-row 'survey' column is authoritative; cross-survey rows (when present) carry the matched survey + oid.");
    lines.push("# string_columns: oid, candid (LSST values are 64-bit identifiers; load with dtype={'oid': str, 'candid': str} in pandas, or pre-format as Text in Excel)");
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
    lines.push(["phot_type", "survey", "oid", "candid", "band", "mjd", ...dataCols].join(","));

    // Per-row: call projectPoint for each of the 16 combinations with the
    // appropriate distmod/extinction. projectPoint returns null when the
    // source flux is null (e.g. sci columns on a point without science
    // photometry, or mag on negative diff flux) → the cell stays empty.
    const emit = (phot_type, srcSurvey, srcOid, bandList) => {
      // Both oid and candid are always quoted: LSST oids and measurement_ids
      // are 64-bit integers that overflow IEEE 754 doubles, so any consumer
      // that auto-detects numeric columns (Excel, naive pandas) would
      // silently corrupt them. The quotes force string treatment.
      // Neither contains quotes themselves so no escaping is needed.
      const oidCell = srcOid != null ? `"${String(srcOid)}"` : "";
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
          const candCell = p.identifier != null ? `"${String(p.identifier)}"` : "";
          lines.push([phot_type, srcSurvey, oidCell, candCell, band.name, p.mjd, ...cells].join(","));
        }
      }
    };
    emit("alert_detection", survey, oid, raw.bands);
    emit("forced_photometry", survey, oid, raw.fpBands);
    // Only export ZTF DR when the user has it turned on — otherwise they'd
    // get archival points they never asked for, and in Diff mode those
    // points would silently drop (DR has no difference flux) making the
    // file subtly inconsistent with the plot.
    //
    // DR rows are tagged survey="ztf" because the data always comes from
    // the ZTF data release, even on LSST detail views. The oid column
    // uses the primary oid when the active survey is ZTF (same object),
    // or the cross-survey ZTF oid when in LSST mode if one was matched;
    // otherwise empty — there's no ZTF oid to attribute the archival
    // points to.
    if (chart.$lcDrShown) {
      const drOid = survey === "ztf" ? oid : (chart.$lcXOid || "");
      emit("ztf_dr", "ztf", drOid, chart.$lcDrBands);
    }
    // Cross-survey rows (matched counterpart from the other telescope) ride
    // along when present so the file mirrors what the chart shows. The
    // per-row `survey` + `oid` columns distinguish them from the primary.
    const xRaw = chart.$lcXRaw;
    if (xRaw && xRaw.survey) {
      const xOid = chart.$lcXOid;
      emit("alert_detection", xRaw.survey, xOid, xRaw.bands);
      emit("forced_photometry", xRaw.survey, xOid, xRaw.fpBands);
    }

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

  // ── Offset controls (toggle + centering select + +/- stepper) ────────────
  //
  // Three small bindings, all converging on `applyModes(chart)` so the same
  // re-projection path the other axis toggles use also handles the offset.
  // Visibility memory survives because (survey, kind, label) — the dataset
  // identity used by snapshot/applyVisibility — never changes when offset
  // changes.

  function setOffsetButtonState(btn, on) {
    btn.dataset.lcOffset = on ? "on" : "off";
    // Mirror the activeValue styling that setCycleValue uses for the Fold
    // button so Offset reads as "armed" with the same visual cue.
    btn.classList.toggle("tw-text-accent", on);
    btn.classList.toggle("tw-border-accent", on);
    btn.classList.toggle("tw-text-text-muted", !on);
    btn.classList.toggle("tw-border-border", !on);
    const wrap = document.querySelector(`.lc-offset-wrap[data-target="${btn.dataset.target}"]`);
    if (wrap) wrap.classList.toggle("tw-hidden", !on);
  }

  // Refresh the +/- buttons' tooltips so the current step is discoverable
  // without crowding the toolbar with a dedicated step display. The legend
  // shows the resulting per-band Δ values, which is the value the user
  // ultimately cares about.
  function setStepTooltips(target, step) {
    const fmt = step.toFixed(1);
    const up = document.querySelector(`.lc-offset-step-up[data-target="${target}"]`);
    const dn = document.querySelector(`.lc-offset-step-dn[data-target="${target}"]`);
    if (up) up.title = `Increase per-rank spread by 0.1 mag (current: ${fmt}).`;
    if (dn) dn.title = `Decrease per-rank spread by 0.1 mag (current: ${fmt}).`;
  }

  function bindOffsetToggle(btn) {
    if (btn.$bound) return;
    btn.$bound = true;
    btn.addEventListener("click", () => {
      const canvas = document.getElementById(btn.dataset.target);
      const chart = canvas && charts.get(canvas);
      if (!chart) return;
      chart.$lcOffset = chart.$lcOffset === "on" ? "off" : "on";
      setOffsetButtonState(btn, chart.$lcOffset === "on");
      applyModes(chart);
    });
    // Sync visual state to chart's current offset (defaults to "off"; this
    // also handles the case where the wrapper attribute drifted).
    const canvas = document.getElementById(btn.dataset.target);
    const chart = canvas && charts.get(canvas);
    if (chart) setOffsetButtonState(btn, chart.$lcOffset === "on");
  }

  function bindOffsetCenter(sel) {
    if (sel.$bound) return;
    sel.$bound = true;
    sel.addEventListener("change", () => {
      const canvas = document.getElementById(sel.dataset.target);
      const chart = canvas && charts.get(canvas);
      if (!chart) return;
      chart.$lcOffsetCenter = sel.value;
      applyModes(chart);
    });
    // Seed the dropdown from the chart's stored centering choice.
    const canvas = document.getElementById(sel.dataset.target);
    const chart = canvas && charts.get(canvas);
    if (chart && chart.$lcOffsetCenter) sel.value = chart.$lcOffsetCenter;
  }

  // Step bumper: ±0.1 mag per click, clamped to ±5 mag (a 5-mag spread
  // between adjacent bands is already absurd; further clicks would just
  // drag bands off the visible Y range without adding information).
  function bindOffsetStep(btn, delta) {
    if (btn.$bound) return;
    btn.$bound = true;
    btn.addEventListener("click", () => {
      const canvas = document.getElementById(btn.dataset.target);
      const chart = canvas && charts.get(canvas);
      if (!chart) return;
      const cur = isFinite(chart.$lcOffsetStep) ? chart.$lcOffsetStep : 0;
      // Snap to a multiple of 0.1 to avoid IEEE drift accumulating across
      // many clicks (otherwise the rounded total in the legend can flicker).
      // Floor at 0: the step is the magnitude of the spread, not a signed
      // direction — clicking v past 0 would invert which bands move up,
      // which the ^/v arrows aren't supposed to do.
      const next = Math.max(0, Math.min(5, Math.round((cur + delta) * 10) / 10));
      chart.$lcOffsetStep = next;
      const offBtn = document.querySelector(`.lc-offset-toggle[data-target="${btn.dataset.target}"]`);
      if (offBtn) offBtn.dataset.lcStep = next.toFixed(1);
      setStepTooltips(btn.dataset.target, next);
      // Re-project even when Offset is currently off — keeping step in sync
      // means turning Offset on later picks up the latest value without an
      // extra click. applyModes is a no-op for the offset path when off.
      applyModes(chart);
    });
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
    scope.querySelectorAll(".lc-offset-toggle").forEach(bindOffsetToggle);
    scope.querySelectorAll(".lc-offset-center").forEach(bindOffsetCenter);
    scope.querySelectorAll(".lc-offset-step-up").forEach((b) => bindOffsetStep(b, +0.1));
    scope.querySelectorAll(".lc-offset-step-dn").forEach((b) => bindOffsetStep(b, -0.1));
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
    // FP arrival can also bring NEW per-detection rows (FP records the
    // service didn't have at synchronous render time), so signal a data
    // change too — the residuals panel needs to re-derive against the
    // new band points, not just react to a visibility shift.
    emitDataChanged(chart);
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
    emitDataChanged(chart);
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
          // "none" and "gp" are always selectable — GP fits the raw LC, so
          // it doesn't depend on the feature-extractor fits this loop gates.
          if (opt.value === "none" || opt.value === "gp") continue;
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

  // Toggle the "fitting GP…" spinner. It lives in the LC loading strip
  // (alongside FP / features / coords / xsurvey), which self-collapses once
  // the eager loaders finish — so we re-show the strip while the fit runs and
  // re-collapse it after, unless an eager loader is still pending.
  function setGpStatus(oid, on) {
    const status = document.getElementById(`lc-gp-status-${oid}`);
    if (status) status.classList.toggle("tw-hidden", !on);
    const strip = document.getElementById("lc-loading-status-" + oid);
    if (!strip) return;
    if (on) {
      strip.style.display = ""; // reopen if lcMaybeHideLoadingStrip collapsed it
    } else if (!strip.querySelector('[hx-trigger~="load"]')) {
      strip.style.display = "none";
    }
  }

  // Which GP variant the chart currently needs — the fit follows the display
  // mode, so the right flux is always fit:
  //   "time"        — unfolded, Diff mode: time-domain fit of difference flux.
  //   "sci"         — unfolded, Sci mode: time-domain fit of science flux.
  //   "fold:P"      — folded (Sci only): phase-domain fit of the science flux
  //                   at period P (folding only makes sense on the science
  //                   light curve, so it's gated to Sci mode).
  //   null          — folded but not in Sci mode: no valid GP to show.
  // ensureGpLoaded fetches/caches per key so switching Diff↔Sci, folding, or
  // picking a new period swaps to the matching fit. Keys derive from the same
  // chart.$lcPeriod Number on both request and response, so they round-trip-
  // match exactly.
  function gpDesiredKey(chart) {
    if (chart.$lcFold === "fold" && chart.$lcPeriod > 0) {
      return chart.$lcSource === "sci" ? "fold:" + chart.$lcPeriod : null;
    }
    return chart.$lcSource === "sci" ? "sci" : "time";
  }

  // The key a returned bundle represents — derived from its OWN folded / science
  // / period flags (NOT a shared loading flag), so overlapping fetches can't be
  // misattributed.
  function gpBundleKey(bundle) {
    if (bundle && bundle.folded) return "fold:" + bundle.period;
    return bundle && bundle.science ? "sci" : "time";
  }

  // Spinner reflects "the desired variant isn't here yet and is being fetched".
  function refreshGpSpinner(chart) {
    const oid = chart.canvas.id.replace(/^lc-canvas-/, "");
    const want = gpDesiredKey(chart);
    const have = chart.$lcGp && chart.$lcGpKey === want;
    const loading = want != null && chart.$lcGpInflight && chart.$lcGpInflight.has(want);
    setGpStatus(oid, chart.$lcOverlay === "gp" && !have && !!loading);
  }

  // Lazily fetch the GP posterior for the chart's current state. Cached per key
  // so toggling fold/Sci or re-selecting a period reuses an earlier fit
  // instantly; otherwise fires the deferred /htmx/lc_gp fragment (with
  // &fold_period when folded) into the hidden slot — the fragment is a
  // script-only call to lcSetGp. GP is the priciest overlay, so it's never
  // fetched eagerly. A null desired key (folded + not Sci) fetches nothing.
  function ensureGpLoaded(chart) {
    if (!chart) return;
    const want = gpDesiredKey(chart);
    if (want == null) { refreshGpSpinner(chart); return; }   // folded needs Sci
    if (chart.$lcGpKey === want && chart.$lcGp) return;       // already showing it
    const cache = chart.$lcGpCache || (chart.$lcGpCache = {});
    if (cache[want]) {                                        // fitted before — reuse
      chart.$lcGp = cache[want];
      chart.$lcGpKey = want;
      applyModes(chart);
      refreshGpSpinner(chart);
      return;
    }
    const inflight = chart.$lcGpInflight || (chart.$lcGpInflight = new Set());
    if (inflight.has(want)) { refreshGpSpinner(chart); return; }  // already in flight
    const oid = chart.canvas.id.replace(/^lc-canvas-/, "");
    const slot = document.getElementById(`lc-gp-slot-${oid}`);
    const base = slot && slot.dataset.gpUrl;
    if (!base || !(window.htmx && typeof window.htmx.ajax === "function")) return;
    // Variant → query params: folded carries the period (science implied
    // server-side); unfolded Sci asks for science flux; unfolded Diff is bare.
    let url = base;
    if (want.startsWith("fold:")) url += "&fold_period=" + encodeURIComponent(chart.$lcPeriod);
    else if (want === "sci") url += "&science=1";
    inflight.add(want);
    refreshGpSpinner(chart);
    // Each fetch clears its OWN key on completion (the response identifies its
    // variant in lcSetGp); done() is the safety net for hard network failures.
    const done = () => { inflight.delete(want); refreshGpSpinner(chart); };
    Promise.resolve(window.htmx.ajax("GET", url, "#lc-gp-slot-" + oid)).then(done, done);
  }

  // Receive the GP posterior from the deferred /htmx/lc_gp fragment. The
  // response is attributed to its OWN variant (gpBundleKey) — never a shared
  // loading flag — so a fold fit that lands after the user has unfolded can't
  // be mistaken for the time fit (the bug that put folded curves on the time
  // axis). Caches by that key and adopts it only if the chart still wants it.
  window.lcSetGp = function (canvasId, bundle) {
    const canvas = document.getElementById(canvasId);
    const chart = canvas && charts.get(canvas);
    const oid = canvasId.replace(/^lc-canvas-/, "");
    if (!chart) return;
    const ok = bundle && bundle.available && Array.isArray(bundle.grid) && bundle.grid.length;
    if (!ok) {
      chart.$lcOverlay = "none";
      const sel = document.getElementById(`lc-overlay-${oid}`);
      if (sel) sel.value = "none";
      setGpStatus(oid, false);
      applyModes(chart);
      cacheAndPushLcState(chart);
      // Surface the reason after applyModes (which would otherwise clear the
      // strip when it sees overlay = "none").
      const info = document.querySelector(`.lc-overlay-info[data-target="${canvasId}"]`);
      if (info) {
        info.textContent = (bundle && bundle.message) || "GP overlay unavailable.";
        info.classList.remove("tw-hidden");
      }
      return;
    }
    const key = gpBundleKey(bundle);
    (chart.$lcGpCache || (chart.$lcGpCache = {}))[key] = bundle;
    // Adopt as the live fit only if the chart still wants this exact variant;
    // otherwise keep it cached and reconcile to whatever's wanted now.
    if (gpDesiredKey(chart) === key) {
      chart.$lcGp = bundle;
      chart.$lcGpKey = key;
      applyModes(chart); // draws the GP curves + the hyperparameter strip
    }
    ensureGpLoaded(chart); // fetch/adopt the now-wanted variant if state moved on
    refreshGpSpinner(chart);
    emitGpChanged(chart);  // the GP bundle (incl. cov_offdiag) just landed
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
    // Coords just arrived — bindDrButton already ran when the LC was
    // first painted (data-ra/data-dec were still empty then), so the
    // pre-fetch hasn't fired yet. Kick it now so a subsequent click is
    // instant + the (0)-cone label fills in without a click.
    tryPrefetchDr(canvasId);
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
    // A new fold period means a new phase-domain GP — swap to (or fetch) the
    // fit for this period.
    if (chart.$lcOverlay === "gp") ensureGpLoaded(chart);
  };

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));

  // Test-only surface: the pure projection helpers that carry the toggle
  // math (Flux/Mag, Diff/Sci, App/Abs, Obs/Der, per-band offset, fold) and
  // the per-survey marker / MJD→UTC conversions. Exposed so the Vitest suite
  // (tests-js/lightcurve.test.js) can exercise them without standing up a
  // Chart.js canvas. Not used by any runtime code path.
  window.__lcTest = { projectPoint, foldDataset, mjdToUtcString, pointStyleFor, surveyLabel, withAlpha };
})();
