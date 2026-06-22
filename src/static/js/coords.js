/* Coordinate / date / name-resolver helpers for the search form.
 *
 * Three pure-client tasks:
 *
 *   parseCoordinates(str) → {ra, dec} | null
 *     Free-text RA/Dec parser. Accepts plain degrees ("12.34 -56.78"), comma-
 *     separated degrees ("12.34, -56.78"), HH:MM:SS ±DD:MM:SS sexagesimal,
 *     and HHhMMmSSs ±DDdMMmSSs letter-annotated forms. Returns the same
 *     {ra, dec} shape the upstream cone-search endpoints expect.
 *
 *   smartDateToMJD(val) → number | null
 *     Auto-detect numeric (MJD vs JD via the > 2400000 cutoff) or calendar
 *     date (YYYY-MM-DD HH:MM:SS or anything Date can parse) → MJD.
 *
 *   resolveName(name) → Promise<{ra, dec} | null>
 *     CDS Sesame XML lookup. Browser fetches Sesame directly — Sesame ships
 *     CORS headers, no server-side proxy needed.
 *
 * Helpers are exposed on `window` so hx-vals JS expressions and inline
 * onclick handlers in the form template can reach them.
 */
(function () {
  // ── RA / Dec parsers ────────────────────────────────────────────────────

  function parseRAString(s) {
    s = s.trim();
    // HH:MM:SS.s
    const colonParts = s.split(":");
    if (colonParts.length === 3) {
      const h = parseFloat(colonParts[0]);
      const m = parseFloat(colonParts[1]);
      const sec = parseFloat(colonParts[2]);
      if (isNaN(h) || isNaN(m) || isNaN(sec)) return null;
      return (h + m / 60 + sec / 3600) * 15;
    }
    // HHhMMmSS.sss[s]
    const hms = s.match(/^(\d+)[hH]\s*(\d+)[mM]\s*([\d.]+)[sS]?$/);
    if (hms) {
      const h = parseFloat(hms[1]);
      const m = parseFloat(hms[2]);
      const sec = parseFloat(hms[3]);
      return (h + m / 60 + sec / 3600) * 15;
    }
    // Plain degrees fallback
    const val = parseFloat(s);
    if (!isNaN(val) && val >= 0 && val <= 360) return val;
    return null;
  }

  function parseDecString(s) {
    s = s.trim();
    const sign = s.startsWith("-") ? -1 : 1;
    s = s.replace(/^[+-]/, "");

    // DD:MM:SS.s
    const colonParts = s.split(":");
    if (colonParts.length === 3) {
      const d = parseFloat(colonParts[0]);
      const m = parseFloat(colonParts[1]);
      const sec = parseFloat(colonParts[2]);
      if (isNaN(d) || isNaN(m) || isNaN(sec)) return null;
      return sign * (d + m / 60 + sec / 3600);
    }
    // DDdMMmSS.ss[s] or DD°MM'SS.ss"
    const dms = s.match(/^(\d+)[dD°]\s*(\d+)[mM']\s*([\d.]+)["sS]?$/);
    if (dms) {
      const d = parseFloat(dms[1]);
      const m = parseFloat(dms[2]);
      const sec = parseFloat(dms[3]);
      return sign * (d + m / 60 + sec / 3600);
    }
    const val = parseFloat(s);
    if (!isNaN(val) && val >= 0 && val <= 90) return sign * val;
    return null;
  }

  function parseCoordinates(str) {
    if (!str || !str.trim()) return null;
    str = str.trim();
    // Normalize commas + multi-space to single spaces.
    const normalized = str.replace(/,/g, " ").replace(/\s+/g, " ").trim();

    // Sexagesimal markers tell us we're not in plain-degrees mode.
    const isSexagesimal = /[hHmMsSdD:°]/.test(normalized);
    if (isSexagesimal) {
      let raPart, decPart;
      // "HH:MM:SS.s ±DD:MM:SS.s"
      const colonGroups = normalized.match(/[+-]?[\d.:]+/g);
      if (colonGroups && colonGroups.length === 2 && normalized.includes(":")) {
        raPart = colonGroups[0];
        decPart = colonGroups[1];
      }
      // "HHhMMmSSs ±DDdMMmSSs"
      if (!raPart) {
        const m = normalized.match(/^([\d.]+[hH][\d.]+[mM][\d.]+[sS]?)\s+([+-]?[\d.]+[dD°][\d.]+[mM']?[\d.]+["sS]?)\s*$/);
        if (m) { raPart = m[1]; decPart = m[2]; }
      }
      // Last resort: split on the space before the first +/- in the dec.
      if (!raPart) {
        const idx = normalized.search(/\s+[+-]/);
        if (idx > 0) {
          raPart = normalized.substring(0, idx).trim();
          decPart = normalized.substring(idx).trim();
        }
      }
      if (!raPart || !decPart) return null;
      const ra = parseRAString(raPart);
      const dec = parseDecString(decPart);
      if (ra == null || dec == null) return null;
      return { ra, dec };
    }
    // Plain degrees: split on whitespace.
    const parts = normalized.split(/\s+/);
    if (parts.length !== 2) return null;
    const ra = parseFloat(parts[0]);
    const dec = parseFloat(parts[1]);
    if (isNaN(ra) || isNaN(dec)) return null;
    if (ra < 0 || ra > 360 || dec < -90 || dec > 90) return null;
    return { ra, dec };
  }

  // ── Date → MJD ──────────────────────────────────────────────────────────
  //
  //   - Pure number > 2400000: Julian Date → MJD = JD - 2400000.5
  //   - Pure number in plausible MJD range (10000–200000): treat as MJD
  //   - Anything Date.parse can handle: calendar → MJD via UTC epoch
  //
  // Returns null when we can't make sense of the input.

  function smartDateToMJD(val) {
    if (val == null) return null;
    val = String(val).trim();
    if (!val) return null;
    const num = parseFloat(val);
    // Pure-number form, no embedded letters/whitespace.
    if (!isNaN(num) && /^[\d.+-]+$/.test(val)) {
      if (num > 2400000) return num - 2400000.5;
      if (num > 10000 && num < 200000) return num;
    }
    // Normalize "/" separators and "YYYY-MM-DD HH:MM:SS" → ISO.
    let normalized = val.replace(/\//g, "-");
    normalized = normalized.replace(/^(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})/, "$1T$2");
    // ISO-like → assume UTC if no zone given.
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(normalized)) {
      if (!normalized.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(normalized)) {
        normalized += "Z";
      }
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) return d.getTime() / 86400000 + 40587.0;
    }
    // Last resort: let Date guess. Force UTC fields so local TZ doesn't shift.
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      const utc = Date.UTC(
        d.getFullYear(), d.getMonth(), d.getDate(),
        d.getHours(), d.getMinutes(), d.getSeconds(),
      );
      return utc / 86400000 + 40587.0;
    }
    return null;
  }

  // Convert MJD → "YYYY-MM-DDTHH:MM:SS" (UTC, datetime-local-friendly).
  function mjdToCalendarStr(mjd) {
    const jd = mjd + 2400000.5;
    const d = new Date((jd - 2440587.5) * 86400000);
    return d.toISOString().substring(0, 19);
  }

  // ── CDS Sesame name resolver ────────────────────────────────────────────
  //
  // Sesame returns an XML document whose <jradeg>/<jdedeg> elements carry the
  // J2000 coordinates in degrees. Fail gracefully on network / parse errors
  // — the form falls back to manual RA/Dec entry.

  const SESAME_URL = "https://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-oxp/SNVA?";

  async function resolveName(name) {
    if (!name || !name.trim()) return null;
    try {
      const resp = await fetch(SESAME_URL + encodeURIComponent(name.trim()));
      if (!resp.ok) return null;
      const text = await resp.text();
      const xml = new DOMParser().parseFromString(text, "text/xml");
      const ra = parseFloat(xml.querySelector("jradeg")?.textContent ?? "");
      const dec = parseFloat(xml.querySelector("jdedeg")?.textContent ?? "");
      if (!isFinite(ra) || !isFinite(dec)) return null;
      return { ra, dec };
    } catch (_e) {
      return null;
    }
  }

  // Wired to the inline buttons / onchange handlers in the form template.
  // No modules — the form is a server-rendered fragment, so a global is the
  // simplest way to bridge htmx-rendered HTML back into client logic.
  window.parseCoordinates = parseCoordinates;
  window.smartDateToMJD = smartDateToMJD;
  window.mjdToCalendarStr = mjdToCalendarStr;
  window.resolveName = resolveName;

  // Convenience for the form: parses the coords field, rewrites it with the
  // canonical "ra dec" degrees form so users can see what was understood.
  window.normalizeCoordsField = function (inputId) {
    const el = document.getElementById(inputId);
    if (!el) return null;
    const c = parseCoordinates(el.value);
    if (!c) return null;
    el.value = `${c.ra.toFixed(6)} ${c.dec.toFixed(6)}`;
    return c;
  };

  // Same for date field: if the value is a calendar date or JD, rewrite it
  // as MJD so the user sees the numeric form before submitting.
  window.normalizeDateField = function (inputId) {
    const el = document.getElementById(inputId);
    if (!el) return null;
    const m = smartDateToMJD(el.value);
    if (m == null) return null;
    el.value = m.toFixed(5);
    return m;
  };

  // Bridge a hidden <input type="datetime-local"> picker into a free-text
  // date field: read the picker's value (treated as UTC), convert to MJD,
  // write back to the text input. Mirrors the prototype's calendarToMJD.
  window.calendarPickerToMJD = function (calId, textId) {
    const calEl = document.getElementById(calId);
    const textEl = document.getElementById(textId);
    if (!calEl || !textEl || !calEl.value) return null;
    // datetime-local always serializes as YYYY-MM-DDTHH:MM[:SS]; smartDateToMJD
    // appends the missing Z so we treat it as UTC (the user expectation: the
    // displayed time matches what the picker shows, no local-TZ surprise).
    const m = smartDateToMJD(calEl.value);
    if (m == null) return null;
    textEl.value = m.toFixed(5);
    return m;
  };

  // Reverse of calendarPickerToMJD: push a free-text date field's value into
  // its hidden <input type="datetime-local"> picker (id = "<textId>-cal") so
  // that when the user types an MJD/JD/date by hand and then opens the picker,
  // it lands on the date they entered instead of a stale value. Unparseable
  // input leaves the picker untouched; an empty field clears it.
  window.syncDatePickerFromText = function (textId) {
    const textEl = document.getElementById(textId);
    const calEl = document.getElementById(textId + "-cal");
    if (!textEl || !calEl) return;
    const raw = textEl.value.trim();
    if (!raw) {
      calEl.value = "";
      return;
    }
    const m = smartDateToMJD(raw);
    if (m == null) return;
    const s = mjdToCalendarStr(m); // "YYYY-MM-DDTHH:MM:SS" (UTC)
    if (s) calEl.value = s;
  };

  // Delegated so it survives htmx re-rendering the form fragment and doesn't
  // need an onchange threaded through the shared input() macro. The only text
  // fields with a sibling "<id>-cal" picker are the four discovery /
  // last-detection date inputs, so that sibling check is the selector.
  document.addEventListener("change", function (ev) {
    const t = ev.target;
    if (!t || !t.id || t.type === "datetime-local") return;
    if (document.getElementById(t.id + "-cal")) {
      window.syncDatePickerFromText(t.id);
    }
  });

  // Resolve a name field into the coords field. Returns true on success so
  // the caller can update UI (e.g. swap the spinner back to its icon).
  window.resolveNameInto = async function (nameId, coordsId) {
    const nameEl = document.getElementById(nameId);
    const coordsEl = document.getElementById(coordsId);
    if (!nameEl || !coordsEl) return false;
    const c = await resolveName(nameEl.value);
    if (!c) return false;
    coordsEl.value = `${c.ra.toFixed(6)} ${c.dec.toFixed(6)}`;
    return true;
  };
})();
