/* Multi-band, multi-harmonic LS periodogram panel.
 *
 * Reads (MJD, flux, eflux) from the live LC chart's `chart.$lcRaw` —
 * never re-fetches data, never holds its own copy. At each frequency,
 * fits *jointly* an NH-harmonic Fourier model per band (own constant +
 * own a_k, b_k for k=1…NH) by weighted least squares, and sums per-band
 * χ² reductions. This is the Schwarzenberg-Czerny 1996 multi-harmonic
 * statistic used by P4J's MHAOV on the production pipeline — strictly
 * better than our previous "sum of single-sinusoid GLS at f, 2f, …" on
 * objects whose true period sits near a yearly window-function alias
 * (the alias frequency carries spurious power at all its harmonics
 * too, so a *sum* of single-sinusoid powers can't break the tie; only a
 * joint fit, where harmonics must phase-lock to the same fundamental,
 * does). Frequency grid is Rayleigh-spaced (`df = 1/(oversample · T)`,
 * matching astropy's autopower convention). Selecting a period folds
 * the *main* LC chart via `window.lcSetFoldPeriod` — no internal folded
 * canvas.
 *
 * Panel toggling: `togglePeriodogramPanel(canvasId)` flips the
 * coord-residuals slot and the periodogram slot's `tw-hidden` classes so
 * they share the same grid cell. The first toggle is also when the
 * periodogram chart can first measure its container — Chart.js needs a
 * resize event after a `display: none → block` transition.
 */
(function () {
  const charts = new WeakMap(); // canvas → Chart instance for the periodogram

  // Three input modes for the GLS:
  //   diff_flux  — difference flux (nJy), the alert-stream native value
  //   sci_flux   — science flux (nJy), when the survey publishes it
  //   sci_mag    — AB magnitude derived from sci_flux (ABZP = 31.4); the
  //                natural domain for variable-star periodicity, where
  //                amplitudes are roughly band-independent
  //
  // Each cycles to the next on the toolbar button.
  const FLUX_MODES = ["diff_flux", "sci_flux", "sci_mag"];
  const FLUX_LABELS = { diff_flux: "Diff flux", sci_flux: "Sci flux", sci_mag: "Sci mag" };
  const ABZP_NJY = 31.4;
  const LN10_OVER_2P5 = Math.log(10) / 2.5;

  // Resolve a (survey, bandName) pair to its Chart.js detection dataset and
  // ask the chart whether it's still visible. Visibility is the user's hook
  // for excluding a band/survey from the periodogram: hiding an LC legend
  // entry hides it from us too. Unknown pairs (no matching dataset) are
  // treated as visible — better to include data than to silently drop it.
  function isBandVisible(lcChart, survey, bandName) {
    const datasets = lcChart && lcChart.data && lcChart.data.datasets;
    if (!datasets) return true;
    for (let i = 0; i < datasets.length; i++) {
      const ds = datasets[i];
      if (ds.$kind === "det" && ds.$survey === survey && ds.label === bandName) {
        return lcChart.isDatasetVisible(i);
      }
    }
    return true;
  }

  function surveyLabel(s) {
    return s === "lsst" ? "LSST" : (s === "ztf" ? "ZTF" : (s || ""));
  }

  // Pull (MJD, value, error) tuples from the LC chart, *grouped by band*
  // and *filtered to the bands currently visible in the LC legend* — that
  // visibility is the user's lever for including/excluding a survey or a
  // band from the multi-harmonic fit. Cross-survey detections (the matched
  // counterpart from $lcXRaw) feed into the same pool, so a click on the
  // LC legend's "LSST:" or "ZTF:" header instantly drops or adds half the
  // input. Each band's inverse-variance-weighted mean is subtracted in
  // place so the residuals are centered; per-band arrays let the GLS fit a
  // separate sinusoid per band at each frequency (see `compute`).
  function getDetDataByBand(lcChart, mode) {
    const sources = [];
    const primarySurvey = lcChart.$lcSurvey || "";
    if (lcChart.$lcRaw && Array.isArray(lcChart.$lcRaw.bands)) {
      sources.push({ survey: primarySurvey, bands: lcChart.$lcRaw.bands });
    }
    if (lcChart.$lcXRaw && Array.isArray(lcChart.$lcXRaw.bands) && lcChart.$lcXRaw.survey) {
      sources.push({ survey: lcChart.$lcXRaw.survey, bands: lcChart.$lcXRaw.bands });
    }
    const bands = [];
    for (const src of sources) {
      for (const band of src.bands) {
        if (!isBandVisible(lcChart, src.survey, band.name)) continue;
        const mjd = [], val = [], err = [];
        for (const p of (band.points || [])) {
          if (!isFinite(p.mjd)) continue;
          let value, error;
          if (mode === "sci_flux") {
            value = p.sci_flux; error = p.e_sci_flux;
          } else if (mode === "sci_mag") {
            // Convert sci_flux to AB mag; small-error linearization for σ_mag
            // matches the LC panel's mag-error convention.
            if (p.sci_flux == null || !(p.sci_flux > 0)) continue;
            if (p.e_sci_flux == null || !(p.e_sci_flux > 0)) continue;
            value = ABZP_NJY - 2.5 * Math.log10(p.sci_flux);
            error = p.e_sci_flux / p.sci_flux / LN10_OVER_2P5;
          } else {
            // diff_flux (default)
            value = p.flux; error = p.e_flux;
          }
          if (value == null || error == null || !(error > 0)) continue;
          mjd.push(p.mjd); val.push(value); err.push(error);
        }
        if (mjd.length === 0) continue;
        // Inverse-variance weighted mean for this band.
        let wSum = 0, wvSum = 0;
        for (let i = 0; i < val.length; i++) {
          const w = 1 / (err[i] * err[i]);
          wSum += w; wvSum += w * val[i];
        }
        const bandMean = wSum > 0 ? wvSum / wSum : 0;
        const resid = new Float64Array(val.length);
        for (let i = 0; i < val.length; i++) resid[i] = val[i] - bandMean;
        bands.push({
          mjd: Float64Array.from(mjd),
          resid,
          err: Float64Array.from(err),
          name: band.name || "",
          survey: src.survey,
          label: `${surveyLabel(src.survey)} ${band.name || ""}`.trim(),
        });
      }
    }
    return bands;
  }

  // "LSST: g r · ZTF: g" — used in the status line so the user can see at a
  // glance which bands the just-finished compute actually consumed.
  function describeBands(bandData) {
    if (!bandData.length) return "";
    const order = new Map();
    for (const b of bandData) {
      if (!order.has(b.survey)) order.set(b.survey, []);
      order.get(b.survey).push(b.name);
    }
    const surveyOrder = ["lsst", "ztf", ...Array.from(order.keys()).filter((s) => s !== "lsst" && s !== "ztf")];
    const parts = [];
    for (const s of surveyOrder) {
      const names = order.get(s);
      if (!names || !names.length) continue;
      parts.push(`${surveyLabel(s) || "?"}: ${names.join(" ")}`);
    }
    return parts.join(" · ");
  }

  function setStatus(panel, msg, kind) {
    const el = panel.querySelector("[data-pg-status]");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.remove("tw-text-text-muted", "tw-text-accent", "tw-text-red-400");
    el.classList.add(
      kind === "error" ? "tw-text-red-400"
      : kind === "busy" ? "tw-text-accent"
      : "tw-text-text-muted"
    );
  }

  // Find top-N peaks in the periodogram, with parabolic refinement and a
  // 5%-of-period-ratio min separation so harmonics of the same fundamental
  // don't crowd the list.
  function findTopPeaks(frequencies, power, n, df) {
    const indices = power.map((_, i) => i).sort((a, b) => power[b] - power[a]);
    const peaks = [];
    const minSep = 0.05;
    for (const idx of indices) {
      if (peaks.length >= n) break;
      let refined = frequencies[idx];
      if (df != null && idx > 0 && idx < frequencies.length - 1) {
        const a = power[idx - 1], b = power[idx], c = power[idx + 1];
        const denom = a - 2 * b + c;
        if (Math.abs(denom) >= 1e-12) {
          refined = frequencies[idx] + df * 0.5 * (a - c) / denom;
        }
      }
      const period = 1.0 / refined;
      let tooClose = false;
      for (const p of peaks) {
        const ratio = period / p.x;
        if (ratio > 1 - minSep && ratio < 1 + minSep) { tooClose = true; break; }
      }
      if (!tooClose) peaks.push({ x: period, y: power[idx] });
    }
    return peaks;
  }

  function renderPeriodogramChart(canvas, frequencies, power, topPeaks) {
    const prior = charts.get(canvas);
    if (prior) prior.destroy();
    // `frequencies`/`power` arrive as Float64Array. Calling `.map()` on a
    // typed array coerces non-numeric returns to NaN, which would silently
    // erase the whole line dataset — only the (plain) topPeaks would
    // render. Build the {x, y} pairs with an explicit loop instead.
    const data = new Array(frequencies.length);
    for (let i = 0; i < frequencies.length; i++) {
      data[i] = { x: 1.0 / frequencies[i], y: power[i] };
    }
    // Draw a dashed vertical line at the currently-selected period so the
    // user can see what's pinned without hunting for the peak label. The
    // line is read from `chart.$selectedPeriod` (set by `selectPeriod`)
    // and erased when that's null.
    const verticalSelectedPlugin = {
      id: "pgVerticalSelected",
      afterDatasetsDraw(c) {
        const period = c.$selectedPeriod;
        if (!(period > 0)) return;
        const xScale = c.scales.x;
        const yScale = c.scales.y;
        const x = xScale.getPixelForValue(period);
        if (!isFinite(x) || x < xScale.left || x > xScale.right) return;
        const ctx = c.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#f85149cc";
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      },
    };

    // Draw the feature-table Multiband_period (if any) as a second
    // labeled reference line, distinct color, so the user can compare
    // the GLS peak we found against what the ZTF pipeline reports. The
    // value is read once at chart-construction time from the LC Fold
    // button's `data-lc-period` (the canonical place we stash it).
    const verticalPipelinePlugin = {
      id: "pgVerticalPipeline",
      afterDatasetsDraw(c) {
        const period = c.$pipelinePeriod;
        if (!(period > 0)) return;
        const xScale = c.scales.x;
        const yScale = c.scales.y;
        const x = xScale.getPixelForValue(period);
        if (!isFinite(x) || x < xScale.left || x > xScale.right) return;
        const ctx = c.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#d29922cc";
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        // "Pipeline" label, rotated 90° so it sits beside the line.
        ctx.setLineDash([]);
        ctx.fillStyle = "#d29922";
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.translate(x + 3, yScale.top + 4);
        ctx.rotate(Math.PI / 2);
        ctx.textBaseline = "alphabetic";
        ctx.fillText("Pipeline", 0, 0);
        ctx.restore();
      },
    };

    const chart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "Multi-harmonic GLS",
            data,
            borderColor: "#1976d2",
            backgroundColor: "#1976d222",
            pointRadius: 0,
            pointHitRadius: 0,
            showLine: true,
            borderWidth: 1.5,
          },
          {
            // Top peaks. `pointHitRadius` is generous (24 px) so clicking
            // *near* a peak snaps to its exact period rather than picking
            // the slightly-off x under the cursor — important on the log
            // axis where small pixel offsets are big period offsets.
            label: "Top peaks",
            data: topPeaks || [],
            borderColor: "#f85149",
            backgroundColor: "#f8514988",
            pointRadius: 5,
            pointHitRadius: 24,
            pointStyle: "crossRot",
            pointBorderWidth: 2,
            showLine: false,
          },
        ],
      },
      plugins: [verticalSelectedPlugin, verticalPipelinePlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: {
            type: "logarithmic",
            title: { display: true, text: "Period (days)", color: "#a6a6a6", font: { size: 10 } },
            ticks: { color: "#6e6e6e", font: { size: 9 } },
            grid: { color: "#2c2c2c" },
          },
          y: {
            min: 0, max: 1.1,
            title: { display: true, text: "MH-GLS score", color: "#a6a6a6", font: { size: 10 } },
            ticks: { color: "#6e6e6e", font: { size: 9 } },
            grid: { color: "#2c2c2c" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true, mode: "nearest", axis: "x", intersect: false,
            callbacks: {
              label: (ctx) => {
                const p = ctx.raw.x.toPrecision(8);
                return ctx.datasetIndex === 1
                  ? `Peak #${ctx.dataIndex + 1}: P = ${p} d`
                  : `P = ${p} d`;
              },
            },
          },
          zoom: {
            zoom: {
              wheel: { enabled: true, speed: 0.1 },
              pinch: { enabled: true },
              drag: { enabled: true, modifierKey: "shift" },
              mode: "xy",
            },
            pan: { enabled: true, mode: "xy", modifierKey: "ctrl" },
          },
        },
        onHover(evt, _active, c) {
          // Pointer cursor when hovering near a peak (within its enlarged
          // hit radius). Lets users see they can click to snap-select.
          const peakHits = c.getElementsAtEventForMode(
            evt, "point", { intersect: true }, false,
          ).filter((e) => e.datasetIndex === 1);
          c.canvas.style.cursor = peakHits.length > 0 ? "pointer" : "crosshair";
        },
        onClick(evt) {
          // Prefer a peak under the cursor (intersect-true honors the
          // peaks dataset's pointHitRadius = 24 px). Falls back to the
          // raw clicked period if no peak is in range.
          const peakHits = chart.getElementsAtEventForMode(
            evt, "point", { intersect: true }, false,
          ).filter((e) => e.datasetIndex === 1);
          if (peakHits.length > 0) {
            const idx = peakHits[0].index;
            const peak = chart.data.datasets[1].data[idx];
            if (peak && peak.x > 0) {
              selectPeriod(canvas, peak.x);
              return;
            }
          }
          const xScale = chart.scales.x;
          const xPixel = evt.native.offsetX;
          const period = xScale.getValueForPixel(xPixel);
          if (period > 0) selectPeriod(canvas, period);
        },
      },
    });
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom());
    // Look up the feature-table Multiband_period from the LC Fold button
    // so the verticalPipelinePlugin can draw it. The button is only
    // rendered when the server found a positive period (ZTF only).
    const panel = canvas.closest("[data-pg-panel]");
    const lcCanvasId = panel && panel.dataset.lcTarget;
    if (lcCanvasId) {
      const foldBtn = document.querySelector(
        `.lc-fold-toggle[data-target="${lcCanvasId}"]`,
      );
      const pipelineP = foldBtn ? parseFloat(foldBtn.dataset.lcPeriod) : NaN;
      if (isFinite(pipelineP) && pipelineP > 0) chart.$pipelinePeriod = pipelineP;
    }
    charts.set(canvas, chart);
  }

  // Pin the period: update the panel display, the manual-period input,
  // and fold the main LC chart at the selected period via the public
  // hook (lcSetFoldPeriod).
  function selectPeriod(canvas, period) {
    if (!(period > 0)) return;
    const panel = canvas.closest("[data-pg-panel]");
    if (!panel) return;
    panel.dataset.pgSelectedPeriod = String(period);
    const input = panel.querySelector("[data-pg-period]");
    if (input) input.value = period.toPrecision(15);
    const display = panel.querySelector("[data-pg-display]");
    if (display) display.textContent = `P = ${period.toPrecision(10)} d`;
    // Move the dashed vertical reference line.
    const chart = charts.get(canvas);
    if (chart) {
      chart.$selectedPeriod = period;
      chart.update("none");
    }
    const lcCanvasId = panel.dataset.lcTarget;
    if (lcCanvasId && window.lcSetFoldPeriod) window.lcSetFoldPeriod(lcCanvasId, period);
  }

  // Reusable scratch buffers for the multi-harmonic normal-equation solve,
  // allocated once and shared across every frequency and band so the hot loop
  // never allocates. phi[0] is the constant basis term and stays 1.
  function makeMhScratch(NH) {
    const DIM = 2 * NH + 1; // [c, a₁, b₁, a₂, b₂, …, a_NH, b_NH]
    const phi = new Float64Array(DIM);
    phi[0] = 1;
    return {
      DIM,
      M: new Float64Array(DIM * DIM),
      v: new Float64Array(DIM),
      yvec: new Float64Array(DIM),
      phi,
    };
  }

  // Joint multi-harmonic least-squares χ²-reduction at a single angular
  // frequency ω, summed across bands (Schwarzenberg-Czerny 1996). Pure: no
  // DOM, no time budget — extracted from compute()'s chunked loop so that loop
  // and the unit tests (inject a sinusoid, recover its period) share one
  // implementation. Each band entry needs {dt, w, resid} typed arrays; pass a
  // scratch object from makeMhScratch(NH). Solves the symmetric positive-
  // definite normal equations M·p = v by in-place Cholesky and returns ‖L⁻¹v‖²
  // (no need to back-solve for p).
  function mhPowerAtFreq(bandData, omega, NH, scratch) {
    const { DIM, M, v, yvec, phi } = scratch;
    let total = 0;
    for (const b of bandData) {
      const N = b.dt.length;
      const w = b.w, dt = b.dt, resid = b.resid;
      M.fill(0);
      v.fill(0);

      // Build M (upper triangle) and v.
      for (let i = 0; i < N; i++) {
        const t = dt[i];
        const c1 = Math.cos(omega * t);
        const s1 = Math.sin(omega * t);
        phi[1] = c1; phi[2] = s1;
        let cPrev = 1, sPrev = 0, cCur = c1, sCur = s1;
        for (let k = 2; k <= NH; k++) {
          const cNew = 2 * c1 * cCur - cPrev;
          const sNew = 2 * c1 * sCur - sPrev;
          cPrev = cCur; sPrev = sCur;
          cCur = cNew; sCur = sNew;
          phi[2 * k - 1] = cCur;
          phi[2 * k] = sCur;
        }

        const wi = w[i];
        const wri = wi * resid[i];
        for (let j = 0; j < DIM; j++) {
          const wpj = wi * phi[j];
          v[j] += wri * phi[j];
          for (let kk = j; kk < DIM; kk++) {
            M[j * DIM + kk] += wpj * phi[kk];
          }
        }
      }

      // Mirror to lower triangle, then in-place Cholesky.
      for (let j = 0; j < DIM; j++) {
        for (let kk = 0; kk < j; kk++) {
          M[j * DIM + kk] = M[kk * DIM + j];
        }
      }
      let valid = true;
      for (let j = 0; j < DIM; j++) {
        let s = M[j * DIM + j];
        for (let kk = 0; kk < j; kk++) {
          const lkk = M[j * DIM + kk];
          s -= lkk * lkk;
        }
        if (!(s > 1e-14)) { valid = false; break; }
        const Ljj = Math.sqrt(s);
        M[j * DIM + j] = Ljj;
        const inv = 1 / Ljj;
        for (let r = j + 1; r < DIM; r++) {
          let sum = M[r * DIM + j];
          for (let kk = 0; kk < j; kk++) {
            sum -= M[r * DIM + kk] * M[j * DIM + kk];
          }
          M[r * DIM + j] = sum * inv;
        }
      }
      if (!valid) continue;

      // Forward solve L·y = v ; χ² reduction = ‖y‖².
      let red = 0;
      for (let j = 0; j < DIM; j++) {
        let sum = v[j];
        for (let kk = 0; kk < j; kk++) sum -= M[j * DIM + kk] * yvec[kk];
        const yj = sum / M[j * DIM + j];
        yvec[j] = yj;
        red += yj * yj;
      }
      total += red;
    }
    return total;
  }

  async function compute(panel) {
    if (panel.dataset.pgRunning === "1") return;
    const lcCanvasId = panel.dataset.lcTarget;
    const lcChart = window.lcGetChart && window.lcGetChart(lcCanvasId);
    if (!lcChart) {
      setStatus(panel, "Light curve not ready.", "error");
      return;
    }
    const mode = FLUX_MODES.includes(panel.dataset.fluxType)
      ? panel.dataset.fluxType : "sci_mag";
    const bandData = getDetDataByBand(lcChart, mode);
    if (bandData.length === 0) {
      setStatus(
        panel,
        `No bands selected — toggle bands on in the Light curve legend.`,
        "error",
      );
      return;
    }
    const nPts = bandData.reduce((s, b) => s + b.mjd.length, 0);
    if (nPts < 5) {
      setStatus(
        panel,
        `Need ≥5 ${FLUX_LABELS[mode]} points across visible bands (have ${nPts}; bands: ${describeBands(bandData)}).`,
        "error",
      );
      return;
    }
    const minP = parseFloat(panel.querySelector("[data-pg-min]").value) || 0.1;
    const maxP = parseFloat(panel.querySelector("[data-pg-max]").value) || 100;
    const oversample = Math.max(
      1,
      parseInt(panel.querySelector("[data-pg-oversample]").value, 10) || 5,
    );

    // Global time baseline (Rayleigh resolution uses the full span across
    // all bands), and per-band weights / time offsets. We center times on
    // the global tMin so trig arguments stay small.
    let tMin = Infinity, tMax = -Infinity;
    for (const b of bandData) {
      for (let i = 0; i < b.mjd.length; i++) {
        const t = b.mjd[i];
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }
    const T = tMax - tMin;
    if (!(T > 0)) {
      setStatus(panel, "Time baseline is zero — can't compute.", "error");
      return;
    }
    for (const b of bandData) {
      const N = b.mjd.length;
      b.dt = new Float64Array(N);
      b.w = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        b.dt[i] = b.mjd[i] - tMin;
        b.w[i] = 1.0 / (b.err[i] * b.err[i]);
      }
    }

    const minFreq = 1 / maxP;
    const maxFreq = 1 / minP;
    const df = 1 / (oversample * T);
    const nFreq = Math.ceil((maxFreq - minFreq) / df);

    panel.dataset.pgRunning = "1";
    const nBands = bandData.length;
    const bandDesc = describeBands(bandData);
    setStatus(
      panel,
      `Computing ${nFreq.toLocaleString()} freqs · ${bandDesc}…`,
      "busy",
    );

    // Yield once so the busy message paints before the heavy loop.
    await new Promise((r) => setTimeout(r, 0));

    const freqArr = new Float64Array(nFreq);
    const power = new Float64Array(nFreq);

    // Multi-band, multi-harmonic least-squares periodogram (Schwarzenberg-
    // Czerny 1996; the same family P4J's MHAOV uses on the production
    // pipeline). At each frequency ω = 2πf, fit per band:
    //   y_b(t) = c_b + Σ_{k=1..NH} [a_{k,b} cos(kωt) + b_{k,b} sin(kωt)]
    // by weighted least squares, then sum χ² reductions across bands.
    //
    // Why this beats the previous "MH-summed" heuristic (sum of single-
    // sinusoid GLS at f, 2f, …, 6f): the same observing window aliases
    // *each harmonic independently*, so an alias frequency carries
    // spurious power at all its own harmonics too — the sum can't tell
    // a true fundamental from a window alias. A joint multi-harmonic
    // FIT only accumulates power when harmonics are phase-coherent with
    // the same fundamental, which is exactly the discrimination needed
    // to break yearly window aliases (the failure mode for ZTF20acuwouz
    // and similar long-baseline ZTF objects).
    //
    // Numerics: solve dim×dim symmetric positive-definite normal
    // equations M·p = v by in-place Cholesky (M = L Lᵀ), then forward-
    // solve L·y = v. The χ² reduction is ‖y‖² (no need to back-solve
    // for p — vᵀ p = vᵀ M⁻¹ v = ‖L⁻¹v‖²). Per-point trig basis built by
    // Chebyshev recurrence (cos((k+1)x) = 2 cos(x) cos(kx) − cos((k−1)x))
    // so each point costs only one cos+sin and (NH−1)·4 muladds. Chunked
    // so the busy message repaints every ~50 ms.
    const NH = 4;
    const scratch = makeMhScratch(NH);

    const CHUNK_MS = 50;
    let fi = 0;
    while (fi < nFreq) {
      const chunkStart = performance.now();
      while (fi < nFreq && performance.now() - chunkStart < CHUNK_MS) {
        const freq = minFreq + fi * df;
        const omega = 2 * Math.PI * freq;
        const total = mhPowerAtFreq(bandData, omega, NH, scratch);
        freqArr[fi] = freq;
        power[fi] = total;
        fi++;
      }
      setStatus(panel, `Computing… ${Math.round((fi / nFreq) * 100)}%`, "busy");
      await new Promise((r) => setTimeout(r, 0));
    }

    // Normalize the joint multi-harmonic LS χ²-reduction to [0, 1] for
    // display. (No second-pass MH summation: the per-frequency power
    // already includes all NH harmonics, jointly fit.)
    let maxPow = -Infinity;
    for (let i = 0; i < power.length; i++) if (power[i] > maxPow) maxPow = power[i];
    const normMH = new Float64Array(nFreq);
    for (let i = 0; i < nFreq; i++) normMH[i] = maxPow > 0 ? power[i] / maxPow : 0;

    // Parabolic peak refinement on the MH-score curve.
    function refine(idx) {
      if (idx <= 0 || idx >= freqArr.length - 1) return freqArr[idx];
      const a = normMH[idx - 1], b = normMH[idx], c = normMH[idx + 1];
      const denom = a - 2 * b + c;
      if (Math.abs(denom) < 1e-12) return freqArr[idx];
      return freqArr[idx] + df * 0.5 * (a - c) / denom;
    }
    let bestIdx = 0;
    for (let i = 1; i < normMH.length; i++) if (normMH[i] > normMH[bestIdx]) bestIdx = i;
    const bestFreq = refine(bestIdx);
    const bestPeriod = 1 / bestFreq;
    const peaks = findTopPeaks(Array.from(freqArr), Array.from(normMH), 5, df);

    const canvas = panel.querySelector("canvas.periodogram-canvas");
    if (canvas) renderPeriodogramChart(canvas, freqArr, normMH, peaks);
    selectPeriod(canvas, bestPeriod);

    setStatus(
      panel,
      `Done · ${nFreq.toLocaleString()} freqs · ${nPts} pts (${FLUX_LABELS[mode]}) · ${bandDesc}`,
      null,
    );
    panel.dataset.pgRunning = "0";
  }

  // Bind one panel's controls. Uses dataset attributes so the markup is
  // self-contained (the JS doesn't need to know element IDs per object).
  function bindPanel(panel) {
    if (panel.$pgBound) return;
    panel.$pgBound = true;

    const fluxToggle = panel.querySelector("[data-pg-flux-toggle]");
    if (fluxToggle) {
      // Initial label → match whatever mode the template wrote.
      const initial = FLUX_MODES.includes(panel.dataset.fluxType)
        ? panel.dataset.fluxType : "sci_mag";
      panel.dataset.fluxType = initial;
      fluxToggle.textContent = FLUX_LABELS[initial];
      fluxToggle.addEventListener("click", () => {
        const idx = FLUX_MODES.indexOf(panel.dataset.fluxType);
        const next = FLUX_MODES[(idx + 1) % FLUX_MODES.length];
        panel.dataset.fluxType = next;
        fluxToggle.textContent = FLUX_LABELS[next];
      });
    }

    const computeBtn = panel.querySelector("[data-pg-compute]");
    if (computeBtn) computeBtn.addEventListener("click", () => compute(panel));

    const applyBtn = panel.querySelector("[data-pg-apply]");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        const v = parseFloat(panel.querySelector("[data-pg-period]").value);
        if (v > 0) {
          const canvas = panel.querySelector("canvas.periodogram-canvas");
          selectPeriod(canvas, v);
        }
      });
    }

    const dbl = panel.querySelector("[data-pg-double]");
    if (dbl) dbl.addEventListener("click", () => {
      const v = parseFloat(panel.dataset.pgSelectedPeriod);
      if (v > 0) {
        const canvas = panel.querySelector("canvas.periodogram-canvas");
        selectPeriod(canvas, v * 2);
      }
    });
    const half = panel.querySelector("[data-pg-half]");
    if (half) half.addEventListener("click", () => {
      const v = parseFloat(panel.dataset.pgSelectedPeriod);
      if (v > 0) {
        const canvas = panel.querySelector("canvas.periodogram-canvas");
        selectPeriod(canvas, v / 2);
      }
    });

    const unfold = panel.querySelector("[data-pg-unfold]");
    if (unfold) unfold.addEventListener("click", () => {
      const lcCanvasId = panel.dataset.lcTarget;
      if (lcCanvasId && window.lcSetFoldPeriod) window.lcSetFoldPeriod(lcCanvasId, null);
      delete panel.dataset.pgSelectedPeriod;
      const display = panel.querySelector("[data-pg-display]");
      if (display) display.textContent = "";
      // Erase the dashed vertical reference line.
      const canvas = panel.querySelector("canvas.periodogram-canvas");
      const chart = canvas && charts.get(canvas);
      if (chart) {
        chart.$selectedPeriod = null;
        chart.update("none");
      }
    });

    // Manual-period Enter shortcut so the user doesn't need to hit Apply.
    const periodInput = panel.querySelector("[data-pg-period]");
    if (periodInput) {
      periodInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const v = parseFloat(periodInput.value);
          if (v > 0) {
            const canvas = panel.querySelector("canvas.periodogram-canvas");
            selectPeriod(canvas, v);
          }
        }
      });
    }
  }

  function initAll(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-pg-panel]").forEach(bindPanel);
  }

  // Toggle the periodogram slot ↔ coord-residuals slot. Both share the
  // same grid cell; only one is visible at a time. Resize is dispatched
  // so the periodogram chart (if it exists) re-measures its container
  // after the display flip.
  window.togglePeriodogramPanel = function (lcCanvasId) {
    const cr = document.getElementById("coord-residuals-slot");
    const pg = document.getElementById("periodogram-slot");
    // Airmass shares the same cell — keep all three mutually exclusive
    // so opening periodogram never leaves airmass on screen behind it.
    const am = document.getElementById("airmass-slot");
    // Color evolution also shares the cell (shown while the GP overlay is
    // active). Keep all four mutually exclusive.
    const ce = document.getElementById("color-evolution-slot");
    if (!cr || !pg) return;
    const showPg = pg.classList.contains("tw-hidden");
    if (showPg) {
      cr.classList.add("tw-hidden");
      if (am) am.classList.add("tw-hidden");
      if (ce) ce.classList.add("tw-hidden");
      pg.classList.remove("tw-hidden");
    } else {
      pg.classList.add("tw-hidden");
      // Restore color evolution if GP is the active overlay, else the residuals.
      if (ce && window.lcGpActive && window.lcGpActive(lcCanvasId)) {
        ce.classList.remove("tw-hidden");
      } else {
        cr.classList.remove("tw-hidden");
      }
    }
    // Highlight the toolbar button while the panel is active.
    const btn = document.querySelector(`.lc-periodogram-btn[data-target="${lcCanvasId}"]`);
    if (btn) {
      btn.classList.toggle("tw-bg-accent", showPg);
      btn.classList.toggle("tw-text-bg-primary", showPg);
      btn.setAttribute("aria-pressed", showPg ? "true" : "false");
    }
    // Force a resize so Chart.js rebuilds the periodogram axes after the
    // display: none → block transition (it can't measure a hidden canvas).
    window.dispatchEvent(new Event("resize"));
    // Nudge the color-evolution panel so it rebuilds its chart if it was just
    // restored (it skips rendering while hidden).
    if (!showPg) document.dispatchEvent(new Event("lc:gpChanged"));
  };

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));

  // Test-only surface: the pure multi-harmonic LS core (and its scratch
  // factory) plus the peak finder, so the Vitest suite can inject a synthetic
  // sinusoid and confirm the period is recovered without a Chart.js panel.
  // Not used by any runtime code path.
  window.__pgTest = { makeMhScratch, mhPowerAtFreq, findTopPeaks };
})();
