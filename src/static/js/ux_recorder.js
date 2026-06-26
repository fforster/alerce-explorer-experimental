/* Client-side session-replay analytics (rrweb).
 *
 * Records the session (DOM mutations + cursor + clicks + input) and ships
 * batched events to POST {API_URL}/api/ux_events via navigator.sendBeacon, so
 * nothing blocks the UI thread or any htmx request. Loaded ONLY when the
 * server sets ANALYTICS_ENABLED (base.html gates the <script> on that flag), so
 * "disabled" means this file isn't even on the page.
 *
 * Overhead is deliberately constrained for this canvas-heavy app:
 *   - recordCanvas:false  → Chart.js / FITS / Aladin canvases are NOT recorded
 *     (they would dominate payload size for little behavioral signal).
 *   - mousemove throttled to ~20 Hz, input recorded as final value only.
 *   - events buffered and flushed every 5 s / 50 events / on page-hide.
 *
 * Privacy: anonymous ids only, no PII; honors Do-Not-Track / Global Privacy
 * Control and a localStorage opt-out. See analytics.py for the server side.
 *
 * Future login: identity is read at flush time from window.analyticsIdentity()
 * — login code overrides that hook to attach {auth, user_id, data_rights_tier}
 * with zero changes here. Add the `rr-block` class to any element to exclude it
 * from recording.
 */
(function () {
  "use strict";

  // One-line console breadcrumbs so it's obvious in DevTools whether recording
  // is on and why it might be quiet (DNT/opt-out bail, no flush yet, etc.).
  function note(msg) { try { console.info("[analytics] " + msg); } catch (e) {} }

  if (typeof window.rrwebRecord !== "function") {
    note("rrweb bundle not loaded — recorder inactive");
    return;
  }

  // --- Opt-out gates (checked before anything is recorded) -----------------
  function dntEnabled() {
    var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
    return dnt === "1" || dnt === "yes" || navigator.globalPrivacyControl === true;
  }
  function optedOut() {
    try {
      return localStorage.getItem("analytics_opt_out") === "1";
    } catch (e) {
      return false;
    }
  }
  // Public hooks so an opt-out link can be wired later (no banner today).
  window.analyticsOptOut = function () {
    try { localStorage.setItem("analytics_opt_out", "1"); } catch (e) {}
  };
  window.analyticsOptIn = function () {
    try { localStorage.removeItem("analytics_opt_out"); } catch (e) {}
  };

  // Local-testing override: set localStorage.analytics_debug = "1" in your own
  // browser to bypass the DNT/GPC bail so you can verify the full pipeline
  // (e.g. in Brave, which sends GPC by default). Explicit opt-out still wins.
  var debug = false;
  try { debug = localStorage.getItem("analytics_debug") === "1"; } catch (e) {}

  if (optedOut()) {
    note("not recording: opted out (localStorage analytics_opt_out=1; clear with analyticsOptIn())");
    return;
  }
  if (dntEnabled() && !debug) {
    note("not recording: Do-Not-Track / Global Privacy Control is enabled in this browser " +
         "(set localStorage.analytics_debug='1' to override for local testing)");
    return;
  }
  if (dntEnabled() && debug) {
    note("DNT/GPC is on but overridden for testing (localStorage analytics_debug=1)");
  }

  // --- Anonymous identity ---------------------------------------------------
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function storedId(store, key) {
    try {
      var id = store.getItem(key);
      if (!id) { id = uuid(); store.setItem(key, id); }
      return id;
    } catch (e) {
      return uuid(); // private mode etc. — ephemeral id, still works
    }
  }
  var sessionId = storedId(sessionStorage, "analytics_session_id"); // per tab
  var visitorId = storedId(localStorage, "analytics_visitor_id");   // returning

  // Pluggable identity hook; login code can override window.analyticsIdentity.
  // Default is anonymous/public. Never put raw PII here (use an opaque id).
  if (typeof window.analyticsIdentity !== "function") {
    window.analyticsIdentity = function () {
      return { auth: "anonymous", user_id: null, data_rights_tier: "public" };
    };
  }

  // --- Buffer + transport ---------------------------------------------------
  var ENDPOINT = (window.API_URL || "") + "/api/ux_events";
  var MAX_BUFFER = 50; // flush when this many events queue up
  var FLUSH_MS = 5000; // ...or at least this often
  var buffer = [];

  function flush() {
    if (!buffer.length) return;
    var events = buffer;
    buffer = [];
    var body;
    try {
      body = JSON.stringify({
        visitor_id: visitorId,
        session_id: sessionId,
        identity: window.analyticsIdentity(),
        url: location.href,
        ua: navigator.userAgent,
        ts: Date.now(),
        events: events,
      });
    } catch (e) {
      return; // give up on this batch rather than throw into the page
    }
    var blob = new Blob([body], { type: "application/json" });
    var sent = false;
    if (navigator.sendBeacon) {
      try { sent = navigator.sendBeacon(ENDPOINT, blob); } catch (e) { sent = false; }
    }
    if (sent) {
      note("flushed " + events.length + " events via sendBeacon → " + ENDPOINT);
      return;
    }
    // sendBeacon unavailable/refused — keepalive fetch survives unload too.
    try {
      fetch(ENDPOINT, { method: "POST", body: blob, keepalive: true, credentials: "omit" });
      note("flushed " + events.length + " events via fetch → " + ENDPOINT);
    } catch (e) {
      note("flush FAILED (sendBeacon refused and fetch threw) → " + ENDPOINT);
    }
  }

  // --- Start recording ------------------------------------------------------
  function start() {
    window.rrwebRecord({
      emit: function (event) {
        buffer.push(event);
        if (buffer.length >= MAX_BUFFER) flush();
      },
      recordCanvas: false,        // skip Chart.js / FITS / Aladin canvases
      collectFonts: false,
      sampling: {
        mousemove: 50,            // ~20 Hz cursor trails, batched
        scroll: 150,
        input: "last",          // final field value, not every keystroke
        media: 800,
      },
      slimDOMOptions: "all",       // drop comments/meta/favicons from snapshots
      inlineStylesheet: true,
      checkoutEveryNms: 5 * 60 * 1000, // periodic full snapshot → partial uploads replay
      maskAllInputs: false,        // we WANT the search filter values entered
      maskInputOptions: { password: true },
      blockClass: "rr-block",      // escape hatch: exclude any element
    });

    note("recording (session " + sessionId + ") → first flush within " + (FLUSH_MS / 1000) + "s, on nav, or at 50 events");
    setInterval(flush, FLUSH_MS);
    // Flush whatever is buffered before the tab is backgrounded / closed.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
