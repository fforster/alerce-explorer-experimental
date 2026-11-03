/* Unit tests for src/static/js/aladin.js — the pure pickInitialSurvey()
 * position→survey decision that chooses which HiPS imagery the panel boots on
 * before the (network-bound) coverage probe resolves. The Aladin Lite viewer
 * itself needs a WebGL2 context, so its boot/setImageSurvey path is out of
 * scope here (covered by the e2e suite / manual QA).
 *
 * Rule under test:
 *   1. Dec > -30°                 → PanSTARRS DR1
 *   2. else |galactic b| <= 18°   → SkyMapper DR4
 *   3. else                       → DESI DR10
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

beforeAll(() => {
  // dust.js provides window.dust.galacticLatitude, which aladin.js reuses.
  loadScript("src/static/js/dust.js");
  loadScript("src/static/js/aladin.js");
});

const pick = (ra, dec) => window.__aladinPickInitialSurvey(ra, dec).label;
const b = (ra, dec) => window.dust.galacticLatitude(ra, dec);

describe("aladin.pickInitialSurvey", () => {
  test("Dec > -30 → PanSTARRS regardless of galactic latitude", () => {
    expect(pick(180, 20)).toBe("PanSTARRS DR1");   // northern, high |b|
    expect(pick(150, 0)).toBe("PanSTARRS DR1");    // equator
    expect(pick(150, -29.9)).toBe("PanSTARRS DR1"); // just above the cut
    // Galactic-centre direction but Dec > -30: rule 1 still wins.
    expect(b(266.405, -28.936)).toBeCloseTo(0, 1);
    expect(pick(266.405, -28.936)).toBe("PanSTARRS DR1");
  });

  test("Dec <= -30 and near the Galactic plane (|b| <= 18) → SkyMapper", () => {
    // ra 270, dec -30.5 sits at b ≈ -3.5°.
    expect(Math.abs(b(270, -30.5))).toBeLessThanOrEqual(18);
    expect(pick(270, -30.5)).toBe("SkyMapper DR4");
  });

  test("Dec <= -30 and off the Galactic plane (|b| > 18) → DESI", () => {
    // ra 30, dec -60 sits at b ≈ -55°.
    expect(Math.abs(b(30, -60))).toBeGreaterThan(18);
    expect(pick(30, -60)).toBe("DESI DR10");
  });

  test("boundary: exactly -30 dec is not > -30, so falls to the b test", () => {
    // At dec = -30 the first branch (dec > -30) is false. Whether SkyMapper or
    // DESI depends only on |b| at that point — assert it matches the b split.
    const expected = Math.abs(b(45, -30)) <= 18 ? "SkyMapper DR4" : "DESI DR10";
    expect(pick(45, -30)).toBe(expected);
  });
});

/* decideBestHiPS(results, initial): the pure coverage-probe decision.
 *
 * `results` is aligned with the survey priority list [PanSTARRS, DESI,
 * SkyMapper]; each entry is a tristate — true (has data), false (definitively
 * empty), null (probe inconclusive: timeout / network / server error).
 * Regression target: an inconclusive probe must NOT downgrade the provisional
 * survey to DSS (the reported PanSTARRS→DSS flicker).
 */
describe("aladin.decideBestHiPS", () => {
  // Resolved inside tests: beforeAll loads the scripts, but the describe body
  // runs at collection time (before that).
  const PAN = () => window.__aladinPickInitialSurvey(180, 20);   // PanSTARRS DR1
  const DESI = () => window.__aladinPickInitialSurvey(30, -60);  // DESI DR10
  const decide = (results, initial) =>
    window.__aladinDecideBestHiPS(results, initial).label;

  test("priority-first among definitively-covered surveys", () => {
    expect(decide([true, true, true], PAN())).toBe("PanSTARRS DR1");
    expect(decide([false, true, true], PAN())).toBe("DESI DR10");
    expect(decide([false, false, true], PAN())).toBe("SkyMapper DR4");
  });

  test("all probes inconclusive → KEEP the provisional (never DSS)", () => {
    expect(decide([null, null, null], PAN())).toBe("PanSTARRS DR1");
    expect(decide([null, null, null], DESI())).toBe("DESI DR10");
  });

  test("provisional's own probe failing (others empty) still keeps it", () => {
    // PanSTARRS probe timed out (null); DESI + SkyMapper came back empty.
    // Downgrading here would be wrong — we haven't confirmed PanSTARRS is empty.
    expect(decide([null, false, false], PAN())).toBe("PanSTARRS DR1");
  });

  test("DSS only when the provisional is DEFINITIVELY empty and nothing covers", () => {
    expect(decide([false, false, false], PAN())).toBe("DSS Color");
    // Provisional definitively empty, others inconclusive → still DSS (we know
    // the provisional is wrong and have no confirmed alternative).
    expect(decide([false, null, null], PAN())).toBe("DSS Color");
  });

  test("a definitively-covered survey wins even if the provisional is empty", () => {
    expect(decide([false, true, null], PAN())).toBe("DESI DR10");
  });
});

/* CDS mirror failover (November 2026 Strasbourg outage).
 *
 * Every CDS host stopped answering at the TCP level, which left the sky view
 * blank: the Aladin Lite library is served from CDS, and the DSS fallback was a
 * CDS base URL too, so the "fallback" died with the primary. These tests pin
 * the two failover chains.
 */
describe("aladin CDS failover", () => {
  const realFetch = global.fetch;
  // Assert on the HOST, not the label: the CDS entry deliberately keeps its
  // historical "DSS Color" label so the normal path looks unchanged to users.
  const cds = (s) => /unistra|u-strasbg/.test(new URL(s.id).host);

  afterEach(() => {
    global.fetch = realFetch;
    window.__aladinResetFallback();
  });

  test("the HiPS fallback chain reaches beyond CDS", () => {
    // The point of the fix: at least one candidate must be on a host that a
    // CDS outage cannot take down. Short `CDS/P/...` registry ids can't serve
    // here — they resolve through the CDS MOCServer — so every candidate has
    // to be a full base URL.
    const chain = window.__aladinHipsFallbacks();
    expect(chain.length).toBeGreaterThan(1);
    expect(chain.every((s) => /^https?:\/\//.test(s.id))).toBe(true);
    const hosts = chain.map((s) => new URL(s.id).host);
    expect(hosts.some((h) => !/unistra|u-strasbg/.test(h))).toBe(true);
  });

  test("reachableFallback keeps the CDS primary when it answers", async () => {
    global.fetch = async () => ({ ok: true });
    const chosen = await window.__aladinReachableFallback();
    expect(cds(chosen)).toBe(true);
  });

  test("reachableFallback skips a dead CDS and picks the next provider", async () => {
    const tried = [];
    global.fetch = async (url) => {
      tried.push(url);
      // Simulate the outage: the CDS host refuses the connection outright.
      if (/unistra|u-strasbg/.test(url)) throw new Error("ECONNREFUSED");
      return { ok: true };
    };
    const chosen = await window.__aladinReachableFallback();
    expect(cds(chosen)).toBe(false);
    expect(tried[0]).toMatch(/unistra|u-strasbg/);   // primary still tried first
    expect(tried.length).toBeGreaterThan(1);
  });

  test("reachableFallback treats a non-ok status as unreachable", async () => {
    global.fetch = async (url) =>
      (/unistra|u-strasbg/.test(url) ? { ok: false, status: 502 } : { ok: true });
    const chosen = await window.__aladinReachableFallback();
    expect(cds(chosen)).toBe(false);
  });

  test("the probe bypasses the HTTP cache", async () => {
    // Regression lock for a production failure: Chrome answered the CDS
    // `properties` probe from its disk cache in 6 ms while the host was
    // serving nothing, so the page believed CDS was up and the sky view
    // stayed blank. A reachability check read from cache is not a check.
    let opts;
    global.fetch = async (_url, o) => { opts = o; return { ok: true }; };
    await window.__aladinReachableFallback();
    expect(opts.cache).toBe("no-store");
  });

  test("probes the base URL's own properties file, not CDS hips2fits", async () => {
    // hips2fits is a CDS service with no mirror — probing through it would
    // report every provider dead during exactly the outage this is for.
    const tried = [];
    global.fetch = async (url) => { tried.push(url); return { ok: true }; };
    await window.__aladinReachableFallback();
    expect(tried[0]).toMatch(/\/properties$/);
    expect(tried.join(" ")).not.toMatch(/hips2fits/);
  });

  test("the result is cached, so one page view probes once", async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; return { ok: true }; };
    await window.__aladinReachableFallback();
    await window.__aladinReachableFallback();
    expect(calls).toBe(1);
  });

  test("concurrent callers share a single probe", async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; return { ok: true }; };
    const all = await Promise.all([
      window.__aladinReachableFallback(),
      window.__aladinReachableFallback(),
      window.__aladinReachableFallback(),
    ]);
    expect(calls).toBe(1);
    expect(new Set(all).size).toBe(1);
  });

  test("with every provider down it still yields a survey object", async () => {
    // Better to hand Aladin a base layer and let it surface its own load
    // error than to return null and crash the boot path.
    global.fetch = async () => { throw new Error("all down"); };
    const chosen = await window.__aladinReachableFallback();
    expect(chosen).toBeTruthy();
    expect(typeof chosen.id).toBe("string");
  });

  test("decideBestHiPS returns the resolved fallback, not the dead primary", async () => {
    global.fetch = async (url) =>
      (/unistra|u-strasbg/.test(url) ? { ok: false, status: 502 } : { ok: true });
    const live = await window.__aladinReachableFallback();
    // No survey definitively covered and no provisional → fall back.
    const chosen = window.__aladinDecideBestHiPS([null, null, null], null);
    expect(chosen).toBe(live);
    expect(cds(chosen)).toBe(false);
  });

  test("the Aladin library source list reaches beyond CDS", () => {
    const sources = window.__aladinSources();
    const hosts = sources.map((u) => new URL(u).host);
    expect(hosts.slice(0, 2).every((h) => /unistra|u-strasbg/.test(h))).toBe(true);
    expect(hosts.some((h) => !/unistra|u-strasbg/.test(h))).toBe(true);
  });

  test("every non-CDS library source pins an exact version", () => {
    // A CDN URL must never float: `latest` from CDS is unpinnable, a CDN is not.
    for (const url of window.__aladinSources()) {
      if (/unistra|u-strasbg/.test(new URL(url).host)) continue;
      expect(url).toMatch(/@\d+\.\d+\.\d+\//);
    }
  });
});

/* Loading the library when CDS is down.
 *
 * Three distinct failures, each found the hard way in a browser against the
 * live outage, and each needing its own detection:
 *
 *   1. The CDS host accepted nothing and sent nothing, so the <script> tag
 *      sat PENDING. `onerror` never fires for that, so the fallback chain
 *      never advanced and the sky view said "loading…" forever.
 *   2. The npm build is an ES MODULE. In a <script> tag it 200s, fires
 *      `onload`, and defines no `window.A` — a silent success that yields a
 *      useless page.
 *   3. Even with the library loaded, the provisional survey is a CDS registry
 *      id, which can't resolve while CDS is down.
 */
describe("aladin library loading", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    window.__aladinSetLoadTimeout(8000);
    window.__aladinResetFallback();
    delete window.A;
  });

  test("a hanging source is abandoned on a timeout, not waited on forever", async () => {
    window.__aladinSetLoadTimeout(30);
    // jsdom never fires load/error for a remote src, which is exactly the
    // pending-forever behaviour the real CDS host showed.
    const sources = [
      { url: "https://dead.example/aladin.js", kind: "script" },
      { url: "https://alive.example/aladin.js", kind: "script" },
    ];
    const t0 = Date.now();
    await expect(window.__aladinLoadFrom(sources)).rejects.toThrow(/unreachable/);
    // Both were attempted and each was bounded by the timeout, rather than
    // the first one blocking indefinitely.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(document.querySelectorAll('script[src*="dead.example"]').length).toBe(1);
    expect(document.querySelectorAll('script[src*="alive.example"]').length).toBe(1);
  });

  test("a source that loads but defines no global is treated as a failure", async () => {
    window.__aladinSetLoadTimeout(30);
    // kind:"module" lets us resolve without jsdom script plumbing; the import
    // fails in jsdom, so this exercises the same reject-and-advance path.
    const sources = [{ url: "https://nope.example/a.js", kind: "module" }];
    await expect(window.__aladinLoadFrom(sources)).rejects.toThrow(/unreachable/);
    expect(typeof window.A).toBe("undefined");
  });

  test("the CDN entries are declared as ES modules, the CDS ones as scripts", () => {
    // The whole point of the `kind` field: the two builds are NOT
    // interchangeable, and loading the npm one as a classic script silently
    // produces nothing.
    const specs = window.__aladinSourceSpecs();
    for (const s of specs) {
      const cdsHost = /unistra|u-strasbg/.test(new URL(s.url).host);
      expect(s.kind).toBe(cdsHost ? "script" : "module");
    }
    expect(specs.some((s) => s.kind === "module")).toBe(true);
  });

  test("every source declares a kind the loader understands", () => {
    for (const s of window.__aladinSourceSpecs()) {
      expect(["script", "module"]).toContain(s.kind);
    }
  });
});

describe("aladin survey choice when CDS is unreachable", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; window.__aladinResetFallback(); });

  const PAN = () => ({ id: "CDS/P/PanSTARRS/DR1/color-i-r-g", label: "PanSTARRS DR1" });

  test("isCdsSurvey catches both registry ids and CDS base URLs", () => {
    expect(window.__aladinIsCdsSurvey(PAN())).toBe(true);
    expect(window.__aladinIsCdsSurvey({ id: "https://alaskybis.cds.unistra.fr/DSS/DSSColor" }))
      .toBe(true);
    expect(window.__aladinIsCdsSurvey({ id: "https://skies.esac.esa.int/DSSColor" }))
      .toBe(false);
    expect(window.__aladinIsCdsSurvey(null)).toBe(false);
  });

  test("the fallback probe records whether CDS answered", async () => {
    global.fetch = async (url) =>
      (/unistra|u-strasbg/.test(url) ? { ok: false, status: 502 } : { ok: true });
    await window.__aladinReachableFallback();
    expect(window.__aladinCdsHipsReachable()).toBe(false);

    window.__aladinResetFallback();
    expect(window.__aladinCdsHipsReachable()).toBeNull();

    global.fetch = async () => ({ ok: true });
    await window.__aladinReachableFallback();
    expect(window.__aladinCdsHipsReachable()).toBe(true);
  });

  test("an inconclusive probe no longer pins the view to a dead CDS survey", async () => {
    // The regression this fixes: hips2fits is itself CDS, so during the
    // outage EVERY coverage probe returns null (inconclusive). The old
    // "never downgrade on inconclusive" rule then kept the CDS provisional,
    // which cannot load a single tile — a permanently blank sky view.
    global.fetch = async (url) => {
      if (/unistra|u-strasbg/.test(url)) throw new Error("ECONNREFUSED");
      return { ok: true };
    };
    await window.__aladinReachableFallback();

    const chosen = window.__aladinDecideBestHiPS([null, null, null], PAN());
    expect(window.__aladinIsCdsSurvey(chosen)).toBe(false);
  });

  test("an inconclusive probe still keeps the provisional while CDS is up", async () => {
    // The original behaviour must survive: a transient hips2fits hiccup is
    // not a reason to downgrade a good PanSTARRS view to DSS.
    global.fetch = async () => ({ ok: true });
    await window.__aladinReachableFallback();

    const initial = PAN();
    expect(window.__aladinDecideBestHiPS([null, null, null], initial)).toBe(initial);
  });

  test("a definitively covered survey still wins, outage or not", async () => {
    global.fetch = async (url) => {
      if (/unistra|u-strasbg/.test(url)) throw new Error("ECONNREFUSED");
      return { ok: true };
    };
    await window.__aladinReachableFallback();
    const chosen = window.__aladinDecideBestHiPS([true, null, null], PAN());
    expect(chosen.label).toBe("PanSTARRS DR1");
  });
});
