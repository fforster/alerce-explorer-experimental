import { test, expect } from "@playwright/test";

// Memory-leak regression for the detail view: every object you open builds
// Chart.js charts (and an Aladin instance) that must be destroyed when you
// navigate away, or Chart.js's global registry pins each one — and its detached
// canvas / DOM subtree — forever. detail-cleanup.js tears them down on the
// htmx:beforeSwap that precedes every #results-slot swap.
//
// We verify with a WeakRef survivor count under a CDP-forced GC (mirrors the
// approach used to validate the same fix in the hunter project). Chart.js
// renders on a 2d canvas, which works headless; the analogous Aladin teardown
// needs WebGL (unavailable headless) and is covered by inspection + the
// `torndown` guard in aladin.js, not here.
//
// The test drives the REAL detail-cleanup.js loaded by the app shell: it swaps
// synthetic detail fragments (each with a uniquely-IDed canvas + a live Chart)
// into the actual #results-slot, exactly as object navigation does.

async function forceGC(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  // A couple of passes with a tick between them makes collection deterministic.
  for (let i = 0; i < 3; i++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
  }
  await cdp.detach();
}

// Open N synthetic detail views into #results-slot and return how many of their
// charts survive a GC. `fireBeforeSwap` decides whether the htmx:beforeSwap
// teardown net runs before each swap (true = the real navigation path; false =
// the pre-fix behaviour, used as a sensitivity baseline).
function runScenario(page, n, fireBeforeSwap) {
  return page.evaluate(
    async ({ n, fireBeforeSwap }) => {
      const slot = document.getElementById("results-slot");
      if (!slot) throw new Error("#results-slot not found");
      if (!window.Chart) throw new Error("Chart.js not loaded");
      const refs = [];

      for (let i = 0; i < n; i++) {
        // Simulate what htmx does right before replacing the slot's content.
        if (fireBeforeSwap) {
          document.body.dispatchEvent(
            new CustomEvent("htmx:beforeSwap", {
              bubbles: true,
              detail: { target: slot },
            }),
          );
        }
        // Fresh detail fragment with a uniquely-IDed canvas — like lc-canvas-{oid}.
        slot.innerHTML =
          `<div id="object-detail"><canvas id="lc-canvas-obj${i}" width="200" height="120"></canvas></div>`;
        const cv = document.getElementById(`lc-canvas-obj${i}`);
        const chart = new window.Chart(cv.getContext("2d"), {
          type: "scatter",
          data: { datasets: [{ data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] },
          options: { animation: false, responsive: false },
        });
        // Track only weak references, so nothing here keeps them alive.
        refs.push(new WeakRef(chart));
        refs.push(new WeakRef(cv));
      }

      // Tear down the last one too (as a final navigation / Back would).
      if (fireBeforeSwap) {
        document.body.dispatchEvent(
          new CustomEvent("htmx:beforeSwap", {
            bubbles: true,
            detail: { target: slot },
          }),
        );
      }
      slot.innerHTML = "";

      window.__leakRefs = refs; // hand off for post-GC counting
      return refs.length;
    },
    { n, fireBeforeSwap },
  );
}

function countSurvivors(page) {
  return page.evaluate(
    () => (window.__leakRefs || []).filter((r) => r.deref() !== undefined).length,
  );
}

test.describe("detail-view teardown prevents Chart.js leaks", () => {
  test("charts are collected after navigation when teardown runs", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!window.Chart && !!document.getElementById("results-slot"));

    // Sensitivity baseline: WITHOUT the teardown net, Chart.js's registry pins
    // every chart, so all of them survive GC. If this ever comes back near 0,
    // the test has stopped being able to observe the leak.
    const total = await runScenario(page, 12, /* fireBeforeSwap */ false);
    await forceGC(page);
    const leakedSurvivors = await countSurvivors(page);
    expect(leakedSurvivors).toBeGreaterThanOrEqual(total); // ~all 24 refs retained

    // With the teardown net firing on each swap, charts (and their canvases)
    // become collectable. A few may still be pending finalisation; assert it's
    // a small bounded number, not proportional to how many we opened.
    await runScenario(page, 12, /* fireBeforeSwap */ true);
    await forceGC(page);
    const fixedSurvivors12 = await countSurvivors(page);
    expect(fixedSurvivors12).toBeLessThanOrEqual(4);

    // Bounded, not growing: 3× the opens must not meaningfully raise survivors.
    await runScenario(page, 36, /* fireBeforeSwap */ true);
    await forceGC(page);
    const fixedSurvivors36 = await countSurvivors(page);
    expect(fixedSurvivors36).toBeLessThanOrEqual(4);
  });
});
