/* Radar plot of classifier probabilities via Chart.js.
 *
 * One canvas carries the *entire* probability payload (all classifier groups)
 * as JSON; the classifier picker switches which group is rendered by
 * destroying the current Chart and rebuilding from scratch. Re-init on htmx
 * swap destroys any prior chart so the detail-view re-open path doesn't leak
 * a Chart instance.
 *
 * Why destroy + recreate instead of `chart.update()`:
 *   - Chart.js v4 radar charts keep an internal scale instance keyed on the
 *     options reference passed in at construction time; later mutations to
 *     `chart.options.scales.r.max` are only sometimes picked up at update().
 *   - Replacing `chart.data` with a fresh object can leave the per-dataset
 *     meta cache out of sync (the polygon stops re-rendering on subsequent
 *     classifier swaps).
 *   - Both quirks vanish when each picker change builds a brand-new Chart.
 *     The cost is negligible (a tiny radar with ~10 points), and the picker
 *     change is a discrete user action where a single redraw is expected.
 */
(function () {
  const NORMAL_COLOR = "#58a6ff";
  const MAX_COLOR = "#f85149";
  const FILL_COLOR = "rgba(88, 166, 255, 0.2)";

  const charts = new WeakMap();

  function findGroup(ctx, key) {
    return (ctx.groups || []).find((g) => g.key === key) || (ctx.groups || [])[0] || null;
  }

  function buildData(group) {
    const labels = group.classes.map((c) => c.class_name);
    const values = group.classes.map((c) => (c.probability == null ? 0 : c.probability));
    const colors = group.classes.map((c) => (c.is_max ? MAX_COLOR : NORMAL_COLOR));
    return {
      labels,
      datasets: [
        {
          label: group.key,
          data: values,
          backgroundColor: FILL_COLOR,
          borderColor: NORMAL_COLOR,
          borderWidth: 1.5,
          pointBackgroundColor: colors,
          pointBorderColor: colors,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    };
  }

  // Round up to the next "nice" axis tick: {1, 2, 2.5, 5} × 10ⁿ. Lets the
  // radar zoom into low-probability groups (e.g. max=0.04 → axis max=0.05)
  // without leaving an awkward 0.043 tick label on top.
  function niceCeiling(v) {
    if (!isFinite(v) || v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const mantissa = v / exp;
    let m;
    if (mantissa <= 1) m = 1;
    else if (mantissa <= 2) m = 2;
    else if (mantissa <= 2.5) m = 2.5;
    else if (mantissa <= 5) m = 5;
    else m = 10;
    return m * exp;
  }

  function scaleForGroup(group) {
    const values = (group.classes || []).map(
      (c) => (typeof c.probability === "number" ? c.probability : 0),
    );
    const peak = values.length ? Math.max(...values) : 0;
    const max = niceCeiling(peak);
    return { max, stepSize: max / 5 };
  }

  // Build a fresh Chart on `canvas` for the given group. Single source of
  // truth for options — used by both initial render and the
  // destroy-and-recreate path the picker triggers.
  function createChart(canvas, ctx, group) {
    const { max, stepSize } = scaleForGroup(group);
    const chart = new Chart(canvas.getContext("2d"), {
      type: "radar",
      data: buildData(group),
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Skip the fade-in on classifier swap so the new polygon snaps in
        // immediately. Without this a quick second click could land while
        // the previous animation is still running and feel laggy.
        animation: false,
        scales: {
          r: {
            beginAtZero: true,
            max,
            ticks: {
              stepSize,
              color: "#8b949e",
              backdropColor: "transparent",
            },
            grid: { color: "rgba(139,148,158,0.25)" },
            angleLines: { color: "rgba(139,148,158,0.25)" },
            pointLabels: { color: "#c9d1d9", font: { size: 11 } },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => `${item.label}: ${Number(item.raw).toFixed(3)}`,
            },
          },
        },
      },
    });
    chart.$radarCtx = ctx;
    charts.set(canvas, chart);
    recordActive(group);
    return chart;
  }

  // Surface the active group's top class + classifier as window globals so
  // "Back to results" can fill a missing `class_name` filter with the object's
  // dominant prediction under the same classifier the user was looking at.
  // Deep-linking into a detail view with only `classifier=` in the URL and
  // hitting Back would otherwise return an unfiltered listing.
  function recordActive(group) {
    if (!group) return;
    const top = (group.classes || []).find((c) => c.is_max) || group.classes?.[0];
    if (!top) return;
    window._currentObjectClass = top.class_name;
    window._currentObjectClassifier = group.classifier_name;
  }

  function initCanvas(canvas) {
    const payload = canvas.dataset.probs;
    if (!payload) return;
    let ctx;
    try {
      ctx = JSON.parse(payload);
    } catch (e) {
      console.warn("radar: bad JSON payload", e);
      return;
    }
    if (typeof Chart === "undefined") {
      console.warn("radar: Chart.js not loaded yet");
      return;
    }

    const prior = charts.get(canvas);
    if (prior) prior.destroy();

    const group = findGroup(ctx, ctx.default_key);
    if (!group) return;
    createChart(canvas, ctx, group);
  }

  function bindPicker(select) {
    if (select.$bound) return;
    select.$bound = true;
    select.addEventListener("change", () => {
      const canvas = document.getElementById(select.dataset.target);
      if (!canvas) return;
      const prior = charts.get(canvas);
      if (!prior) return;
      const ctx = prior.$radarCtx;
      const group = findGroup(ctx, select.value);
      if (!group) return;
      // Destroy + recreate. Any leftover scale/meta cache that was
      // blocking the radar from re-rendering goes away with the old
      // instance, and the new one starts with clean state.
      prior.destroy();
      charts.delete(canvas);
      createChart(canvas, ctx, group);
    });
  }

  function initAll(root) {
    const scope = root || document;
    scope.querySelectorAll("canvas.radar-canvas").forEach(initCanvas);
    scope.querySelectorAll(".radar-classifier-select").forEach(bindPicker);
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
