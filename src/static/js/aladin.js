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
    const lastmjd = parseFloat(host.dataset.lastmjd);
    const legendEl = document.getElementById(host.dataset.legendId || "");
    const loadingEl = host.querySelector(".aladin-loading");
    if (!isFinite(ra) || !isFinite(dec)) return;

    try {
      await loadAladinLib();
      const A = await waitForAladinGlobal();
      await A.init;

      const survey = await chooseBestHiPS(ra, dec);
      if (legendEl) {
        legendEl.innerHTML = "";
        legendEl.classList.add("tw-flex", "tw-flex-wrap", "tw-gap-2", "tw-justify-end");
        addLegendChip(legendEl, survey.label, null);
      }

      // Aladin needs a concrete div id to attach to; inject one.
      const innerId = `aladin-inner-${oid || Math.random().toString(36).slice(2)}`;
      if (loadingEl) loadingEl.remove();
      const inner = document.createElement("div");
      inner.id = innerId;
      inner.style.width = "100%";
      inner.style.height = "100%";
      host.appendChild(inner);

      const aladin = A.aladin(`#${innerId}`, {
        target: `${ra} ${dec}`,
        fov: 0.025,
        survey: survey.id,
        showReticle: true,
        showZoomControl: true,
        showLayersControl: true,
      });

      const cat = A.catalog({ name: "Object", sourceSize: 14, color: "#1976d2" });
      aladin.addCatalog(cat);
      cat.addSources([A.source(ra, dec, { name: String(oid) })]);

      // Clicks on any catalog source (main object or spec-z overlay) fire
      // `objectClicked`. When the clicked source carries a `z` datum, copy
      // it into the per-oid redshift input so other panels can pick it up
      // from there later (absolute-mag mode, future cosmology math, …).
      aladin.on("objectClicked", function (obj) {
        if (!obj || !obj.data) return;
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
        window.loadSpecZOverlays(aladin, ra, dec, (info) => {
          addLegendChip(legendEl, `${info.name} (${info.count})`, info.color);
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
      onClick: "showPopup",
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
  }

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
