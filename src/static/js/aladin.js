// Aladin Lite sky viewer.
//
// The panel server-renders just an empty .aladin-host div with data-ra /
// data-dec / data-oid. We:
//   1. Lazy-load Aladin Lite v3 from CDS CDN (~1 MB) the first time an
//      aladin host appears — not on every page view.
//   2. Probe HiPS surveys in priority order (PanSTARRS DR1 → DESI DR10 →
//      SkyMapper DR4) against the object's RA/Dec using the hips2fits FITS
//      cutout service. A tiny 16×16 cutout is enough to tell coverage from
//      background: if any pixel is finite and non-zero, the survey has data
//      there. Fall back to DSS Color if none of the priority surveys cover
//      the target.
//   3. Init Aladin on the host, add a marker for the object.
//
// We use hips2fits (not JPEG) because the hips2fits service returns
// all-zero FITS data for out-of-coverage positions, whereas JPEG pickers
// can't distinguish black pixels from no-data.

(function () {
  const booted = new WeakSet();

  const HIPS_SURVEYS = [
    { id: "CDS/P/PanSTARRS/DR1/color-i-r-g",      label: "PanSTARRS DR1" },
    { id: "CDS/P/DESI-Legacy-Surveys/DR10/color", label: "DESI DR10" },
    { id: "CDS/P/Skymapper/DR4/color",            label: "SkyMapper DR4" },
  ];
  const HIPS_FALLBACK = { id: "https://alaskybis.cds.unistra.fr/DSS/DSSColor", label: "DSS Color" };

  const ALADIN_PRIMARY  = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";
  const ALADIN_FALLBACK = "https://aladin.u-strasbg.fr/AladinLite/api/v3/latest/aladin.js";

  let aladinLoadPromise = null;

  function loadAladinLib() {
    if (aladinLoadPromise) return aladinLoadPromise;
    aladinLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = ALADIN_PRIMARY;
      script.onload = () => resolve();
      script.onerror = () => {
        console.warn("Aladin primary CDN failed; trying fallback");
        const fb = document.createElement("script");
        fb.src = ALADIN_FALLBACK;
        fb.onload = () => resolve();
        fb.onerror = () => reject(new Error("All Aladin CDNs unreachable"));
        document.head.appendChild(fb);
      };
      document.head.appendChild(script);
    });
    return aladinLoadPromise;
  }

  async function waitForAladinGlobal(timeoutMs = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (typeof window.A !== "undefined" && window.A.init) return window.A;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Aladin global A not present after load");
  }

  async function probeHiPS(hipsId, ra, dec) {
    const url =
      "https://alasky.cds.unistra.fr/hips-image-services/hips2fits?" +
      `hips=${encodeURIComponent(hipsId)}&width=16&height=16&fov=0.05` +
      `&ra=${ra}&dec=${dec}&projection=TAN&format=fits`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return false;
      const buf = await resp.arrayBuffer();
      return fitsHasData(buf);
    } catch {
      return false;
    }
  }

  // Minimal FITS scanner: walk 80-byte cards in 2880-byte blocks until END,
  // then look for any finite non-zero pixel in the data section.
  function fitsHasData(buf) {
    const bytes = new Uint8Array(buf);
    let bitpix = -32;
    let headerBlocks = 1;
    outer: for (let block = 0; block * 2880 < bytes.length; block++) {
      for (let card = 0; card < 36; card++) {
        const pos = block * 2880 + card * 80;
        const key = String.fromCharCode(...bytes.slice(pos, pos + 8)).trim();
        if (key === "BITPIX") {
          const valStr = String.fromCharCode(...bytes.slice(pos + 10, pos + 30));
          const parsed = parseInt(valStr);
          if (!isNaN(parsed)) bitpix = parsed;
        }
        if (key === "END") { headerBlocks = block + 1; break outer; }
      }
    }
    const dataStart = headerBlocks * 2880;
    if (dataStart >= buf.byteLength) return false;
    const dv = new DataView(buf, dataStart);
    const bpp = Math.abs(bitpix) / 8;
    const nPix = Math.floor((buf.byteLength - dataStart) / bpp);
    for (let i = 0; i < nPix; i++) {
      let val;
      if (bitpix === -32) val = dv.getFloat32(i * 4, false);
      else if (bitpix === -64) val = dv.getFloat64(i * 8, false);
      else if (bitpix === 16) val = dv.getInt16(i * 2, false);
      else if (bitpix === 32) val = dv.getInt32(i * 4, false);
      else if (bitpix === 8) val = bytes[dataStart + i];
      else continue;
      if (val !== 0 && isFinite(val)) return true;
    }
    return false;
  }

  // Galactic latitude (deg) — reuse dust.js's helper when present (same IAU
  // 1958 pole), with an inline fallback so we never depend on script order.
  function galacticLat(ra, dec) {
    if (window.dust && typeof window.dust.galacticLatitude === "function") {
      return window.dust.galacticLatitude(ra, dec);
    }
    const toRad = Math.PI / 180;
    const decNGP = 27.12825 * toRad, raNGP = 192.85948 * toRad;
    const sinB = Math.sin(dec * toRad) * Math.sin(decNGP)
               + Math.cos(dec * toRad) * Math.cos(decNGP) * Math.cos(ra * toRad - raNGP);
    return Math.asin(sinB) / toRad;
  }

  // Provisional survey to boot on before the coverage probe resolves, picked
  // from the sky position so first paint usually shows the right imagery:
  //   1. Dec > -30°            → PanSTARRS DR1 (covers the northern ~3/4 sky)
  //   2. else |b| ≤ 18°        → SkyMapper DR4 (DESI masks the Galactic plane)
  //   3. else                  → DESI DR10 (deep southern coverage off-plane)
  const HIPS_PANSTARRS = HIPS_SURVEYS[0];
  const HIPS_DESI      = HIPS_SURVEYS[1];
  const HIPS_SKYMAPPER = HIPS_SURVEYS[2];
  function pickInitialSurvey(ra, dec) {
    if (dec > -30) return HIPS_PANSTARRS;
    if (Math.abs(galacticLat(ra, dec)) <= 18) return HIPS_SKYMAPPER;
    return HIPS_DESI;
  }
  // Exposed for unit testing (tests-js/aladin.test.js). The viewer boot path
  // itself needs a WebGL2 context and is covered by the e2e suite / manual QA;
  // this pure position→survey decision is what the unit test pins down.
  window.__aladinPickInitialSurvey = pickInitialSurvey;

  async function chooseBestHiPS(ra, dec) {
    const results = await Promise.all(HIPS_SURVEYS.map((s) => probeHiPS(s.id, ra, dec)));
    console.log(
      "HiPS probes — " +
        HIPS_SURVEYS.map((s, i) => `${s.label}:${results[i]}`).join(", "),
    );
    const idx = results.indexOf(true);
    return idx >= 0 ? HIPS_SURVEYS[idx] : HIPS_FALLBACK;
  }

  async function initHost(host) {
    const ra = parseFloat(host.dataset.ra);
    const dec = parseFloat(host.dataset.dec);
    const oid = host.dataset.oid || "";
    const surveyId = host.dataset.survey || "";
    const lastmjd = parseFloat(host.dataset.lastmjd);
    const legendEl = document.getElementById(host.dataset.legendId || "");
    const loadingEl = host.querySelector(".aladin-loading");
    if (!isFinite(ra) || !isFinite(dec)) return;

    try {
      await loadAladinLib();
      const A = await waitForAladinGlobal();
      await A.init;

      // Boot the viewer immediately on a provisional survey instead of
      // blocking on the HiPS coverage probe first. chooseBestHiPS fetches a
      // 16×16 FITS cutout per survey (up to an 8 s timeout each) before it
      // can pick the best-covered imagery — awaiting it here meant the panel
      // showed nothing but "loading sky view…" for that whole window. We
      // boot on a provisional survey picked from the sky position (see
      // pickInitialSurvey), then probe coverage in the background and swap
      // the base layer + legend label to the best survey if it differs. This
      // is the "show Aladin first, do the look-ups in parallel" path: the
      // spec-z / crossmatch overlays (fired below) and the coverage probe all
      // resolve after the viewer is already on screen.
      const initialSurvey = pickInitialSurvey(ra, dec);
      let surveyChip = null;
      if (legendEl) {
        legendEl.innerHTML = "";
        legendEl.classList.add("tw-flex", "tw-flex-wrap", "tw-gap-2", "tw-justify-end");
        surveyChip = addLegendChip(legendEl, initialSurvey.label, null);
      }

      // A detail-view teardown (object navigation / Back) can detach this host
      // while we awaited the Aladin CDN + WebGL init above. Bail before we
      // allocate an Aladin instance (and its WebGL context) that would
      // immediately leak on a node no longer in the document. detail-cleanup.js
      // sets `torndown` on the host synchronously when it tears the view down;
      // everything below here is synchronous, so one guard is enough.
      if (host.dataset.torndown === "1" || !host.isConnected) return;

      // Aladin needs a concrete div id to attach to; inject one.
      const innerId = `aladin-inner-${oid || Math.random().toString(36).slice(2)}`;
      if (loadingEl) loadingEl.remove();
      const inner = document.createElement("div");
      inner.id = innerId;
      inner.style.width = "100%";
      inner.style.height = "100%";
      host.appendChild(inner);
      currentAladinView = inner;   // measured by isAladinFullscreenNow()
      startFullscreenWatch();      // keep page chrome from bleeding over fullscreen

      const aladin = A.aladin(`#${innerId}`, {
        target: `${ra} ${dec}`,
        fov: 0.025,
        survey: initialSurvey.id,
        showReticle: true,
        showZoomControl: true,
        showLayersControl: true,
      });

      // Background coverage probe → upgrade the base layer once the best
      // survey is known. Non-blocking (no await) so it can't delay first
      // paint; on failure we silently keep the provisional layer.
      chooseBestHiPS(ra, dec).then((best) => {
        if (best.id !== initialSurvey.id) {
          try { aladin.setImageSurvey(best.id); }
          catch (e) { console.warn("Aladin base-layer swap failed:", e); }
        }
        if (surveyChip) surveyChip.textContent = best.label;
      }).catch(() => { /* keep the provisional survey + label */ });

      const cat = A.catalog({ name: "Object", sourceSize: 14, color: "#1976d2" });
      aladin.addCatalog(cat);
      cat.addSources([A.source(ra, dec, { name: String(oid) })]);

      // Clicks on any catalog source (object / overlay / LSST neighbour) fire
      // `objectClicked`. We (a) show the source's details in the 2-row info bar
      // at the bottom of the panel — not Aladin's hard-to-close popup — and
      // (b) when the source carries a `z`, copy it into the per-oid redshift
      // input so other panels (absolute-mag mode, …) can pick it up.
      const infoEl = document.getElementById(`aladin-info-${oid}`);
      aladin.on("objectClicked", function (obj) {
        if (!obj || !obj.data) return;
        const { row1, row2 } = describeSource(obj.data);
        // In fullscreen the bottom info bar is off-screen, so show a small,
        // easy-to-close popup instead. Aladin Lite uses a CSS fullscreen (a
        // fixed overlay), not the native Fullscreen API, so we detect it by the
        // view covering the viewport rather than document.fullscreenElement.
        if (isAladinFullscreenNow()) showInfoPopup(row1, row2);
        else { setInfoBar(infoEl, row1, row2); hideInfoPopup(); }
        const zStr = obj.data.z;
        if (!zStr || zStr === "?") return;
        const z = parseFloat(zStr);
        if (isNaN(z) || z <= 0) return;
        const input = document.getElementById(`lc-redshift-${oid}`);
        if (!input) return;
        input.value = z.toFixed(5);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });

      // Spec-z and LSST-neighbour queries fire concurrently: spec-z catalogs
      // have a 20s per-request timeout and one slow VizieR endpoint can
      // delay the whole batch — we don't want that to also push back the
      // LSST gray-squares overlay (which the user cares about most for
      // trail-spotting). Each overlay manages its own legend chip + Aladin
      // layer, so they can interleave safely.
      if (typeof window.loadSpecZOverlays === "function") {
        window.loadSpecZOverlays(aladin, oid, surveyId, (info) => {
          // One grouped legend entry per category (Stars / AGN/QSO /
          // Galaxies (specz)). info.label already carries the count (and the
          // spec-z qualifier for galaxies), matching the Aladin layer name.
          addLegendChip(legendEl, info.label, info.color);
        });
      }
      loadLsstNeighbors(aladin, ra, dec, lastmjd, oid, legendEl);

      // Wire the stamp-footprint overlay. The handler is module-scoped
      // (registered once below) and discovers this host via the live
      // .aladin-host element, so we just stash the Aladin instance and
      // replay any footprint that already arrived while Aladin was
      // booting (stamps.js may resolve its FITS fetch before the Aladin
      // CDN finishes loading on a cold cache).
      host.$aladin = aladin;
      if (host.$stampFootprintLatest) {
        applyStampFootprint(host, host.$stampFootprintLatest);
      }
    } catch (e) {
      console.error("Aladin init failed:", e);
      if (loadingEl) {
        loadingEl.textContent = `Aladin unavailable: ${e.message || e}`;
      }
    }
  }

  // Server-side cone-search for LSST objects within 10 arcmin and ±2 hr of
  // the current object's last detection — drawn as gray squares so the user
  // can spot contemporaneous detections that hint at a satellite/asteroid
  // trail. We always query LSST regardless of the detail-view survey: the
  // question is "what LSST sources were active here at this moment". Bailing
  // out silently if `lastmjd` isn't on the host (object_info didn't expose
  // it) — the rest of the panel still works.
  async function loadLsstNeighbors(aladin, ra, dec, lastmjd, oid, legendEl) {
    if (typeof window.A === "undefined") return;
    if (!isFinite(lastmjd)) return;
    const url = `/api/lsst_neighbors?ra=${ra}&dec=${dec}&lastmjd=${lastmjd}`
              + (oid ? `&exclude_oid=${encodeURIComponent(oid)}` : "");
    let rows;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) {
        console.warn(`lsst_neighbors HTTP ${resp.status}`);
        return;
      }
      rows = await resp.json();
    } catch (e) {
      console.warn("lsst_neighbors failed:", e.message);
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      addLegendChip(legendEl, "LSST neighbours (0)", "#9ca3af");
      return;
    }
    const color = "#9ca3af";  // gray-400
    const cat = window.A.catalog({
      name: `LSST neighbours (${rows.length})`,
      sourceSize: 12,
      color,
      shape: "square",
      onClick: () => {},   // info bar, not popup (see objectClicked)
    });
    aladin.addCatalog(cat);
    const sources = rows.map((r) => window.A.source(r.ra, r.dec, {
      name: `LSST ${r.oid}`,
      oid: r.oid,
      lastmjd: typeof r.lastmjd === "number" ? r.lastmjd.toFixed(5) : String(r.lastmjd),
    }));
    cat.addSources(sources);
    addLegendChip(legendEl, `LSST neighbours (${rows.length})`, color);
  }

  // Stamp footprint overlay. `corners` is [[ra, dec], …] in degrees,
  // walking the four image corners (already closed by re-appending the
  // first point inside the polyline). One graphicOverlay per host,
  // re-created on the first call and reused on every subsequent update
  // so we can swap the polygon by `removeAll()` rather than allocating
  // a fresh Aladin layer on every detection click.
  function applyStampFootprint(host, corners) {
    const aladin = host.$aladin;
    if (!aladin || !window.A || !corners || corners.length < 3) return;
    if (!host.$stampFootprintOverlay) {
      host.$stampFootprintOverlay = window.A.graphicOverlay({
        color: "#fbbf24",     // amber — distinct from the object marker
        lineWidth: 1.5,       //         (blue), spec-z chips, and gray
      });                     //         LSST-neighbour squares.
      aladin.addOverlay(host.$stampFootprintOverlay);
    } else {
      host.$stampFootprintOverlay.removeAll();
    }
    const closed = corners.concat([corners[0]]);
    host.$stampFootprintOverlay.add(window.A.polyline(closed));
  }

  // Single delegated listener: stamps.js dispatches the event each time
  // the science stamp finishes parsing, and we route it to whichever
  // .aladin-host happens to be live on the page.
  document.addEventListener("stamp:footprintChanged", (evt) => {
    const host = document.querySelector(".aladin-host");
    if (!host) return;
    host.$stampFootprintLatest = evt.detail.footprint;
    applyStampFootprint(host, evt.detail.footprint);
  });

  // A clicked source → two display rows. Handles the three source flavours:
  // external crossmatch (Source/ID/label), LSST neighbour (oid/lastmjd), object.
  function describeSource(data) {
    let row1 = "", row2 = "";
    if (data.Source) {
      row1 = data.ID ? `${data.Source} · ${data.ID}` : data.Source;
      const bits = [];
      if (data.label) bits.push(data.label);
      else {
        if (data.z) bits.push(`z = ${data.z}`);
        if (data.Type) bits.push(data.Type);
      }
      if (data.Separation) bits.push(data.Separation);
      row2 = bits.join(" · ");
    } else if (data.oid) {
      row1 = `LSST neighbour · ${data.oid}`;
      row2 = data.lastmjd ? `lastmjd ${data.lastmjd}` : "";
    } else {
      row1 = String(data.name || "object");
    }
    return { row1, row2 };
  }

  // Non-fullscreen: the 2-row info bar at the bottom of the panel.
  function setInfoBar(infoEl, row1, row2) {
    if (!infoEl) return;
    const r1 = infoEl.querySelector(".aladin-info-row1");
    const r2 = infoEl.querySelector(".aladin-info-row2");
    if (r1) r1.textContent = row1;
    if (r2) r2.textContent = row2 || "";
  }

  // The Aladin view element currently on the page (the div Aladin renders into).
  let currentAladinView = null;

  // Aladin Lite's fullscreen is a CSS fixed-overlay, NOT the native Fullscreen
  // API, so document.fullscreenElement stays null. Detect it by the view (or a
  // descendant Aladin container, or an `.aladin-fullscreen` class) covering the
  // whole viewport.
  function isAladinFullscreenNow() {
    if (document.fullscreenElement) return true;
    if (document.querySelector(".aladin-fullscreen")) return true;
    const el = currentAladinView;
    if (!el) return false;
    const cands = [el, el.querySelector && el.querySelector(".aladin-container")];
    for (const c of cands) {
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (r.width >= window.innerWidth - 4 && r.height >= window.innerHeight - 4) return true;
    }
    return false;
  }

  // While Aladin is CSS-fullscreen, (a) raise its overlay above all page chrome
  // (panel-help tooltips are z-50 and would otherwise bleed over the sky view),
  // (b) flag <body> so a CSS rule can hide those tooltips, and (c) drop the info
  // popup once fullscreen ends. One lightweight always-on poll (Aladin emits no
  // event for its CSS fullscreen).
  let fsWatch = null;
  function startFullscreenWatch() {
    if (fsWatch) return;
    fsWatch = setInterval(() => {
      const fs = isAladinFullscreenNow();
      document.body.classList.toggle("aladin-fs-active", fs);
      const el = currentAladinView;
      if (el) {
        const cc = el.querySelector && el.querySelector(".aladin-container");
        el.style.zIndex = fs ? "2147483646" : "";
        if (cc) cc.style.zIndex = fs ? "2147483646" : "";
      }
      if (!fs) hideInfoPopup();
    }, 350);
  }
  // Stop the poll when the detail view is torn down — there's no Aladin left to
  // watch, and an always-on 350 ms timer pinning `currentAladinView` would keep
  // the last view's node alive. detail-cleanup.js calls this on teardown.
  function stopFullscreenWatch() {
    if (fsWatch) { clearInterval(fsWatch); fsWatch = null; }
    currentAladinView = null;
    document.body.classList.remove("aladin-fs-active");
  }
  window.__aladinStopFullscreenWatch = stopFullscreenWatch;

  // Fullscreen popup: a fixed, max-z-index box on document.body (so it paints
  // over Aladin's fullscreen overlay) with an easy × to close. Singleton.
  let infoPopup = null;
  function getInfoPopup() {
    if (infoPopup) return infoPopup;
    infoPopup = document.createElement("div");
    infoPopup.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:80vw;" +
      "background:rgba(18,18,18,0.92);border:1px solid #444;border-radius:4px;" +
      "padding:6px 28px 6px 10px;font:12px/1.35 'IBM Plex Mono',ui-monospace,monospace;" +
      "color:#ededed;pointer-events:auto;";
    const r1 = document.createElement("div"); r1.className = "aip-r1";
    const r2 = document.createElement("div"); r2.className = "aip-r2"; r2.style.color = "#a6a6a6";
    const close = document.createElement("button");
    close.textContent = "×"; close.setAttribute("aria-label", "Close");
    close.style.cssText =
      "position:absolute;top:1px;right:7px;background:none;border:none;color:#a6a6a6;" +
      "font-size:17px;line-height:1;cursor:pointer;";
    close.onclick = hideInfoPopup;
    infoPopup.append(r1, r2, close);
    document.body.appendChild(infoPopup);
    return infoPopup;
  }
  function showInfoPopup(row1, row2) {
    const p = getInfoPopup();
    p.querySelector(".aip-r1").textContent = row1;
    p.querySelector(".aip-r2").textContent = row2 || "";
    p.style.display = "block";
  }
  function hideInfoPopup() {
    if (infoPopup) infoPopup.style.display = "none";
  }
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) hideInfoPopup();
  });

  function addLegendChip(legendEl, label, color) {
    if (!legendEl) return;
    const chip = document.createElement("span");
    chip.className = "tw-inline-flex tw-items-center tw-gap-1";
    if (color) {
      const dot = document.createElement("span");
      dot.className = "tw-inline-block tw-w-2 tw-h-2 tw-rounded-full";
      dot.style.background = color;
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(label));
    legendEl.appendChild(chip);
    return chip;
  }

  // Plot ALL crossmatch objects (every CDS/NED match with a position, plus all
  // catsHTM objects) in the live Aladin panel — driven by the "Show all in sky
  // view" button in the Crossmatch panel. CDS/NED keep the category colours
  // (cross markers, to distinguish from the auto z-overlay circles); catsHTM is
  // cyan triangles. Toggles visibility on repeat clicks. Returns the new shown
  // state (true/false), or null if there's no live Aladin / nothing to plot.
  const CAT_LABEL = { stellar: "Stars", agn: "AGN/QSO", host: "Galaxies" };
  window.showAllCrossmatchInAladin = function (payload) {
    const host = document.querySelector(".aladin-host");
    const aladin = host && host.$aladin;
    if (!aladin || typeof window.A === "undefined" || !payload) return null;

    if (host.$xmAllLayers) {                         // already built → toggle
      host.$xmAllShown = !host.$xmAllShown;
      host.$xmAllLayers.forEach((c) => {
        if (host.$xmAllShown) { if (c.show) c.show(); }
        else if (c.hide) c.hide();
      });
      return host.$xmAllShown;
    }

    const layers = [];
    const byCat = { stellar: [], agn: [], host: [] };
    for (const m of payload.cds || []) {
      if (m.ra == null || m.dec == null) continue;
      (byCat[m.category] || byCat.host).push(m);
    }
    for (const cat of ["stellar", "agn", "host"]) {
      const items = byCat[cat];
      if (!items.length) continue;
      const c = window.A.catalog({
        name: `All ${CAT_LABEL[cat]} (${items.length})`,
        sourceSize: 10, color: items[0].color || "#9ccc65", shape: "cross",
        onClick: () => {},
      });
      aladin.addCatalog(c);
      c.addSources(items.map((m) => window.A.source(m.ra, m.dec, {
        Source: m.cat_name, ID: m.name || "",
        z: m.z != null ? Number(m.z).toFixed(5) : null,
        Type: m.type || null,
        Separation: m.sep != null ? `${Number(m.sep).toFixed(2)}″` : null,
      })));
      layers.push(c);
    }
    const cm = payload.catshtm || [];
    if (cm.length) {
      const c = window.A.catalog({
        name: `catsHTM (${cm.length})`, sourceSize: 10, color: "#67e8f9",
        shape: "triangle", onClick: () => {},
      });
      aladin.addCatalog(c);
      c.addSources(cm.map((m) => window.A.source(m.ra, m.dec,
        { Source: "catsHTM", ID: m.name || "", label: m.props || "" })));
      layers.push(c);
    }
    if (!layers.length) return null;
    host.$xmAllLayers = layers;
    host.$xmAllShown = true;
    return true;
  };

  function initAll(root) {
    const hosts = (root || document).querySelectorAll(".aladin-host");
    hosts.forEach((host) => {
      if (booted.has(host)) return;
      booted.add(host);
      initHost(host);
    });
  }

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));
})();
