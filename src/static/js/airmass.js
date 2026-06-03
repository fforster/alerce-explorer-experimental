// Airmass calculator panel.
//
// Mirrors `../ALeRCE_explorer/alerce_explorer.html` lines ~5867-6253: pick an
// observatory + UTC night, compute the object's airmass evolution (with Moon
// + twilight overlay) using a low-precision Meeus Sun/Moon and the
// Pickering (2002) airmass formula. All math runs client-side; no server
// round-trip after the panel template is loaded.
//
// Wiring contract:
//   - The panel template lives inside #airmass-slot in the detail
//     container, hidden by default. The "Airmass" button in the Basic
//     Information panel calls `window.toggleAirmassPanel(oid, ra, dec)` to
//     flip visibility (mutually exclusive with #coord-residuals-slot and
//     #periodogram-slot — only one is on screen at a time).
//   - The panel root element carries `data-airmass-panel`. We bind it once
//     on first render (DOMContentLoaded + htmx:afterSwap) and stash the
//     last computed object's RA/Dec on `panel.dataset.{ra,dec}` so the
//     Compute button can re-render after a coord change.
//   - The Chart.js instance is stored on the canvas (`canvas._airmassChart`)
//     so re-running Compute destroys the old chart instead of leaking
//     listeners.

(function () {
  // ============================================================
  //  Constants — observatories and the small math kit
  // ============================================================

  // Mirrored verbatim from the prototype OBSERVATORIES list. Index 0 is
  // "— Custom —" (no preset) so the user can type lat/lon/elev directly.
  const OBSERVATORIES = [
    { name: "— Custom —",                            lat: null,    lon: null,     elev: null },
    { name: "Cerro Pachón — Rubin / LSST",           lat: -30.2447, lon: -70.7494, elev: 2647 },
    { name: "Cerro Pachón — Gemini South",            lat: -30.2408, lon: -70.7367, elev: 2722 },
    { name: "Cerro Paranal — VLT (ESO)",              lat: -24.6253, lon: -70.4025, elev: 2635 },
    { name: "La Silla — ESO 3.6m / NTT",              lat: -29.2584, lon: -70.7345, elev: 2347 },
    { name: "Cerro Tololo — CTIO (NOAO)",             lat: -30.1653, lon: -70.8150, elev: 2207 },
    { name: "Las Campanas — Magellan",                lat: -29.0089, lon: -70.6920, elev: 2380 },
    { name: "Mauna Kea — Keck I & II",                lat:  19.8283, lon:-155.4783, elev: 4145 },
    { name: "Mauna Kea — Subaru",                     lat:  19.8255, lon:-155.4760, elev: 4139 },
    { name: "Mauna Kea — Gemini North",               lat:  19.8238, lon:-155.4690, elev: 4213 },
    { name: "Mauna Kea — CFHT",                       lat:  19.8255, lon:-155.4677, elev: 4204 },
    { name: "Mauna Kea — IRTF",                       lat:  19.8263, lon:-155.4719, elev: 4168 },
    { name: "La Palma — WHT (ING)",                   lat:  28.7603, lon: -17.8796, elev: 2332 },
    { name: "La Palma — NOT",                         lat:  28.7572, lon: -17.8852, elev: 2382 },
    { name: "La Palma — TNG",                         lat:  28.7546, lon: -17.8910, elev: 2387 },
    { name: "Kitt Peak — KPNO 4m",                    lat:  31.9633, lon:-111.6000, elev: 2096 },
    { name: "McDonald Observatory — HET",             lat:  30.6797, lon:-104.0225, elev: 2070 },
    { name: "Palomar — P200",                         lat:  33.3563, lon:-116.8628, elev: 1706 },
    { name: "Siding Spring — AAT",                    lat: -31.2754, lon: 149.0661, elev: 1164 },
    { name: "SAAO — Sutherland",                      lat: -32.3792, lon:  20.8108, elev: 1798 },
    { name: "Calar Alto — CAHA 3.5m",                 lat:  37.2236, lon:  -2.5468, elev: 2168 },
    { name: "Observatoire de Haute-Provence",         lat:  43.9317, lon:   5.7133, elev:  650 },
    { name: "OAN — SPM, Mexico",                      lat:  31.0442, lon:-115.4623, elev: 2800 },
  ];

  function _toRad(d) { return d * Math.PI / 180; }
  function _toDeg(r) { return r * 180 / Math.PI; }
  function _jd(date) { return date.getTime() / 86400000 + 2440587.5; }

  function _gmst(jd) {
    const T = (jd - 2451545.0) / 36525.0;
    let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
          + 0.000387933 * T * T - T * T * T / 38710000.0;
    return ((g % 360) + 360) % 360;
  }

  function _lst(jd, lonDeg) {
    return ((_gmst(jd) + lonDeg) % 360 + 360) % 360;
  }

  // Object altitude given (RA, Dec), site latitude, and local sidereal time.
  // All angles in degrees in/out.
  function _altitude(raDeg, decDeg, latDeg, lstDeg) {
    const ha  = _toRad(((lstDeg - raDeg) % 360 + 360) % 360);
    const dec = _toRad(decDeg);
    const lat = _toRad(latDeg);
    const sinAlt = Math.sin(dec) * Math.sin(lat)
                 + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
    return _toDeg(Math.asin(Math.max(-1, Math.min(1, sinAlt))));
  }

  // Pickering (2002) airmass — accurate down to the horizon, returns null
  // for objects below the horizon or above 15 airmasses (= un-observable).
  function _airmass(altDeg) {
    if (altDeg <= 0) return null;
    const am = 1.0 / Math.sin(_toRad(altDeg + 244.0 / (165.0 + 47.0 * Math.pow(altDeg, 1.1))));
    return am > 15 ? null : am;
  }

  // Low-precision Sun position (good to ~1° — fine for twilight shading).
  function _sunRaDec(jd) {
    const T   = (jd - 2451545.0) / 36525.0;
    const L0  = 280.46646  + 36000.76983 * T;
    const M   = 357.52911  + 35999.05029 * T - 0.0001537 * T * T;
    const C   = (1.914602  - 0.004817 * T - 0.000014 * T * T) * Math.sin(_toRad(M))
              + (0.019993  - 0.000101 * T) * Math.sin(2 * _toRad(M))
              + 0.000289 * Math.sin(3 * _toRad(M));
    const lon = L0 + C;
    const eps = 23.439291 - 0.013004 * T;
    const ra  = _toDeg(Math.atan2(Math.cos(_toRad(eps)) * Math.sin(_toRad(lon)),
                                  Math.cos(_toRad(lon))));
    const dec = _toDeg(Math.asin(Math.sin(_toRad(eps)) * Math.sin(_toRad(lon))));
    return { ra: ((ra % 360) + 360) % 360, dec };
  }

  // Low-precision Moon position (Meeus ch.47, truncated series).
  function _moonRaDec(jd) {
    const T  = (jd - 2451545.0) / 36525.0;
    const L1 = 218.3164477 + 481267.88123421 * T;
    const D  = 297.8501921 + 445267.1114034  * T;
    const M  = 357.5291092 +  35999.0502909  * T;
    const Mp = 134.9633964 + 477198.8675055  * T;
    const F  =  93.2720950 + 483202.0175233  * T;
    const lon = L1
      + 6.288774 * Math.sin(_toRad(Mp))
      + 1.274027 * Math.sin(_toRad(2 * D - Mp))
      + 0.658314 * Math.sin(_toRad(2 * D))
      + 0.213618 * Math.sin(_toRad(2 * Mp))
      - 0.185116 * Math.sin(_toRad(M))
      - 0.114332 * Math.sin(_toRad(2 * F))
      + 0.058793 * Math.sin(_toRad(2 * D - 2 * Mp))
      + 0.057066 * Math.sin(_toRad(2 * D - M - Mp))
      + 0.053322 * Math.sin(_toRad(2 * D + Mp))
      + 0.045758 * Math.sin(_toRad(2 * D - M));
    const lat = 0
      + 5.128122 * Math.sin(_toRad(F))
      + 0.280602 * Math.sin(_toRad(Mp + F))
      + 0.277693 * Math.sin(_toRad(Mp - F))
      + 0.173237 * Math.sin(_toRad(2 * D - F))
      + 0.055413 * Math.sin(_toRad(2 * D + F - Mp))
      + 0.046271 * Math.sin(_toRad(2 * D - F - Mp))
      + 0.032573 * Math.sin(_toRad(2 * D + F));
    const eps = 23.439291 - 0.013004 * T;
    const lRad = _toRad(lon), bRad = _toRad(lat), eRad = _toRad(eps);
    const x = Math.cos(bRad) * Math.cos(lRad);
    const y = Math.cos(eRad) * Math.cos(bRad) * Math.sin(lRad)
            - Math.sin(eRad) * Math.sin(bRad);
    const z = Math.sin(eRad) * Math.cos(bRad) * Math.sin(lRad)
            + Math.cos(eRad) * Math.sin(bRad);
    const ra  = _toDeg(Math.atan2(y, x));
    const dec = _toDeg(Math.asin(z));
    return { ra: ((ra % 360) + 360) % 360, dec };
  }

  // Great-circle angular separation (degrees) between two equatorial points.
  // Used for the Moon-to-object distance shown in the tooltip — proximity
  // matters because Moon scattering raises the sky background close in
  // (rule of thumb: avoid <30° from a near-full Moon for faint targets).
  function _angSep(ra1Deg, dec1Deg, ra2Deg, dec2Deg) {
    const ra1 = _toRad(ra1Deg), dec1 = _toRad(dec1Deg);
    const ra2 = _toRad(ra2Deg), dec2 = _toRad(dec2Deg);
    const cosD = Math.sin(dec1) * Math.sin(dec2)
               + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
    return _toDeg(Math.acos(Math.max(-1, Math.min(1, cosD))));
  }

  // Moon illuminated fraction (0-1).
  function _moonPhase(jd) {
    const T  = (jd - 2451545.0) / 36525.0;
    const D  = _toRad(297.8501921 + 445267.1114034 * T);
    const M  = _toRad(357.5291092 +  35999.0502909 * T);
    const Mp = _toRad(134.9633964 + 477198.8675055 * T);
    const i  = 180.0
      - _toDeg(D)
      - 6.289 * Math.sin(Mp)
      + 2.100 * Math.sin(M)
      - 1.274 * Math.sin(2 * D - Mp)
      - 0.658 * Math.sin(2 * D)
      - 0.214 * Math.sin(2 * Mp)
      - 0.110 * Math.sin(D);
    return (1 + Math.cos(_toRad(i))) / 2;
  }

  // Default night = next UTC night (today before noon UTC, tomorrow after).
  function _nextNightDate() {
    const now = new Date();
    const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (now.getUTCHours() >= 12) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  // Twilight shading by Sun altitude — daylight darkens through civil →
  // nautical → astronomical twilight, and `null` (true night) draws nothing.
  function _twilightColor(sunAlt) {
    if (sunAlt >= 0)    return "rgba(70,120,200,0.22)";
    if (sunAlt >= -6)   return "rgba(40,80,160,0.18)";
    if (sunAlt >= -12)  return "rgba(20,40,100,0.15)";
    if (sunAlt >= -18)  return "rgba(10,20,60,0.12)";
    return null;
  }

  // ============================================================
  //  Panel binding + compute pipeline
  // ============================================================

  function $(panel, sel) { return panel.querySelector(sel); }

  function fillObservatorySelect(panel) {
    const sel = $(panel, "[data-am-obs]");
    if (!sel || sel.options.length) return;
    OBSERVATORIES.forEach((obs, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = obs.name;
      sel.appendChild(o);
    });
    sel.value = "1"; // Default = Rubin / LSST.
  }

  function applyObservatory(panel) {
    const sel  = $(panel, "[data-am-obs]");
    const lat  = $(panel, "[data-am-lat]");
    const lon  = $(panel, "[data-am-lon]");
    const elev = $(panel, "[data-am-elev]");
    if (!sel) return;
    const obs = OBSERVATORIES[parseInt(sel.value, 10)];
    if (obs && obs.lat != null) {
      lat.value  = obs.lat;
      lon.value  = obs.lon;
      elev.value = obs.elev;
    } else {
      lat.value = lon.value = elev.value = "";
    }
  }

  function compute(panel) {
    const lat     = parseFloat($(panel, "[data-am-lat]").value);
    const lon     = parseFloat($(panel, "[data-am-lon]").value);
    const dateStr = $(panel, "[data-am-date]").value;
    const status  = $(panel, "[data-am-status]");
    if (Number.isNaN(lat) || Number.isNaN(lon) || !dateStr) {
      if (status) status.textContent = "Pick observatory + date.";
      return;
    }

    // Object RA/Dec ride along on the panel's dataset (set by the toggle).
    let objRa = parseFloat(panel.dataset.ra);
    let objDec = parseFloat(panel.dataset.dec);
    if (Number.isNaN(objRa) || Number.isNaN(objDec)) {
      objRa = null; objDec = null;
    }

    // Time grid: noon UTC on the chosen day → noon next day, every 15 min.
    const [yr, mo, dy] = dateStr.split("-").map(Number);
    const t0 = new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0));
    const STEPS = 96;
    const STEP_MS = 15 * 60 * 1000;
    const xHours = [], labels = [], amObj = [], amMoon = [], moonPhaseArr = [], sunAlts = [];
    // Angular Moon-to-object separation (degrees) per time step. null when
    // no object is selected — the tooltip only shows it when both bodies
    // are known.
    const moonDistArr = [];
    for (let i = 0; i <= STEPS; i++) {
      const t   = new Date(t0.getTime() + i * STEP_MS);
      const jd  = _jd(t);
      const lst = _lst(jd, lon);
      xHours.push(i * 0.25);
      labels.push(
        String(t.getUTCHours()).padStart(2, "0") + ":" +
        String(t.getUTCMinutes()).padStart(2, "0") + " UTC"
      );
      const sun     = _sunRaDec(jd);
      sunAlts.push(_altitude(sun.ra, sun.dec, lat, lst));
      const moon    = _moonRaDec(jd);
      amMoon.push(_airmass(_altitude(moon.ra, moon.dec, lat, lst)));
      moonPhaseArr.push(_moonPhase(jd));
      if (objRa != null && objDec != null) {
        amObj.push(_airmass(_altitude(objRa, objDec, lat, lst)));
        moonDistArr.push(_angSep(objRa, objDec, moon.ra, moon.dec));
      } else {
        amObj.push(null);
        moonDistArr.push(null);
      }
    }

    if (status) {
      const obsTag = (objRa != null)
        ? `RA=${objRa.toFixed(4)} Dec=${objDec.toFixed(4)}`
        : "no object selected";
      status.textContent = `${dateStr} UTC · ${obsTag}`;
    }
    drawChart(panel, { xHours, labels, amObj, amMoon, moonPhaseArr, moonDistArr, sunAlts });
  }

  function drawChart(panel, data) {
    const canvas = $(panel, ".airmass-canvas");
    if (!canvas) return;
    const { xHours, labels, amObj, amMoon, moonPhaseArr, moonDistArr, sunAlts } = data;

    // Twilight rectangles — drawn beneath the data series so the airmass
    // line stays foreground. Iterates the time grid and paints one rect
    // per 15-min slot whose Sun altitude has a non-null colour mapping.
    const twilightPlugin = {
      id: "amTwilightBg",
      beforeDraw(chart) {
        const { ctx, scales: { x, y } } = chart;
        ctx.save();
        for (let i = 0; i < xHours.length - 1; i++) {
          const col = _twilightColor(sunAlts[i]);
          if (!col) continue;
          const x0 = x.getPixelForValue(xHours[i]);
          const x1 = x.getPixelForValue(xHours[i + 1]);
          const yTop = y.getPixelForValue(y.max);
          const yBot = y.getPixelForValue(y.min);
          ctx.fillStyle = col;
          ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
        }
        ctx.restore();
      },
    };

    // Reference horizontal lines at standard airmass thresholds (1.5, 2, 3)
    // — quick visual gauge of how much of the night is "good seeing".
    const refLinePlugin = {
      id: "amRefLines",
      afterDatasetsDraw(chart) {
        const { ctx, scales: { x, y } } = chart;
        const refs = [
          [1.5, "#58a6ff44", "1.5"],
          [2.0, "#d2992244", "2.0"],
          [3.0, "#f8514944", "3.0"],
        ];
        refs.forEach(([am, col, lbl]) => {
          if (am > y.max || am < y.min) return;
          const yPx = y.getPixelForValue(am);
          ctx.save();
          ctx.strokeStyle = col;
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x.left, yPx); ctx.lineTo(x.right, yPx); ctx.stroke();
          ctx.fillStyle = col.replace("44", "cc");
          ctx.font = "9px IBM Plex Mono";
          ctx.textAlign = "left";
          ctx.setLineDash([]);
          ctx.fillText(`X=${lbl}`, x.left + 4, yPx - 3);
          ctx.restore();
        });
      },
    };

    const datasets = [];
    if (amObj.some((v) => v != null)) {
      datasets.push({
        label: "Object",
        data: xHours.map((h, i) => ({ x: h, y: amObj[i] })),
        borderColor: "#58a6ff",
        backgroundColor: "#58a6ff",
        pointRadius: 1.5,
        showLine: true,
        tension: 0.3,
        spanGaps: false,
        order: 1,
      });
    }
    datasets.push({
      label: "Moon",
      data: xHours.map((h, i) => ({ x: h, y: amMoon[i] })),
      borderColor: "#f0c040aa",
      backgroundColor: "#f0c040",
      pointRadius: 1.5,
      borderDash: [4, 3],
      showLine: true,
      tension: 0.3,
      spanGaps: false,
      order: 2,
    });

    // Destroy any prior chart on this canvas — Chart.js leaks listeners
    // if we create a new chart on top of an existing one.
    if (canvas._airmassChart) {
      canvas._airmassChart.destroy();
      canvas._airmassChart = null;
    }
    canvas._airmassChart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: {
            type: "linear",
            min: 0, max: 24,
            ticks: {
              stepSize: 2,
              color: "#6e7681",
              font: { size: 9 },
              callback: (v) => {
                const idx = Math.round(v / 0.25);
                return (labels[Math.min(idx, labels.length - 1)] || "").slice(0, 5);
              },
            },
            grid: { color: "#21262d" },
            title: { display: true, text: "UTC Time", color: "#6e7681", font: { size: 10 } },
          },
          y: {
            reverse: true,
            min: 1, max: 4,
            ticks: { color: "#6e7681", font: { size: 9 }, stepSize: 0.5 },
            grid: { color: "#21262d" },
            title: { display: true, text: "Airmass (low = better)", color: "#6e7681", font: { size: 10 } },
          },
        },
        plugins: {
          legend: { display: true, labels: { color: "#8b949e", font: { size: 10 }, boxWidth: 12 } },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              title: (items) => {
                const idx = Math.round(items[0].parsed.x / 0.25);
                return labels[Math.min(idx, labels.length - 1)] || "";
              },
              label: (item) => {
                const idx = Math.round(item.parsed.x / 0.25);
                const am = item.parsed.y;
                if (item.dataset.label === "Moon") {
                  const phase = moonPhaseArr[Math.min(idx, moonPhaseArr.length - 1)];
                  const pct   = (phase * 100).toFixed(0);
                  const icon  = phase < 0.05 ? "🌑"
                              : phase < 0.25 ? "🌒"
                              : phase < 0.50 ? "🌓"
                              : phase < 0.75 ? "🌔" : "🌕";
                  // Angular Moon-to-object separation; null when no object
                  // is selected, in which case we omit the suffix instead
                  // of writing "Δ NaN°".
                  const dist = moonDistArr[Math.min(idx, moonDistArr.length - 1)];
                  const distSuffix = dist != null ? ` · ${dist.toFixed(1)}° from object` : "";
                  return am != null
                    ? `Moon: X=${am.toFixed(2)}  ${icon} ${pct}% illuminated${distSuffix}`
                    : `Moon: below horizon  ${icon} ${pct}% illuminated${distSuffix}`;
                }
                return am != null ? `Object: X=${am.toFixed(3)}` : "Object: below horizon";
              },
            },
          },
        },
      },
      plugins: [twilightPlugin, refLinePlugin],
    });
  }

  function bindPanel(panel) {
    if (panel._airmassBound) return;
    panel._airmassBound = true;

    fillObservatorySelect(panel);

    // Default date = next UTC night.
    const dateInput = $(panel, "[data-am-date]");
    if (dateInput && !dateInput.value) dateInput.value = _nextNightDate();

    // Apply preset → fill lat/lon/elev. User edits on those fields drop
    // back to the "Custom" preset so the displayed name doesn't lie.
    const obsSel = $(panel, "[data-am-obs]");
    if (obsSel) {
      obsSel.addEventListener("change", () => applyObservatory(panel));
      applyObservatory(panel);
    }
    ["[data-am-lat]", "[data-am-lon]", "[data-am-elev]"].forEach((sel) => {
      const el = $(panel, sel);
      if (!el) return;
      el.addEventListener("input", () => {
        if (obsSel) obsSel.value = "0";
      });
    });

    const computeBtn = $(panel, "[data-am-compute]");
    if (computeBtn) computeBtn.addEventListener("click", () => compute(panel));

    const closeBtn = $(panel, "[data-am-close]");
    if (closeBtn) closeBtn.addEventListener("click", () => closePanel());
  }

  // Is the GP overlay active on this detail view's LC chart? (Determines
  // whether closing this panel should restore Color Evolution or Position
  // Residuals into the shared cell.)
  function gpActiveInCell() {
    const slot = document.getElementById("color-evolution-slot");
    const panel = slot && slot.querySelector("[data-color-panel]");
    const lcId = panel && panel.dataset.lcTarget;
    return !!(lcId && window.lcGpActive && window.lcGpActive(lcId));
  }

  function closePanel() {
    const cr = document.getElementById("coord-residuals-slot");
    const ce = document.getElementById("color-evolution-slot");
    const am = document.getElementById("airmass-slot");
    if (!am) return;
    am.classList.add("tw-hidden");
    // Restore Color Evolution if GP is active, else Position Residuals.
    if (ce && gpActiveInCell()) ce.classList.remove("tw-hidden");
    else if (cr) cr.classList.remove("tw-hidden");
    syncAirmassButton(false);
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("lc:gpChanged")); // rebuild a restored CE chart
  }

  // Highlights the basic-info "Airmass" button while the panel is on screen.
  function syncAirmassButton(active) {
    document.querySelectorAll(".basic-info-airmass-btn").forEach((btn) => {
      btn.classList.toggle("tw-bg-accent", active);
      btn.classList.toggle("tw-text-bg-primary", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function initAll(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-airmass-panel]").forEach(bindPanel);
  }

  // Toggle airmass-slot ↔ coord-residuals-slot, also hiding periodogram
  // since the three share a single grid cell.
  window.toggleAirmassPanel = function (oid, ra, dec) {
    const cr = document.getElementById("coord-residuals-slot");
    const pg = document.getElementById("periodogram-slot");
    const am = document.getElementById("airmass-slot");
    if (!am) return;
    const ce = document.getElementById("color-evolution-slot");
    const showAm = am.classList.contains("tw-hidden");
    if (showAm) {
      if (cr) cr.classList.add("tw-hidden");
      if (pg) pg.classList.add("tw-hidden");
      if (ce) ce.classList.add("tw-hidden");
      am.classList.remove("tw-hidden");
      const panel = am.querySelector("[data-airmass-panel]");
      if (panel) {
        if (ra != null) panel.dataset.ra = ra;
        if (dec != null) panel.dataset.dec = dec;
      }
      // Force a resize so Chart.js can measure the now-visible canvas the
      // first time the panel is shown.
      window.dispatchEvent(new Event("resize"));
      syncAirmassButton(true);
    } else {
      closePanel();
    }
  };

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
