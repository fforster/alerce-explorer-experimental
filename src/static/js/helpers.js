// Client-side helpers used by hx-vals='js:{...helper()}' attributes.
// Keep these thin — they exist only to collect DOM state into a query payload
// that htmx serializes onto its outgoing request.

function _val(id) {
  const el = document.getElementById(id);
  if (!el) return "";
  return (el.value ?? "").toString().trim();
}

// Collect current filter-form state.
function send_form_Data() {
  const form = document.getElementById("form-search");
  const survey = form?.dataset?.survey ?? "lsst";

  const classifier = _val("classifier");
  const className = _val("class_name");
  const probability = _val("min_probability");
  const oidsRaw = _val("objectIds");
  const minDet = _val("min_detections");
  const maxDet = _val("max_detections");

  // Classifier version dropdown: "latest" resolves to the chosen
  // classifier option's data-latest-version (computed server-side),
  // "any" sends nothing, otherwise pass the picked version through.
  // Version is meaningless without a chosen classifier, so we skip
  // the field entirely in that case.
  //
  // The Version control is currently HIDDEN in the form (see form.html.jinja):
  // neither survey's list_objects endpoint actually honors classifier_version —
  // ZTF returns ZERO rows for any value (even the one it reports), LSST ignores
  // it. So when the select is absent we default to "any" (send nothing) rather
  // than the old "latest" fallback, which is what was silently zeroing ZTF
  // searches. Restore the default to "latest" when the control returns.
  const versionSelect = document.getElementById("classifier_version");
  const versionMode = versionSelect ? versionSelect.value : "any";
  let resolvedVersion = null;
  if (classifier && versionMode && versionMode !== "any") {
    if (versionMode === "latest") {
      const sel = document.getElementById("classifier");
      const opt = sel ? sel.options[sel.selectedIndex] : null;
      const latest = opt?.dataset?.latestVersion || "";
      if (latest) resolvedVersion = latest;
    } else {
      resolvedVersion = versionMode;
    }
  }

  const payload = { survey };
  if (classifier) payload.classifier = classifier;
  if (className) payload.class_name = className;
  if (resolvedVersion) payload.classifier_version = resolvedVersion;
  if (probability && parseFloat(probability) > 0) payload.probability = probability;
  // The free-text OID-list search goes to the htmx endpoint as `oids=`
  // (plural) so the *internal* call can't collide with the detail view's
  // single-object `oid=`. The shareable browser URL (set server-side via
  // HX-Push-Url) re-emits this list under `oid=` to match the production
  // explorer's convention (`?survey=lsst&oid=123,456,789`).
  if (oidsRaw) payload.oids = oidsRaw;
  if (minDet) payload.n_det_min = minDet;
  if (maxDet) payload.n_det_max = maxDet;

  // Discovery-date filter: free-text input parsed into MJD client-side
  // (accepts MJD, JD, ISO date, etc. — see coords.js::smartDateToMJD).
  // Only the parsed numeric value goes upstream; the original text stays in
  // the form for the user.
  const dateFromRaw = _val("filter-date-from");
  const dateToRaw = _val("filter-date-to");
  if (window.smartDateToMJD) {
    if (dateFromRaw) {
      const m = window.smartDateToMJD(dateFromRaw);
      if (m != null) payload.firstmjd_min = m;
    }
    if (dateToRaw) {
      const m = window.smartDateToMJD(dateToRaw);
      if (m != null) payload.firstmjd_max = m;
    }
  }

  // Last-detection-date filter: twin of the discovery-date pair above, but
  // feeds `lastmjd_min/max` (constrains the object's most recent detection).
  const lastDateFromRaw = _val("filter-lastdate-from");
  const lastDateToRaw = _val("filter-lastdate-to");
  if (window.smartDateToMJD) {
    if (lastDateFromRaw) {
      const m = window.smartDateToMJD(lastDateFromRaw);
      if (m != null) payload.lastmjd_min = m;
    }
    if (lastDateToRaw) {
      const m = window.smartDateToMJD(lastDateToRaw);
      if (m != null) payload.lastmjd_max = m;
    }
  }

  // Cone-search filter: parse the "ra dec" free-text field into degrees
  // (any format: plain, comma-separated, sexagesimal). Radius is taken as
  // arcsec; only attached when coords actually parsed so the upstream call
  // stays a global listing if the field is bad/empty.
  const coordsRaw = _val("filter-coords");
  if (coordsRaw && window.parseCoordinates) {
    const c = window.parseCoordinates(coordsRaw);
    if (c) {
      payload.ra = c.ra;
      payload.dec = c.dec;
      const r = _val("filter-radius");
      if (r) payload.radius = r;
    }
  }
  return payload;
}

function send_pagination_data(page) {
  return { page };
}

function send_order_data(order_by, order_mode) {
  return {
    order_by: order_by && order_by !== "None" ? order_by : undefined,
    order_mode: order_mode && order_mode !== "None" ? order_mode : "DESC",
  };
}

// Read the classes[] attached to the currently-selected classifier option.
function send_classes_data() {
  const sel = document.getElementById("classifier");
  if (!sel) return { classifier_classes: [] };
  const opt = sel.options[sel.selectedIndex];
  let classes = [];
  try {
    classes = JSON.parse(opt?.dataset?.classes ?? "[]");
  } catch {
    classes = [];
  }
  return { classifier_classes: classes };
}

window.send_form_Data = send_form_Data;
window.send_pagination_data = send_pagination_data;
window.send_order_data = send_order_data;
window.send_classes_data = send_classes_data;

// Results cache. Whenever #results-slot is showing a listing (i.e. contains
// #objects_table), we snapshot the HTML + the URL that was pushed for it.
// The "Back to results" button restores from this cache instead of re-firing
// the upstream ALeRCE API query — which means no network call, no spinner,
// and no perceptible delay.
//
// The snapshot is mirrored into sessionStorage so it also survives a full
// page reload: refreshing while on a detail view (or following a deep-link
// straight into one) wipes the in-memory copy, but the sessionStorage copy
// still lets Back restore the prior listing instead of re-querying — which,
// on an unfiltered/slow survey, is what made Back appear to hang.
(function () {
  const SS_HTML = "alerceLastResultsHtml";
  const SS_URL = "alerceLastResultsUrl";

  // Snapshot the listing with any transient htmx state stripped. htmx:afterSwap
  // fires during the settle phase while htmx still has `.htmx-request` on the
  // `hx-indicator` target (#results-loading) — it's removed a beat later. If we
  // cache that raw innerHTML, the "Searching…" overlay class is baked in, and
  // restoring it later shows a spinner that never stops (no real request is in
  // flight to clear it). Clone + strip so the cached HTML is always inert.
  function snapshotListing(slot) {
    const clone = slot.cloneNode(true);
    clone.querySelectorAll(".htmx-request").forEach((e) => e.classList.remove("htmx-request"));
    // Don't persist the "you came from here" highlight into the cache — it's a
    // per-return decoration, applied fresh on each Back, not a property of the
    // listing.
    clone.querySelectorAll(".row-return-highlight").forEach((e) => e.classList.remove("row-return-highlight"));
    return clone.innerHTML;
  }

  function storeListing(html, url) {
    window._lastResultsHtml = html;
    window._lastResultsUrl = url;
    try {
      sessionStorage.setItem(SS_HTML, html);
      sessionStorage.setItem(SS_URL, url || "");
    } catch (_) { /* quota / private mode — the in-memory copy still works */ }
  }

  // Public hook for object_nav.js cross-page navigation (arrows crossing a page
  // boundary, or the in-detail page dropdown). Those fetch a new page's listing
  // but never re-render #results-slot, so the afterSwap caching listener never
  // fires and the Back cache would stay stale on the previous page — the cause
  // of "Back from page 2 sends me to page 1". Letting that path push the
  // freshly-fetched page in keeps Back aligned with the page being browsed.
  window.cacheResultsListing = function (html, url) {
    if (!html) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    wrap.querySelectorAll(".htmx-request, .row-return-highlight")
      .forEach((e) => e.classList.remove("htmx-request", "row-return-highlight"));
    storeListing(wrap.innerHTML, url || "");
  };
  function cachedHtml() {
    if (window._lastResultsHtml) return window._lastResultsHtml;
    try { return sessionStorage.getItem(SS_HTML) || ""; } catch (_) { return ""; }
  }
  function cachedUrl() {
    if (window._lastResultsUrl) return window._lastResultsUrl;
    try { return sessionStorage.getItem(SS_URL) || ""; } catch (_) { return ""; }
  }

  document.addEventListener("htmx:afterSwap", (evt) => {
    const t = evt.detail && evt.detail.target;
    const slot = document.getElementById("results-slot");
    const hasDetail = slot && slot.querySelector("#object-detail");
    const hasTable = slot && slot.querySelector("#objects_table");
    // Panel auto-hide/show: only react when the results-slot *itself* was
    // swapped (a drill-in or a listing render), so inner detail-fragment
    // loads don't keep re-hiding a panel the user opened mid-detail. The
    // toggle button remains the manual override.
    if (t && t.id === "results-slot" && window.setSearchPanelVisible) {
      if (hasDetail) window.setSearchPanelVisible(false);
      else if (hasTable) window.setSearchPanelVisible(true);
    }
    // Drilling into a detail cancels any pending return-highlight intent.
    if (hasDetail) window._returnHighlightOid = "";
    // Caching: inspect the live results-slot directly rather than trusting
    // evt.detail.target — that way a listing is captured no matter which
    // element triggered the swap (Search button, pagination, row click).
    if (slot && hasTable) {
      storeListing(snapshotListing(slot), window.location.pathname + window.location.search);
      // (Re)apply the "you came from here" highlight. Re-applying on every
      // listing swap (not just once) makes it survive a late swap into
      // results-slot — e.g. a slow detail request from the object we just
      // left resolving ~1s after Back and re-rendering the table, which
      // would otherwise wipe a one-shot highlight.
      maybeApplyReturnHighlight();
    }
  });

  // The OID of the object we're returning from — read from the live detail
  // container, falling back to the URL during the swap-out moment.
  function currentDetailOid() {
    const el = document.getElementById("object-detail");
    if (el && el.dataset.oid) return el.dataset.oid;
    return new URLSearchParams(window.location.search).get("oid") || "";
  }

  // Highlight the row of the object we returned from. Driven by
  // window._returnHighlightOid (set on Back) within a short time window so a
  // later, unrelated listing (a new search) isn't decorated. Idempotent: the
  // class guard prevents re-scrolling once it's already on the right row.
  function maybeApplyReturnHighlight() {
    const oid = window._returnHighlightOid;
    if (!oid) return;
    if (window._returnHighlightUntil && Date.now() > window._returnHighlightUntil) return;
    const slot = document.getElementById("results-slot");
    if (!slot) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(oid) : oid;
    const row = slot.querySelector(`#objects_table tr[data-oid="${sel}"]`);
    if (!row || row.classList.contains("row-return-highlight")) return;
    row.classList.add("row-return-highlight");
    try { row.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (_) { row.scrollIntoView(); }
  }

  function restoreFromCache() {
    const slot = document.getElementById("results-slot");
    const html = cachedHtml();
    if (!slot || !html) return false;
    slot.innerHTML = html;
    // Belt-and-suspenders: clear any stuck `.htmx-request` (e.g. a stale
    // snapshot from sessionStorage written before snapshotListing existed) so
    // the "Searching…" overlay can't be restored in its mid-request state.
    // Also drop any stale return-highlight so only the fresh one shows.
    slot.querySelectorAll(".htmx-request, .row-return-highlight")
      .forEach((e) => e.classList.remove("htmx-request", "row-return-highlight"));
    // Re-scan for hx-* attributes on rows/pagination so they become active.
    if (window.htmx && window.htmx.process) window.htmx.process(slot);
    const url = cachedUrl();
    if (url) {
      window.history.pushState({}, "", url);
    }
    // Synthetic afterSwap so object_nav.js (and anyone else listening) re-reads
    // the table's data-nav and refreshes the chip row / arrow state — and so the
    // caching listener (re)applies the return-highlight.
    document.dispatchEvent(new CustomEvent("htmx:afterSwap", {
      detail: { target: slot },
    }));
    return true;
  }

  function backToResults() {
    // Remember which object we're returning from so the listing swap (cache
    // restore *or* network fallback, plus any late re-render) highlights its
    // row. Time-boxed so a later, unrelated search doesn't get decorated.
    window._returnHighlightOid = currentDetailOid();
    window._returnHighlightUntil = Date.now() + 5000;
    if (restoreFromCache()) return;
    // No cache (deep-linked straight into a detail view). Use the current
    // URL as the source of truth rather than the form state — the detail
    // route's HX-Push-Url already encodes every filter (classifier,
    // class_name, probability, etc.), so stripping the detail-only keys
    // (`oid`, `identifier`) gives us exactly the listing the user was
    // implicitly viewing. Reading from the form was unreliable: its
    // dependent class_name select can still be empty on first render (the
    // class list is rendered server-side only when the classifier's class
    // list includes the chosen class), and any hydration hiccup silently
    // dropped the filter on Back.
    const url = new URL(window.location.href);
    url.searchParams.delete("oid");
    url.searchParams.delete("identifier");
    // Deep-links that include a classifier but no class_name (e.g. a shared
    // detail URL) would otherwise return an unfiltered listing. Fill the gap
    // with the radar's active top class so the user lands on "objects like
    // this one" under the same classifier they were looking at.
    if (!url.searchParams.get("class_name") && window._currentObjectClass) {
      url.searchParams.set("class_name", window._currentObjectClass);
      if (!url.searchParams.get("classifier") && window._currentObjectClassifier) {
        url.searchParams.set("classifier", window._currentObjectClassifier);
      }
    }
    const listUrl = `/htmx/list_objects?${url.searchParams.toString()}`;
    // The return-highlight is applied by the afterSwap listener when this
    // listing lands (window._returnHighlightOid was set above).
    if (window.htmx) window.htmx.ajax("GET", listUrl, "#results-slot");
  }

  window.backToResults = backToResults;

  /* Fire-and-forget bulk-crossmatch prefetch for the objects on a results page
   * (or the whole OID list). Reads the [{oid,ra,dec}] payload off the hidden
   * #xmatch-prefetch element and POSTs it to /htmx/xmatch_prefetch, which warms
   * the server-side cache so detail-view crossmatch + spec-z overlays are
   * instant. Off the critical path — failures are swallowed. */
  function send_xmatch_prefetch(el) {
    try {
      const positions = JSON.parse(el.getAttribute("data-xmatch-positions") || "[]");
      if (!positions.length) return;
      fetch((window.API_URL || "") + "/htmx/xmatch_prefetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: positions }),
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* malformed payload — skip */ }
  }
  window.send_xmatch_prefetch = send_xmatch_prefetch;
})();
