// Mobile scroll-shield ("tap to interact") for touch-trapping panels.
//
// Problem: the light-curve, periodogram, coord-residuals and colour-evolution
// charts register chartjs-plugin-zoom (pinch/drag), and Aladin Lite manages
// its own touch gestures. On a touch device all of them call
// preventDefault() on touchmove, so a vertical swipe that *starts* inside the
// plot pans/zooms the chart (or the sky map) instead of scrolling the page —
// the user gets trapped inside the panel and can't scroll past it.
//
// Fix: on coarse-pointer devices we lay a transparent overlay ("shield") over
// each trapping plot area. The shield is a plain <div> — it does NOT
// preventDefault — so a one-finger drag over it scrolls the page normally,
// while the chart/map underneath never sees the gesture. A *tap* (a click,
// which browsers suppress after a scroll) activates the panel: the shield
// hides and touches reach the chart/map for pan & pinch-zoom. Scrolling the
// page again (the "I'm moving on" signal) re-arms every active shield.
//
// Desktop / mouse users never get a shield — mouse-wheel and modifier-gated
// drag don't hijack page scroll, so there is nothing to fix there.
//
// The shield only covers the plot/map area (the marked wrapper), not the
// panel's toolbar or legend, so Flux/Mag toggles, band legends, the
// periodogram/airmass buttons etc. stay tappable without arming anything.

(function () {
  // Coarse pointer ⇒ touch-first device. Evaluated once at load; a hybrid
  // tablet that later attaches a mouse still works (the shield tap is a
  // click, which a mouse also produces).
  if (!window.matchMedia || !window.matchMedia("(pointer: coarse)").matches) {
    return;
  }

  var HOST_SELECTOR = ".js-scroll-shield";
  var REARM_GRACE_MS = 450; // ignore scroll re-arm right after an activation
  var lastActivateAt = 0;

  // One-time style injection so the module is self-contained (no Tailwind
  // rebuild). Kept minimal; colours borrow the app's card/border palette.
  function injectStyles() {
    if (document.getElementById("scroll-shield-styles")) return;
    var css = [
      // z-index high enough to sit above Aladin's mounted canvas + controls
      // as well as the Chart.js canvas; scoped to the plot wrapper via inset:0.
      ".scroll-shield{position:absolute;inset:0;z-index:400;display:flex;",
      "align-items:flex-end;justify-content:center;cursor:pointer;",
      // pan-y lets a vertical drag scroll the page; the chart never sees it.
      "touch-action:pan-y;-webkit-tap-highlight-color:transparent;",
      "background:transparent;}",
      ".scroll-shield[hidden]{display:none;}",
      ".scroll-shield__hint{margin-bottom:8px;padding:3px 10px;border-radius:9999px;",
      "font:500 11px/1.4 'IBM Plex Sans',system-ui,sans-serif;",
      "color:#ededed;background:rgba(22,27,34,0.82);",
      "border:1px solid rgba(120,120,120,0.5);",
      "backdrop-filter:blur(2px);pointer-events:none;",
      "display:flex;align-items:center;gap:5px;user-select:none;",
      "box-shadow:0 1px 4px rgba(0,0,0,0.4);}",
      ".scroll-shield__hint svg{width:12px;height:12px;flex-shrink:0;}",
    ].join("");
    var style = document.createElement("style");
    style.id = "scroll-shield-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Small finger-tap glyph so the hint reads at a glance without an icon font.
  var HINT_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 11V6a2 2 0 0 1 4 0v5"/>' +
    '<path d="M13 8a2 2 0 0 1 4 0v3"/>' +
    '<path d="M17 10a2 2 0 0 1 4 0v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-5.2-3l-2.3-4a2 2 0 0 1 3.4-2L9 12"/>' +
    "</svg>";

  // Track shields so a page scroll can re-arm the ones the user activated.
  var shields = [];

  function armShield(shield) {
    shield.removeAttribute("hidden");
  }
  function disarmShield(shield) {
    // Re-arm every OTHER active shield first — only one plot interactive at a
    // time keeps the "tap to interact / scroll to leave" model predictable.
    shields.forEach(function (s) {
      if (s !== shield) armShield(s);
    });
    shield.setAttribute("hidden", "");
    lastActivateAt = Date.now();
  }

  function attachShield(host) {
    if (host.dataset.scrollShielded === "1") return;
    host.dataset.scrollShielded = "1";

    var shield = document.createElement("div");
    shield.className = "scroll-shield";
    shield.setAttribute("aria-hidden", "true");
    shield.innerHTML =
      '<span class="scroll-shield__hint">' +
      HINT_SVG +
      "<span>Tap to interact</span></span>";

    // A `click` fires on a genuine tap but is suppressed by the browser after
    // a scroll-drag — exactly the discrimination we want, no manual
    // move-tolerance bookkeeping needed.
    shield.addEventListener("click", function () {
      disarmShield(shield);
    });

    host.appendChild(shield);
    shields.push(shield);
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var hosts = scope.querySelectorAll(HOST_SELECTOR);
    for (var i = 0; i < hosts.length; i++) attachShield(hosts[i]);
    // If root itself is a host (htmx can settle the host node directly).
    if (root && root.matches && root.matches(HOST_SELECTOR)) attachShield(root);
  }

  // Re-arm on page scroll: the user scrolling elsewhere means "I'm done with
  // this plot, lock it again so I don't get re-trapped." Capture phase so a
  // scroll on any nested overflow container is caught too (scroll doesn't
  // bubble). rAF-coalesced; grace window swallows the momentum right after an
  // activating tap.
  var scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      if (Date.now() - lastActivateAt < REARM_GRACE_MS) return;
      for (var i = 0; i < shields.length; i++) armShield(shields[i]);
    });
  }
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  // Drop dead shields (whose host left the DOM on a detail-view swap) so the
  // array doesn't grow unbounded across object navigation.
  function pruneDetached() {
    shields = shields.filter(function (s) {
      return s.isConnected;
    });
  }

  injectStyles();

  // Fragments arrive via htmx swaps; re-scan after each settle. Also scan
  // once at startup for anything already in the DOM.
  document.addEventListener("htmx:afterSettle", function (e) {
    pruneDetached();
    scan(e.target || document);
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      scan(document);
    });
  } else {
    scan(document);
  }
})();
