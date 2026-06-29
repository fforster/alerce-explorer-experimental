// Stamp FITS pipeline.
//
// Both LSST and ZTF stamp endpoints serve gzip-compressed FITS. The browser
// fetches the bytes, gunzips them via DecompressionStream, parses the FITS
// header in 2880-byte blocks, reads the pixel array honoring BITPIX/BZERO/
// BSCALE, applies an asinh stretch over z-scale percentiles, and rotates the
// result so North points up using the CD (or PC+CDELT) matrix.
//
// The template emits one <canvas class="stamp-canvas" data-stamp-url="..."
// data-stamp-type="..."> per stamp; we hook htmx:afterSwap to (re)render each
// one, and rely on the compass / scale overlays painted on the canvas itself
// rather than separate DOM elements.

(function () {
  const rendered = new WeakSet();
  // Cached pre-stretched image per canvas. Lets the zoom controls re-blit
  // without re-fetching / re-parsing FITS on every click.
  const cache = new WeakMap();

  // 1× is the natural minimum: the survey-side cutout is already cropped
  // tightly around the object, so zooming below that pads black bars
  // without revealing more sky. Cap zoom-out at the baseline (fit-to-
  // canvas) and let zoom-in run up to 8× for inspecting the PSF core.
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;

  function getPanelZoom(panel) {
    if (!panel) return 1;
    const z = parseFloat(panel.dataset.zoom || "1");
    return isFinite(z) && z > 0 ? z : 1;
  }

  function setPanelZoom(panel, z) {
    panel.dataset.zoom = String(z);
    const label = panel.querySelector(".stamps-zoom-reset");
    if (label) label.textContent = `${z.toFixed(2)}×`;
    // Scale the centre crosshair by the same factor (about centre, via CSS
    // transform-origin) so it tracks the zoomed image at a constant relative
    // scale instead of staying a fixed-size reticle.
    panel.querySelectorAll(".stamp-crosshair").forEach((ch) => {
      ch.style.transform = z === 1 ? "" : `scale(${z})`;
    });
  }

  async function loadAndRenderFitsStamp(canvas, url) {
    const card = canvas.closest(".tw-relative") || canvas.parentElement;
    const loadingEl = card?.querySelector(".stamp-loading");
    const compassEl = card?.querySelector(".stamp-compass");

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      let fitsBuf = await resp.arrayBuffer();

      const magic = new Uint8Array(fitsBuf, 0, 2);
      if (magic[0] === 0x1f && magic[1] === 0x8b) {
        fitsBuf = await gunzip(fitsBuf);
      }

      let fits = parseFitsHeader(fitsBuf, 0);
      if (!fits.naxis1 || !fits.naxis2) {
        if (fits.headerEndByte < fitsBuf.byteLength) {
          fits = parseFitsHeader(fitsBuf, fits.headerEndByte);
        }
      }
      if (!fits.naxis1 || !fits.naxis2) throw new Error("Invalid FITS: no image data");

      const pixels = readFitsImageData(fitsBuf, fits);
      const northAngle = computeNorthAngle(fits.header);
      // Stretch once; cache the resulting source canvas so zoom is cheap.
      const srcCanvas = buildStretchedSrcCanvas(pixels, fits.naxis1, fits.naxis2, fits.header);
      cache.set(canvas, {
        srcCanvas,
        nx: fits.naxis1,
        ny: fits.naxis2,
        northAngle,
        header: fits.header,
      });
      redrawStamp(canvas);

      if (compassEl) {
        compassEl.textContent = Math.abs(northAngle) > 0.001
          ? `N↑ E← (rot ${(-northAngle * 180 / Math.PI).toFixed(1)}°)`
          : "N↑ E←";
      }
      if (loadingEl) loadingEl.style.display = "none";

      // Fire once per detection: the science / template / difference
      // stamps share the same WCS by construction, so re-broadcasting
      // for each would only redraw the same polygon in Aladin. We pick
      // science as the canonical source.
      //
      // Stash the latest footprint on the aladin host so initHost can
      // pick it up when stamps render before Aladin finishes booting
      // (CDN cold-start path) — without this, the polygon would be
      // missed on the very first render of a fresh detail view.
      if (canvas.dataset.stampType === "science") {
        // ZTF cutouts have no WCS in the FITS header — synthesise one
        // centred on the object before computing corners, so the polygon
        // outline still appears in Aladin (and matches the ~63" stamp
        // size). LSST stamps already carry full WCS and this is a no-op.
        augmentZTFStampWCS(fits.header, fits.naxis1, fits.naxis2, canvas);
        const footprint = computeStampFootprint(fits.header, fits.naxis1, fits.naxis2);
        if (footprint) {
          const host = document.querySelector(".aladin-host");
          if (host) host.$stampFootprintLatest = footprint;
          document.dispatchEvent(new CustomEvent("stamp:footprintChanged", {
            detail: { footprint },
          }));
        }
      }
    } catch (e) {
      console.error("FITS stamp error:", e, url);
      if (loadingEl) loadingEl.textContent = "stamp error";
      if (compassEl) compassEl.textContent = "";
    }
  }

  function redrawStamp(canvas) {
    const cached = cache.get(canvas);
    if (!cached) return;
    const panel = canvas.closest("#stamps-panel");
    const zoom = getPanelZoom(panel);
    blitStampCanvas(canvas, cached, zoom);
  }

  function redrawPanelStamps(panel) {
    if (!panel) return;
    panel.querySelectorAll("canvas.stamp-canvas").forEach(redrawStamp);
  }

  async function gunzip(buffer) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buffer));
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out.buffer;
  }

  function parseFitsHeader(buffer, startOffset) {
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder("ascii");
    const header = {};
    let headerEndByte = 0;

    for (let block = 0; block < 100; block++) {
      const blockStart = startOffset + block * 2880;
      if (blockStart >= bytes.length) break;
      let foundEnd = false;
      for (let i = 0; i < 36; i++) {
        const recStart = blockStart + i * 80;
        if (recStart + 80 > bytes.length) break;
        const record = decoder.decode(bytes.slice(recStart, recStart + 80));
        const keyword = record.substring(0, 8).trim();

        if (keyword === "END") {
          headerEndByte = startOffset + (block + 1) * 2880;
          foundEnd = true;
          break;
        }

        if (record.charAt(8) === "=" && record.charAt(9) === " ") {
          let valStr = record.substring(10).split("/")[0].trim();
          if (valStr.startsWith("'")) {
            header[keyword] = valStr.replace(/'/g, "").trim();
          } else if (valStr === "T") {
            header[keyword] = true;
          } else if (valStr === "F") {
            header[keyword] = false;
          } else if (valStr !== "") {
            const num = parseFloat(valStr);
            if (!isNaN(num)) header[keyword] = num;
          }
        }
      }
      if (foundEnd) break;
    }

    return {
      header,
      naxis1: header.NAXIS1 || 0,
      naxis2: header.NAXIS2 || 0,
      bitpix: header.BITPIX || -32,
      headerEndByte,
    };
  }

  function readFitsImageData(buffer, fits) {
    const { naxis1, naxis2, bitpix, headerEndByte, header } = fits;
    const npix = naxis1 * naxis2;
    const dv = new DataView(buffer, headerEndByte);
    const pixels = new Float64Array(npix);
    const bpp = Math.abs(bitpix) / 8;

    for (let i = 0; i < npix; i++) {
      const off = i * bpp;
      if (off + bpp > dv.byteLength) break;
      if (bitpix === -32) pixels[i] = dv.getFloat32(off, false);
      else if (bitpix === -64) pixels[i] = dv.getFloat64(off, false);
      else if (bitpix === 16) pixels[i] = dv.getInt16(off, false);
      else if (bitpix === 32) pixels[i] = dv.getInt32(off, false);
      else if (bitpix === 8) pixels[i] = dv.getUint8(off);
    }

    const bzero = header.BZERO || 0;
    const bscale = header.BSCALE || 1;
    if (bzero !== 0 || bscale !== 1) {
      for (let i = 0; i < npix; i++) pixels[i] = pixels[i] * bscale + bzero;
    }
    return pixels;
  }

  // Effective CD matrix in deg/pix from any of the FITS WCS conventions:
  //   CD_ij                          (CD matrix style, used by ZTF stamps)
  //   PC_ij + CDELT_i                (PC + CDELT style, used by LSST stamps —
  //                                   LSST sets CDELT=1 and packs the scale
  //                                   into PC, so the off-diagonals must be
  //                                   scaled by CDELT_i not CDELT_j)
  //   CDELT_i + CROTA2               (legacy rotation-angle style)
  //   diagonal CDELT only            (no rotation/skew fallback)
  // Returns {cd11, cd12, cd21, cd22} or null when nothing usable is present.
  function effectiveCDMatrix(header) {
    if (header.CD1_1 != null && header.CD2_2 != null) {
      return {
        cd11: header.CD1_1,
        cd12: header.CD1_2 || 0,
        cd21: header.CD2_1 || 0,
        cd22: header.CD2_2,
      };
    }
    const pc11 = header.PC1_1 ?? header.PC001001;
    const pc12 = header.PC1_2 ?? header.PC001002;
    const pc21 = header.PC2_1 ?? header.PC002001;
    const pc22 = header.PC2_2 ?? header.PC002002;
    const cdelt1 = header.CDELT1;
    const cdelt2 = header.CDELT2;
    if (pc11 != null && pc22 != null && cdelt1 != null && cdelt2 != null) {
      return {
        cd11: cdelt1 * pc11,
        cd12: cdelt1 * (pc12 || 0),
        cd21: cdelt2 * (pc21 || 0),
        cd22: cdelt2 * pc22,
      };
    }
    if (cdelt1 != null && cdelt2 != null) {
      const crota2 = (header.CROTA2 || 0) * Math.PI / 180;
      return {
        cd11:  cdelt1 * Math.cos(crota2),
        cd12: -cdelt2 * Math.sin(crota2),
        cd21:  cdelt1 * Math.sin(crota2),
        cd22:  cdelt2 * Math.cos(crota2),
      };
    }
    return null;
  }

  // Gnomonic (TAN) WCS pixel → world coordinates. Inputs use the FITS
  // 1-indexed pixel convention (pixel centers at integer coordinates,
  // image corners at half-integer 0.5 / NAXIS+0.5). Returns [ra, dec] in
  // degrees, or null when the header is missing the keywords we need.
  // Reference: Calabretta & Greisen 2002, A&A 395, 1077.
  function pixelToWorldTAN(px, py, header) {
    const cd = effectiveCDMatrix(header);
    if (!cd) return null;
    const crpix1 = header.CRPIX1;
    const crpix2 = header.CRPIX2;
    const crval1 = header.CRVAL1;
    const crval2 = header.CRVAL2;
    if (crpix1 == null || crpix2 == null || crval1 == null || crval2 == null) {
      return null;
    }

    const dx = px - crpix1;
    const dy = py - crpix2;
    // Intermediate world coords (degrees), then to radians for the
    // spherical inverse projection.
    const xi  = (cd.cd11 * dx + cd.cd12 * dy) * Math.PI / 180;
    const eta = (cd.cd21 * dx + cd.cd22 * dy) * Math.PI / 180;

    const a0 = crval1 * Math.PI / 180;
    const d0 = crval2 * Math.PI / 180;
    const rho = Math.hypot(xi, eta);
    let raRad, decRad;
    if (rho === 0) {
      raRad = a0;
      decRad = d0;
    } else {
      const c = Math.atan(rho);
      const cosc = Math.cos(c);
      const sinc = Math.sin(c);
      decRad = Math.asin(cosc * Math.sin(d0) + (eta * sinc * Math.cos(d0)) / rho);
      raRad = a0 + Math.atan2(
        xi * sinc,
        rho * Math.cos(d0) * cosc - eta * Math.sin(d0) * sinc,
      );
    }
    let ra = raRad * 180 / Math.PI;
    let dec = decRad * 180 / Math.PI;
    ra = ((ra % 360) + 360) % 360;
    return [ra, dec];
  }

  // ZTF cutouts ship a bare FITS header (no CRVAL, CRPIX, CD, etc.), so
  // there's nothing for `pixelToWorldTAN` to work with. Synthesise a
  // default WCS centred on the object's known position with a 1"/pix
  // N-up E-left orientation — accurate enough for the Aladin footprint
  // outline, which only needs to be sub-arcsec-correct on a stamp that's
  // 63" wide. The detection's RA/Dec lives on the aladin-host element
  // (the same source the panel was centred on).
  //
  // Mutates `header` in place so downstream callers (footprint, scale
  // bar on a future redraw) all see the synthesised WCS. Skipped when
  // the header already has WCS (LSST stamps).
  function augmentZTFStampWCS(header, nx, ny, canvas) {
    if (header.CRVAL1 != null && header.CRPIX1 != null) return;
    const url = canvas.dataset.stampUrl || "";
    if (url.indexOf("avro.alerce.online") === -1) return;
    const host = document.querySelector(".aladin-host");
    if (!host) return;
    const ra = parseFloat(host.dataset.ra);
    const dec = parseFloat(host.dataset.dec);
    if (!isFinite(ra) || !isFinite(dec)) return;
    const PIX_DEG = 1.0 / 3600.0;          // ZTF pixel scale ~ 1″/pix
    header.CRPIX1 = (nx + 1) / 2;          // 1-indexed image centre
    header.CRPIX2 = (ny + 1) / 2;
    header.CRVAL1 = ra;
    header.CRVAL2 = dec;
    // Standard astronomical convention: RA decreases with column (E-left),
    // Dec increases with row (N-up, matching CD2_2 > 0 + the flipY path).
    header.CD1_1 = -PIX_DEG;
    header.CD1_2 = 0;
    header.CD2_1 = 0;
    header.CD2_2 = PIX_DEG;
  }

  // The four image corners (TL, TR, BR, BL) in sky coordinates. Walks
  // around the rectangle so a polyline drawn through the returned points
  // traces the stamp's outline.
  function computeStampFootprint(header, nx, ny) {
    const corners = [
      [0.5,         ny + 0.5],   // top-left
      [nx + 0.5,    ny + 0.5],   // top-right
      [nx + 0.5,    0.5],        // bottom-right
      [0.5,         0.5],        // bottom-left
    ];
    const out = [];
    for (const [px, py] of corners) {
      const w = pixelToWorldTAN(px, py, header);
      if (!w) return null;
      out.push(w);
    }
    return out;
  }

  function computeNorthAngle(header) {
    const cd = effectiveCDMatrix(header);
    if (!cd) return 0;
    const det = cd.cd11 * cd.cd22 - cd.cd12 * cd.cd21;
    if (Math.abs(det) < 1e-20) return 0;
    const dpx = -cd.cd12 / det;
    const dpy = cd.cd11 / det;
    return Math.atan2(dpx, dpy);
  }

  function zscaleStretch(pixels) {
    const valid = [];
    for (let i = 0; i < pixels.length; i++) {
      if (isFinite(pixels[i])) valid.push(pixels[i]);
    }
    if (!valid.length) return { vmin: 0, vmax: 1 };
    valid.sort((a, b) => a - b);
    const n = valid.length;
    const vmin = valid[Math.floor(n * 0.01)];
    let vmax = valid[Math.floor(n * 0.995)];
    if (vmax === vmin) vmax = vmin + 1;
    return { vmin, vmax };
  }

  function buildStretchedSrcCanvas(pixels, nx, ny, header) {
    const { vmin, vmax } = zscaleStretch(pixels);
    const cdelt2 = header.CD2_2 || header.CDELT2;
    const flipY = (cdelt2 != null && cdelt2 > 0);

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = nx;
    srcCanvas.height = ny;
    const srcCtx = srcCanvas.getContext("2d");
    const imgData = srcCtx.createImageData(nx, ny);
    const a = 10;

    for (let row = 0; row < ny; row++) {
      for (let col = 0; col < nx; col++) {
        const fitsIdx = row * nx + col;
        const canvasRow = flipY ? (ny - 1 - row) : row;
        const canvasIdx = (canvasRow * nx + col) * 4;
        let val = pixels[fitsIdx];
        if (!isFinite(val)) val = vmin;
        let norm = (vmax !== vmin) ? (val - vmin) / (vmax - vmin) : 0.5;
        norm = Math.max(0, Math.min(1, norm));
        norm = Math.asinh(norm * a) / Math.asinh(a);
        const byte = Math.round(norm * 255);
        imgData.data[canvasIdx] = byte;
        imgData.data[canvasIdx + 1] = byte;
        imgData.data[canvasIdx + 2] = byte;
        imgData.data[canvasIdx + 3] = 255;
      }
    }
    srcCtx.putImageData(imgData, 0, 0);
    return srcCanvas;
  }

  function blitStampCanvas(canvas, cached, zoom) {
    const { srcCanvas, nx, ny, northAngle, header } = cached;
    const outSize = canvas.width;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, outSize, outSize);

    // Fit-to-canvas baseline × user zoom. Because the transform scales about
    // the canvas centre (translate then scale), the object — which sits at
    // the cutout centre — stays anchored while the field of view shrinks.
    const baseScale = outSize / Math.max(nx, ny);
    const scale = baseScale * (zoom || 1);

    ctx.save();
    ctx.translate(outSize / 2, outSize / 2);
    ctx.rotate(-northAngle);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, -nx / 2, -ny / 2, nx, ny);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    drawCompass(ctx, outSize);
    drawScaleBar(ctx, outSize, scale, header);
  }

  function drawCompass(ctx, size) {
    const cx = size - 20;
    const cy = 20;
    const len = 14;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = "#1976d2";
    ctx.fillStyle = "#1976d2";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -len); ctx.lineTo(-3, -len + 5); ctx.lineTo(3, -len + 5);
    ctx.closePath(); ctx.fill();
    ctx.font = "9px IBM Plex Mono";
    ctx.textAlign = "center";
    ctx.fillText("N", 0, -len - 4);

    ctx.strokeStyle = "#f85149";
    ctx.fillStyle = "#f85149";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-len, 0); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-len, 0); ctx.lineTo(-len + 5, -3); ctx.lineTo(-len + 5, 3);
    ctx.closePath(); ctx.fill();
    ctx.fillText("E", -len - 4, 3);
    ctx.restore();
  }

  function drawScaleBar(ctx, canvasSize, imageScale, header) {
    let pixScaleArcsec = 0;
    const cd = effectiveCDMatrix(header);
    if (cd) {
      const det = Math.abs(cd.cd11 * cd.cd22 - cd.cd12 * cd.cd21);
      const arcsec = Math.sqrt(det) * 3600;
      if (arcsec > 0 && arcsec < 10) pixScaleArcsec = arcsec;
    }
    if (!pixScaleArcsec) pixScaleArcsec = 1.0;  // ZTF ~1"/px, LSST ~0.2"/px; 1" is a sane fallback

    const pxPerArcsec = imageScale / pixScaleArcsec;
    let barArcsec = 1;
    let barPx = pxPerArcsec * barArcsec;
    if (barPx < 15) { barArcsec = 5; barPx = pxPerArcsec * 5; }
    if (barPx < 15) { barArcsec = 10; barPx = pxPerArcsec * 10; }
    if (barPx > canvasSize * 0.5) { barArcsec = 0.5; barPx = pxPerArcsec * 0.5; }
    if (barPx > canvasSize * 0.5) { barArcsec = 0.2; barPx = pxPerArcsec * 0.2; }

    const padX = 8;
    const padY = 10;
    const y = canvasSize - padY;
    const x0 = padX;
    const x1 = x0 + barPx;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x0 - 4, y - 20, barPx + 8, 26);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y - 6); ctx.lineTo(x0, y + 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, y - 6); ctx.lineTo(x1, y + 4); ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px IBM Plex Mono";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${barArcsec}″`, (x0 + x1) / 2, y - 7);
    ctx.restore();
  }

  // Wheel-zoom factor per scroll tick. Match the +/- button feel
  // (1.25× per click) so wheel and buttons drive the same zoom curve;
  // `redrawPanelStamps` keeps the three stamps in lockstep just like
  // `zoomStamps` does.
  const WHEEL_ZOOM_STEP = 1.25;

  function bindWheelZoom(canvas) {
    if (canvas.$wheelBound) return;
    canvas.$wheelBound = true;
    canvas.addEventListener(
      "wheel",
      (e) => {
        // preventDefault so the page doesn't scroll when the user is
        // panning the wheel over the stamp; passive: false (below) is
        // required for that. Tick direction follows convention: scroll
        // up zooms in, scroll down zooms out.
        e.preventDefault();
        if (!e.deltaY) return;
        const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        if (window.zoomStamps) window.zoomStamps(canvas, factor);
      },
      { passive: false },
    );
  }

  function initCanvas(canvas) {
    // Wheel zoom is bound on every canvas — including ones whose FITS
    // bytes already finished loading on a prior swap — so it survives
    // the htmx:afterSwap re-init pass.
    bindWheelZoom(canvas);
    if (rendered.has(canvas)) return;
    const url = canvas.dataset.stampUrl;
    if (!url) return;
    rendered.add(canvas);
    loadAndRenderFitsStamp(canvas, url);
  }

  function initAll(root) {
    (root || document).querySelectorAll("canvas.stamp-canvas").forEach(initCanvas);
  }

  // Zero-round-trip identifier swap: the server emits stamp URL templates
  // with __OID__ + __IDENT__ placeholders as data attrs on #stamps-panel.
  // We rewrite each canvas's URL locally and force a re-render — no hit to
  // our server.
  //
  // Cross-survey awareness: `survey` and `oid` arguments dispatch to the
  // matching per-survey template (`data-url-template-{type}-{survey}`)
  // with BOTH placeholders to substitute. Defaults — `survey` falls back
  // to the panel's primary, `oid` to the primary OID baked into
  // `data-oid` — preserve the in-survey path for callers that don't yet
  // pass the extra arguments.
  window.updateStampsForIdentifier = function (ident, survey, oid) {
    if (!ident) return;
    const panel = document.getElementById("stamps-panel");
    if (!panel) return;
    const useSurvey = survey || panel.dataset.survey || "";
    const useOid = oid || panel.dataset.oid || "";
    const canvases = panel.querySelectorAll("canvas.stamp-canvas");
    canvases.forEach((canvas) => {
      const type = canvas.dataset.stampType;
      // Prefer the per-survey template (has both placeholders) so cross-
      // survey clicks land on the matched object. Fall back to the legacy
      // primary-only template (OID baked in, __IDENT__ swappable) when
      // the per-survey one isn't present — keeps older snapshots working.
      const perSurvey = useSurvey
        ? panel.getAttribute(`data-url-template-${type}-${useSurvey}`)
        : null;
      const legacyTpl = panel.getAttribute(`data-url-template-${type}`);
      let url;
      if (perSurvey) {
        url = perSurvey
          .replace("__OID__", encodeURIComponent(useOid))
          .replace("__IDENT__", encodeURIComponent(ident));
      } else if (legacyTpl) {
        url = legacyTpl.replace("__IDENT__", encodeURIComponent(ident));
      } else {
        return;
      }
      canvas.dataset.stampUrl = url;
      rendered.delete(canvas);
      cache.delete(canvas);
      const card = canvas.closest(".tw-relative") || canvas.parentElement;
      const loadingEl = card?.querySelector(".stamp-loading");
      const compassEl = card?.querySelector(".stamp-compass");
      if (loadingEl) { loadingEl.textContent = "loading…"; loadingEl.style.display = ""; }
      if (compassEl) compassEl.textContent = "";
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      initCanvas(canvas);
    });
    const picker = panel.querySelector('select[name="identifier"]');
    // Only sync the picker to the current identifier when the click stayed
    // in the primary survey — the picker is built from the primary's
    // detection list, so a cross-survey identifier wouldn't match any
    // option anyway. Leaving the picker on its previous selection beats
    // silently clearing it.
    if (picker && useSurvey === panel.dataset.survey) {
      if (picker.value !== String(ident)) picker.value = String(ident);
    }
  };

  // Download the underlying FITS bytes for the stamp this button sits next
  // to. Re-fetches `data-stamp-url` rather than reaching into the cached
  // post-stretch source canvas — the user almost always wants the science
  // product (FITS, with WCS), not the asinh-stretched preview PNG. The
  // wire form is sometimes gzip; we sniff the magic bytes and pick the
  // matching extension so astropy / ds9 / etc. can handle the file
  // without manual unwrapping.
  window.downloadStamp = async function (btn) {
    const card = btn?.closest(".tw-relative");
    if (!card) return;
    const canvas = card.querySelector("canvas.stamp-canvas");
    if (!canvas) return;
    const url = canvas.dataset.stampUrl;
    if (!url) return;
    const stampType = canvas.dataset.stampType || "stamp";
    const panel = document.getElementById("stamps-panel");
    // Both `oid` and the identifier come straight from the stamp URL —
    // `updateStampsForIdentifier` rebuilds it from the per-survey
    // template whenever the user clicks a different point, so URL params
    // always describe the survey + object the canvas currently shows.
    // That way a cross-survey click (ZTF point on an LSST view, or vice
    // versa) lands the matched survey's OID in the filename, not the
    // primary view's OID.
    let oid = "";
    let ident = "";
    try {
      const u = new URL(url, window.location.origin);
      oid = u.searchParams.get("oid") || "";
      ident = u.searchParams.get("candid")
           || u.searchParams.get("measurement_id")
           || "";
    } catch (_e) { /* keep oid + ident empty */ }
    // Fall back to the panel's primary OID only when the URL didn't
    // surface one (defensive — the stamp endpoints we drive both carry
    // it). Same fallback for the identifier.
    if (!oid) oid = (panel && panel.dataset.oid) || "object";
    if (!ident && window._selectedIdentifier) ident = String(window._selectedIdentifier);

    // Slug helper — strip anything that's awkward in a download filename
    // (the OID is fine, the candid is digits, but be defensive).
    const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

    // Brief in-button feedback so the user sees the click registered even
    // though the actual download takes a beat. We swap the title attr +
    // dim the button while the fetch is in flight.
    const originalTitle = btn.getAttribute("title");
    btn.setAttribute("title", "Downloading…");
    btn.classList.add("tw-opacity-60");
    btn.disabled = true;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      const magic = new Uint8Array(buf, 0, 2);
      const isGz = magic.length >= 2 && magic[0] === 0x1f && magic[1] === 0x8b;
      const ext = isGz ? "fits.gz" : "fits";
      const mime = isGz ? "application/gzip" : "application/fits";
      const parts = [slug(oid), stampType];
      if (ident) parts.push(slug(ident));
      const filename = `${parts.join("_")}.${ext}`;
      const blob = new Blob([buf], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Same revoke-on-next-tick pattern the LC CSV download uses.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      btn.setAttribute("title", originalTitle || "Download FITS");
    } catch (e) {
      console.error("stamp download failed:", e);
      btn.setAttribute("title", `Download failed: ${e.message || e}`);
    } finally {
      btn.classList.remove("tw-opacity-60");
      btn.disabled = false;
    }
  };

  // Open the AVRO record modal for the currently displayed detection.
  // Mirrors the "Show features" pattern (basic-info → /htmx/features
  // populates #features-modal): we issue an htmx GET to /htmx/avro with
  // oid + candid + survey_id pulled from the current stamp's URL, and the
  // server fragment fills #avro-modal in place. Survey is sniffed from
  // the URL host so cross-survey clicks (LSST stamp on a ZTF view, or
  // vice versa) flow to the right server-side branch — LSST returns a
  // "ZTF-only" notice rather than 404.
  function detectSurveyFromStampUrl(url) {
    if (typeof url !== "string") return "";
    if (url.indexOf("api-lsst.alerce.online") !== -1) return "lsst";
    if (url.indexOf("avro.alerce.online") !== -1) return "ztf";
    return "";
  }

  window.openAvroModal = function () {
    const panel = document.getElementById("stamps-panel");
    if (!panel) return;
    // Read the current science canvas (or the first stamp canvas as
    // fallback) — its `data-stamp-url` is rebuilt by
    // updateStampsForIdentifier on every click, so it always describes
    // the displayed detection.
    const canvas = panel.querySelector(
      'canvas.stamp-canvas[data-stamp-type="science"]',
    ) || panel.querySelector("canvas.stamp-canvas");
    if (!canvas) return;
    const url = canvas.dataset.stampUrl;
    if (!url) return;
    let oid = "";
    let candid = "";
    let survey = detectSurveyFromStampUrl(url);
    try {
      const u = new URL(url, window.location.origin);
      oid = u.searchParams.get("oid") || "";
      // Both ZTF (candid) and LSST (measurement_id) live under different
      // query params; either works as the AVRO endpoint's `candid` arg —
      // the server short-circuits the LSST branch before hitting
      // upstream, so passing through whichever is present is safe.
      candid = u.searchParams.get("candid")
            || u.searchParams.get("measurement_id")
            || "";
    } catch (_e) { /* keep oid + candid empty */ }
    if (!survey) survey = panel.dataset.survey || "";
    if (!oid) oid = panel.dataset.oid || "";
    if (!oid || !candid) {
      console.warn("openAvroModal: missing oid/candid", { oid, candid, url });
      return;
    }
    if (typeof htmx === "undefined") {
      console.warn("openAvroModal: htmx not loaded");
      return;
    }
    // Relative URL — same origin as the page, matches every other
    // server-rendered hx-get in this app.
    const params = new URLSearchParams({ oid, candid, survey_id: survey });
    htmx.ajax("GET", `/htmx/avro?${params.toString()}`, {
      target: "#avro-modal",
      swap: "innerHTML",
    });
  };

  // Apply a zoom factor (relative multiplier, or the string "reset") to every
  // stamp in the panel containing the clicked button. Scaling happens about
  // the canvas centre in blitStampCanvas, so the object stays put.
  window.zoomStamps = function (originEl, factor) {
    const panel = originEl?.closest("#stamps-panel") || document.getElementById("stamps-panel");
    if (!panel) return;
    let z = factor === "reset" ? 1 : getPanelZoom(panel) * Number(factor);
    if (!isFinite(z) || z <= 0) return;
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    setPanelZoom(panel, z);
    redrawPanelStamps(panel);
  };

  // Show/hide the centre crosshair overlay on every stamp in the panel. The
  // crosshair markup lives in stampsPreview.html.jinja; toggling
  // `.crosshair-hidden` on the panel flips its CSS `display`. Updates the
  // button's pressed state + accent colour so it reads as on/off.
  window.toggleStampCrosshairs = function (btn) {
    const panel = btn?.closest("#stamps-panel") || document.getElementById("stamps-panel");
    if (!panel) return;
    const hidden = panel.classList.toggle("crosshair-hidden");
    btn.setAttribute("aria-pressed", String(!hidden));
    btn.classList.toggle("tw-text-accent", !hidden);
    btn.classList.toggle("tw-text-text-muted", hidden);
  };

  document.addEventListener("DOMContentLoaded", () => initAll(document));
  document.addEventListener("htmx:afterSwap", (evt) => initAll(evt.detail.target));

  // Test-only surface: the pure FITS-pipeline + WCS math (no canvas, no
  // network). parseFitsHeader / readFitsImageData take an ArrayBuffer; the
  // rest take plain header objects. Exercised by tests-js/stamps.test.js
  // against a hand-built synthetic FITS buffer.
  window.__stampsTest = {
    parseFitsHeader, readFitsImageData, effectiveCDMatrix, pixelToWorldTAN,
    computeStampFootprint, computeNorthAngle, zscaleStretch, detectSurveyFromStampUrl,
  };
})();
