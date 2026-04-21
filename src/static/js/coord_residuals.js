/* Detection coordinate-residuals scatter plot.
 *
 * Each point is a detection's (Δra·cos(dec), Δdec) offset from the mean
 * position, in arcseconds. Color encodes MJD via a 5-stop viridis
 * approximation so a time-ordered drift (asteroid masquerading as a
 * transient) reads as a rainbow track rather than a random cloud.
 */
(function () {
  const VIRIDIS_STOPS = [
    [0.0, [68, 1, 84]],      // #440154
    [0.25, [59, 82, 139]],   // #3b528b
    [0.5, [33, 144, 140]],   // #21908c
    [0.75, [93, 200, 99]],   // #5dc863
    [1.0, [253, 231, 37]],   // #fde725
  ];

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

  function initCanvas(canvas) {
    const payload = canvas.dataset.coords;
    if (!payload) return;
    let ctx;
    try {
      ctx = JSON.parse(payload);
    } catch (e) {
      console.warn("coord_residuals: bad JSON payload", e);
      return;
    }
    if (typeof Chart === "undefined") {
      console.warn("coord_residuals: Chart.js not loaded yet");
      return;
    }

    const prior = charts.get(canvas);
    if (prior) prior.destroy();

    const pts = ctx.points || [];
    if (!pts.length) return;

    const mjdMin = ctx.mjd_min;
    const mjdMax = ctx.mjd_max;
    const span = mjdMax > mjdMin ? mjdMax - mjdMin : 1;
    const data = pts.map((p) => ({
      x: p.d_ra,
      y: p.d_dec,
      mjd: p.mjd,
      band: p.band,
      // Identifier + has_stamp carry click-to-sync semantics matching the
      // light curve: the highlight plugin finds the selected point by
      // identifier, and the onClick below only fires for detections that
      // actually have stamps.
      identifier: p.identifier,
      has_stamp: p.has_stamp,
    }));
    const colors = pts.map((p) => viridisColor((p.mjd - mjdMin) / span));

    // Use a symmetric axis range so the origin sits in the center — a
    // stationary source clusters there; a drift walks off to one side.
    const absMax = Math.max(
      ...pts.flatMap((p) => [Math.abs(p.d_ra), Math.abs(p.d_dec)]),
      0.5,
    );
    const axisMax = absMax * 1.15;

    const chart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "detections",
            data,
            backgroundColor: colors,
            borderColor: colors,
            pointRadius: 4,
            pointHoverRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
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
            min: -axisMax,
            max: axisMax,
            title: { display: true, text: "Δ RA·cos(δ) [arcsec]", color: "#8b949e" },
            grid: { display: false },
            border: { color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
          y: {
            type: "linear",
            min: -axisMax,
            max: axisMax,
            title: { display: true, text: "Δ Dec [arcsec]", color: "#8b949e" },
            grid: { display: false },
            border: { color: "#8b949e" },
            ticks: { color: "#8b949e" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const p = item.raw;
                const band = p.band ? ` · ${p.band}` : "";
                return `Δra ${p.x.toFixed(3)}", Δdec ${p.y.toFixed(3)}" · MJD ${p.mjd.toFixed(3)}${band}`;
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
    canvas.addEventListener("dblclick", () => chart.resetZoom && chart.resetZoom());
    charts.set(canvas, chart);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.coord-residuals-canvas").forEach(initCanvas);
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
