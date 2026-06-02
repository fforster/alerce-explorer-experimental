/* Object-level navigation: prev/next arrow buttons + keyboard arrows walk
 * through the current result set, hopping to the previous/next page when
 * they run out of siblings.
 *
 * State lives on `window._resultsNav`, refreshed every time the results
 * table renders (the table template stamps `data-nav` on #objects_table;
 * we read it here). Cross-page hops re-fetch /htmx/list_objects with the
 * current filter state, parse the response to pick up its `data-nav`, and
 * then open the detail for the first/last OID of the new page.
 */
(function () {
  function readNavFromTable(root) {
    const scope = root || document;
    const table = scope.querySelector ? scope.querySelector("#objects_table") : null;
    if (!table) return null;
    const raw = table.dataset.nav;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function currentDetailOid() {
    // Prefer the live DOM (detail container carries data-oid); fall back to
    // the URL for the transitional moment right after a hx-swap.
    const el = document.getElementById("object-detail");
    if (el && el.dataset.oid) return el.dataset.oid;
    return new URLSearchParams(window.location.search).get("oid");
  }

  function currentFilters() {
    return (typeof window.send_form_Data === "function")
      ? window.send_form_Data()
      : {};
  }

  function detailUrl(oid) {
    // Carry the *full* filter context (classifier, class_name, probability,
    // ndet range, dates, conesearch, oids…) into the detail URL — not just
    // survey + classifier. The detail route echoes every param into
    // HX-Push-Url, so the address bar keeps the search context the user
    // navigated from. Mirrors the row-click `filter_qs` in
    // objects_table.html.jinja.
    //
    // Why it matters: `backToResults()` rebuilds the listing from
    // window.location on a cache miss. If the detail URL had dropped
    // class_name (as the old version did), Back would fire an *unfiltered*
    // list_objects — on ZTF that's an enormous set that hangs. Preserving
    // the filters keeps Back a cheap, correctly-scoped query.
    const filters = currentFilters();
    const nav = window._resultsNav || {};
    const survey = filters.survey || nav.survey || "";
    const params = new URLSearchParams();
    params.set("oid", oid);
    params.set("survey_id", survey);
    Object.entries(filters).forEach(([k, v]) => {
      if (k === "survey") return; // sent above as survey_id
      if (v === undefined || v === null || v === "") return;
      params.set(k, String(v));
    });
    // classifier can live on the nav payload even if the form hasn't
    // re-hydrated it yet; backfill so the link is never missing it.
    if (!params.has("classifier") && nav.classifier) {
      params.set("classifier", nav.classifier);
    }
    // Preserve the page the user is browsing so Back returns to it.
    if (nav.current_page && nav.current_page > 1) {
      params.set("page", String(nav.current_page));
    }
    return `/htmx/detail?${params.toString()}`;
  }

  function openDetail(oid) {
    if (!oid) return;
    // htmx.ajax drives the same swap/push-url machinery as a normal hx-get,
    // so the browser address bar stays in sync with the opened object.
    window.htmx.ajax("GET", detailUrl(oid), "#results-slot");
  }

  async function fetchPageNav(page) {
    const filters = currentFilters();
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") params.append(k, String(v));
    });
    params.set("page", String(page));
    const url = `/htmx/list_objects?${params.toString()}`;
    const resp = await fetch(url, { headers: { "HX-Request": "true" } });
    if (!resp.ok) return null;
    const html = await resp.text();
    // Parse into a detached template so no side effects (inline scripts
    // don't run, no <img> loads) touch the live document.
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    return readNavFromTable(tpl.content);
  }

  function renderOidList(nav, currentOid) {
    const list = document.getElementById("object-nav-list");
    if (!list) return;
    list.innerHTML = "";
    if (!nav || !nav.oids || !nav.oids.length) return;
    const frag = document.createDocumentFragment();
    nav.oids.forEach((o) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.oid = o;
      const active = String(o) === String(currentOid);
      // Each candidate is a 9×9 dot with a 1px translucent accent ring.
      // The active OID is filled (also translucent) while the rest stay
      // transparent so the page background shows through — "filled vs
      // hollow" reads at a glance without the row competing with the
      // adjacent buttons for attention. Hover bumps the alpha so the
      // pointer target is still obvious. OID rides on `title` (native
      // tooltip) + `aria-label` (screen readers) since the dot has no
      // visible text.
      btn.className =
        "tw-w-[9px] tw-h-[9px] tw-rounded-full tw-border tw-border-accent/50 tw-flex-none tw-transition-colors "
        + (active ? "tw-bg-accent/60" : "tw-bg-transparent hover:tw-bg-accent/25");
      btn.title = o;
      btn.setAttribute("aria-label", `Open ${o}`);
      frag.appendChild(btn);
    });
    list.appendChild(frag);
  }

  // Highest results page the user has visited in this session — only used
  // when the server doesn't supply an exact `total_pages`. The upstream
  // doesn't report a total count (count=False) for generic searches, so
  // this is our only ceiling for the page-jump dropdown in that case.
  // Grows as the user walks forward; never shrinks within a session.
  function bumpMaxPage(nav) {
    if (!nav) return;
    const candidate = nav.current_page + (nav.has_next ? 1 : 0);
    window._resultsMaxPage = Math.max(window._resultsMaxPage || 1, candidate);
  }

  function renderPagePicker(posEl, nav, pos) {
    posEl.innerHTML = "";
    if (!nav) return;
    const human = pos >= 0 ? (pos + 1) : "?";
    const prefix = document.createElement("span");
    prefix.textContent = `${human}/${nav.oids.length} · page `;
    posEl.appendChild(prefix);

    // Two regimes:
    //   - Exact total known (`total_pages` from the server, set when the
    //     user filtered by an OID list — we know len(oids)/page_size up
    //     front). Dropdown lists 1..total exactly.
    //   - Total unknown (generic search; upstream doesn't return a count).
    //     Dropdown lists 1..max-seen plus a disabled "…" entry so the
    //     user can tell more pages exist beyond what's enumerated.
    const exactTotal = Number.isFinite(nav.total_pages) ? nav.total_pages : null;
    const maxKnown = exactTotal != null
      ? exactTotal
      : (window._resultsMaxPage || nav.current_page);
    if (maxKnown <= 1 && exactTotal == null) {
      const tail = document.createElement("span");
      tail.textContent = String(nav.current_page);
      posEl.appendChild(tail);
      return;
    }
    const select = document.createElement("select");
    select.className =
      "object-nav-page-select tw-bg-bg-card tw-border tw-border-border tw-rounded "
      + "tw-px-1 tw-py-0.5 tw-text-xs tw-text-text-primary mono";
    select.title = exactTotal != null
      ? `Jump to results page (1 of ${exactTotal})`
      : "Jump to results page (total unknown — more pages may exist)";
    select.setAttribute("aria-label", "Jump to results page");
    for (let p = 1; p <= maxKnown; p++) {
      const opt = document.createElement("option");
      opt.value = String(p);
      opt.textContent = exactTotal != null ? `${p} / ${exactTotal}` : String(p);
      if (p === nav.current_page) opt.selected = true;
      select.appendChild(opt);
    }
    if (exactTotal == null) {
      // Non-selectable hint: there are pages beyond what we know about.
      // `disabled` keeps it un-clickable; users still see "…" in the
      // dropdown panel so the open-endedness is communicated.
      const more = document.createElement("option");
      more.textContent = "…";
      more.disabled = true;
      select.appendChild(more);
    }
    select.addEventListener("change", () => {
      const target = parseInt(select.value, 10);
      if (Number.isFinite(target)) jumpToPage(target);
    });
    posEl.appendChild(select);
  }

  async function jumpToPage(page) {
    const nav = window._resultsNav;
    if (!nav || page === nav.current_page) return;
    const newNav = await fetchPageNav(page);
    if (!newNav || !newNav.oids || !newNav.oids.length) return;
    window._resultsNav = newNav;
    bumpMaxPage(newNav);
    openDetail(newNav.oids[0]);
  }

  function updateButtons() {
    const wrap = document.getElementById("object-nav");
    const bar = document.getElementById("detail-nav-bar");
    const nav = window._resultsNav;
    const oid = currentDetailOid();
    const posEl = document.getElementById("object-nav-position");
    // The whole nav row in the header tracks "is a detail on screen". When
    // the user is on the listing or a fresh `/`, the bar collapses so the
    // header reads as just the title. Independent of `nav` so a deep-link
    // without results-page context still shows the back button + (empty)
    // dots row.
    if (bar) {
      if (oid) {
        bar.classList.remove("tw-hidden");
        bar.classList.add("tw-flex");
      } else {
        bar.classList.add("tw-hidden");
        bar.classList.remove("tw-flex");
      }
    }
    renderOidList(nav, oid);
    if (!wrap) return;
    if (!nav || !nav.oids || !nav.oids.length || !oid) {
      wrap.classList.add("tw-hidden");
      wrap.classList.remove("tw-flex");
      if (posEl) posEl.innerHTML = "";
      return;
    }
    wrap.classList.remove("tw-hidden");
    wrap.classList.add("tw-flex");
    bumpMaxPage(nav);
    const pos = nav.oids.indexOf(String(oid));
    const prevBtn = document.getElementById("object-nav-prev");
    const nextBtn = document.getElementById("object-nav-next");
    // At the edge we still enable the button iff there's another page to
    // walk into; otherwise disable.
    if (prevBtn) prevBtn.disabled = !(pos > 0 || nav.has_prev);
    if (nextBtn) {
      nextBtn.disabled = !((pos >= 0 && pos < nav.oids.length - 1) || nav.has_next);
    }
    if (posEl) renderPagePicker(posEl, nav, pos);
  }

  async function navObject(direction) {
    const nav = window._resultsNav;
    if (!nav || !nav.oids || !nav.oids.length) return;
    const oid = currentDetailOid();
    if (!oid) return;
    const pos = nav.oids.indexOf(String(oid));
    let target = null;

    if (direction === "next") {
      if (pos >= 0 && pos < nav.oids.length - 1) {
        target = nav.oids[pos + 1];
      } else if (nav.has_next) {
        const newNav = await fetchPageNav(nav.next);
        if (newNav && newNav.oids && newNav.oids.length) {
          window._resultsNav = newNav;
          bumpMaxPage(newNav);
          target = newNav.oids[0];
        }
      }
    } else if (direction === "prev") {
      if (pos > 0) {
        target = nav.oids[pos - 1];
      } else if (nav.has_prev) {
        const newNav = await fetchPageNav(nav.prev);
        if (newNav && newNav.oids && newNav.oids.length) {
          window._resultsNav = newNav;
          bumpMaxPage(newNav);
          target = newNav.oids[newNav.oids.length - 1];
        }
      }
    }
    if (target) openDetail(target);
  }

  window.navObject = navObject;

  function refreshNavState(root) {
    const n = readNavFromTable(root);
    if (n) window._resultsNav = n;
    updateButtons();
  }

  // Keyboard nav: arrow keys walk between objects. Skip when the user is
  // typing in an input, textarea, or contenteditable element — otherwise
  // the filter form becomes unusable.
  function onKeydown(ev) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const t = ev.target;
    if (t) {
      const tag = (t.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (t.isContentEditable) return;
    }
    // Only act when a detail is actually on screen.
    if (!document.getElementById("object-detail")) return;
    ev.preventDefault();
    navObject(ev.key === "ArrowRight" ? "next" : "prev");
  }

  // Touch swipe nav (mobile): a horizontal swipe across the detail view
  // walks between objects — swipe right → previous, swipe left → next,
  // mirroring the ArrowLeft/ArrowRight key mapping above. Carousel
  // convention: the content "follows" the finger, so dragging right
  // pulls the previous object into view.
  //
  // Gated tightly so it never fights the interactive panels:
  //   - only when a detail is on screen AND the viewport is mobile-width
  //     (the desktop two-column layout has no use for swipe-to-nav);
  //   - single-finger only (a second touch means pinch-zoom on a chart);
  //   - the gesture must start outside any panel that owns horizontal
  //     drag — Chart.js canvases (Hammer.js pan/zoom), the Aladin sky
  //     viewer (`.aladin-host`), form controls, and the modal overlays.
  // A swipe only fires when it's clearly horizontal, long enough, and
  // quick enough to read as a flick rather than a slow scroll.
  const SWIPE_MIN_PX = 70;       // minimum horizontal travel
  const SWIPE_MAX_OFF_AXIS = 0.6; // |dy| must stay under this × |dx|
  const SWIPE_MAX_MS = 800;      // slower than this reads as a scroll/drag
  let swipe = null;

  function swipeStartBlocked(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      "canvas, .aladin-host, select, input, textarea, "
      + "[contenteditable], #features-modal, #avro-modal"
    );
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 1023px)").matches;
  }

  function onTouchStart(ev) {
    swipe = null;
    if (ev.touches.length !== 1) return;          // pinch / multi-touch
    if (!isMobileViewport()) return;
    if (!document.getElementById("object-detail")) return;
    const t = ev.touches[0];
    if (swipeStartBlocked(t.target)) return;
    swipe = { x: t.clientX, y: t.clientY, time: Date.now() };
  }

  function onTouchEnd(ev) {
    const start = swipe;
    swipe = null;
    if (!start) return;
    const t = ev.changedTouches && ev.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Date.now() - start.time > SWIPE_MAX_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_OFF_AXIS) return;
    navObject(dx < 0 ? "next" : "prev");
  }

  // Delegate chip clicks on the list container (survives htmx swaps because
  // we listen on document, and the list is re-populated in place).
  function onListClick(ev) {
    const btn = ev.target.closest("#object-nav-list button[data-oid]");
    if (!btn) return;
    ev.preventDefault();
    openDetail(btn.dataset.oid);
  }

  document.addEventListener("DOMContentLoaded", () => {
    refreshNavState(document);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("click", onListClick);
    // Passive: we never preventDefault (a swipe that turns out to be a
    // scroll must still scroll), so the browser can keep scrolling smooth.
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
  });
  document.addEventListener("htmx:afterSwap", (evt) => {
    refreshNavState(evt.detail.target);
  });
})();
