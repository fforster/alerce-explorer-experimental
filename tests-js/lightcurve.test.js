/* Unit tests for the pure projection helpers in src/static/js/lightcurve.js.
 *
 * projectPoint is the single function every light-curve toggle funnels
 * through (Flux/Mag x Diff/Sci x App/Abs x Obs/Der x per-band offset), so it
 * is the highest-value client-side logic to pin down. The helpers are reached
 * via the window.__lcTest hook the script exposes for tests; loading the full
 * module under jsdom is fine because Chart.js is only referenced inside
 * functions, never at load time.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let T;
// A representative detection: 1000 nJy diff flux, brighter 1200 nJy science
// flux, with symmetric flux errors.
const P = {
  flux: 1000, e_flux: 50,
  sci_flux: 1200, e_sci_flux: 60,
  mjd: 59000, identifier: "cand-1", has_stamp: true,
};

beforeAll(() => {
  loadScript("src/static/js/lightcurve.js");
  T = window.__lcTest;
});

describe("projectPoint — Flux/Mag axis", () => {
  test("flux mode passes nJy through with symmetric error bars", () => {
    const r = T.projectPoint(P, "flux", "diff", null, 0, 0);
    expect(r.y).toBeCloseTo(1000, 6);
    expect(r.yLo).toBeCloseTo(950, 6);
    expect(r.yHi).toBeCloseTo(1050, 6);
    // Identity metadata rides along for cross-panel selection.
    expect(r.identifier).toBe("cand-1");
    expect(r.has_stamp).toBe(true);
    expect(r.mjd).toBe(59000);
  });

  test("mag mode uses AB ZP 31.4 (1000 nJy → 23.9 mag)", () => {
    const r = T.projectPoint(P, "mag", "diff", null, 0, 0);
    expect(r.y).toBeCloseTo(23.9, 6);
  });

  test("mag error bars are asymmetric (faint side larger)", () => {
    const r = T.projectPoint(P, "mag", "diff", null, 0, 0);
    expect(r.yLo).toBeCloseTo(23.847027, 5); // bright side (flux+e)
    expect(r.yHi).toBeCloseTo(23.955691, 5); // faint side (flux−e)
    expect(r.yHi - r.y).toBeGreaterThan(r.y - r.yLo);
  });

  test("faint side goes to +Infinity when flux − e ≤ 0", () => {
    const r = T.projectPoint({ flux: 50, e_flux: 80, mjd: 1 }, "mag", "diff", null, 0, 0);
    expect(r.yHi).toBe(Infinity);
    expect(Number.isFinite(r.yLo)).toBe(true);
  });
});

describe("projectPoint — Diff/Sci source", () => {
  test("sci mode reads sci_flux (1200 nJy → 23.702 mag)", () => {
    const r = T.projectPoint(P, "mag", "sci", null, 0, 0);
    expect(r.y).toBeCloseTo(23.702047, 5);
  });
});

describe("projectPoint — extinction (Obs/Der)", () => {
  test("mag: extinction is an additive shift (m − A)", () => {
    const r = T.projectPoint(P, "mag", "diff", null, 0.5, 0);
    expect(r.y).toBeCloseTo(23.4, 6); // 23.9 − 0.5
  });

  test("flux: extinction is multiplicative 10^(0.4·A), errors scale too", () => {
    const r = T.projectPoint(P, "flux", "diff", null, 0.5, 0);
    expect(r.y).toBeCloseTo(1584.8932, 3); // 1000 · 10^0.2
    expect(r.e).toBeCloseTo(79.2447, 3); // SNR preserved
  });
});

describe("projectPoint — distance modulus (App/Abs)", () => {
  test("mag: μ is subtracted (M = m − μ)", () => {
    const r = T.projectPoint(P, "mag", "diff", 35, 0, 0);
    expect(r.y).toBeCloseTo(-11.1, 6); // 23.9 − 35
  });
});

describe("projectPoint — per-band offset", () => {
  test("mag: offset is added (m + Δ)", () => {
    const r = T.projectPoint(P, "mag", "diff", null, 0, 1);
    expect(r.y).toBeCloseTo(24.9, 6);
  });
});

describe("projectPoint — null guards", () => {
  test("non-positive flux in mag mode → null (log undefined)", () => {
    expect(T.projectPoint({ flux: -5, mjd: 1 }, "mag", "diff", null, 0, 0)).toBeNull();
  });
  test("missing flux → null", () => {
    expect(T.projectPoint({ flux: null, mjd: 1 }, "flux", "diff", null, 0, 0)).toBeNull();
  });
});

describe("mjdToUtcString — per-survey time scale", () => {
  test("ZTF MJD is treated as UTC", () => {
    expect(T.mjdToUtcString(59000, "ztf")).toBe("2020-05-31 00:00:00 UTC");
  });
  test("LSST MJD is TAI → 37 s earlier in UTC", () => {
    expect(T.mjdToUtcString(59000, "lsst")).toBe("2020-05-30 23:59:23 UTC");
  });
  test("non-finite MJD → empty string", () => {
    expect(T.mjdToUtcString(Infinity, "ztf")).toBe("");
    expect(T.mjdToUtcString(NaN, "lsst")).toBe("");
  });
});

describe("foldDataset", () => {
  test("emits each point twice, at phase and phase+1", () => {
    const out = T.foldDataset([{ x: 59000, y: 1 }], 10);
    expect(out).toHaveLength(2);
    expect(out[0].x).toBeCloseTo(0, 9);
    expect(out[1].x).toBeCloseTo(1, 9);
    expect(out[0].y).toBe(1);
  });
  test("non-positive period is a no-op", () => {
    const pts = [{ x: 1, y: 2 }];
    expect(T.foldDataset(pts, 0)).toBe(pts);
    expect(T.foldDataset(pts, -5)).toBe(pts);
  });
});

describe("marker / label helpers", () => {
  test("pointStyleFor: LSST=circle, ZTF=rect, unknown→circle", () => {
    expect(T.pointStyleFor("lsst")).toBe("circle");
    expect(T.pointStyleFor("ztf")).toBe("rect");
    expect(T.pointStyleFor("kmtnet")).toBe("circle");
  });
  test("surveyLabel maps known surveys, passes through empty", () => {
    expect(T.surveyLabel("lsst")).toBe("LSST");
    expect(T.surveyLabel("ztf")).toBe("ZTF");
    expect(T.surveyLabel("")).toBe("");
  });
  test("withAlpha appends an alpha byte to #RRGGBB, leaves other colors", () => {
    expect(T.withAlpha("#aabbcc", 0.1)).toBe("#aabbcc1a");
    expect(T.withAlpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
});

describe("projectModel — parametric overlay (magnitude input)", () => {
  test("mag axis: additive A + μ + offset, mirroring projectPoint", () => {
    expect(T.projectModel(20, "mag", null, 0, 0)).toBeCloseTo(20, 9);
    // 20 − A(0.3) − μ(35) + offset(0.1)
    expect(T.projectModel(20, "mag", 35, 0.3, 0.1)).toBeCloseTo(-15.2, 9);
  });

  test("flux axis: mag → nJy via AB ZP 31.4", () => {
    expect(T.projectModel(20, "flux", null, 0, 0)).toBeCloseTo(36307.8055, 3);
  });

  test("non-finite magnitude → null", () => {
    expect(T.projectModel(Infinity, "mag", null, 0, 0)).toBeNull();
    expect(T.projectModel(NaN, "flux", null, 0, 0)).toBeNull();
  });
});

describe("projectFluxModel — parametric overlay (flux input, e.g. GP)", () => {
  test("flux axis passes nJy through", () => {
    expect(T.projectFluxModel(5000, "flux", null, 0, 0)).toBeCloseTo(5000, 9);
  });

  test("mag axis converts via AB ZP 31.4", () => {
    expect(T.projectFluxModel(5000, "mag", null, 0, 0)).toBeCloseTo(22.152575, 5);
  });

  test("non-positive flux is a gap in mag mode but kept in flux mode", () => {
    expect(T.projectFluxModel(-3, "mag", null, 0, 0)).toBeNull();
    expect(T.projectFluxModel(-3, "flux", null, 0, 0)).toBe(-3);
  });
});

describe("spmFlux_mJy — Sánchez-Sáez+2021 model", () => {
  test("rise term vanishes exactly at t0 (only the plateau/fall remains)", () => {
    // At t = t0 the (1 − β^0) rise factor is 0; flux is the fall branch only.
    expect(T.spmFlux_mJy(5, 1.0, 0.5, 5, 20, 3, 15)).toBeCloseTo(0.000318, 5);
  });
  test("produces a finite positive flux past the rise", () => {
    const f = T.spmFlux_mJy(10, 1.0, 0.5, 5, 20, 3, 15);
    expect(Number.isFinite(f)).toBe(true);
    expect(f).toBeGreaterThan(0);
  });
});

describe("fleetMag — polynomial-rise model", () => {
  test("at dt = 0 reduces to m0 (exp(0) − 0 + m0)", () => {
    expect(T.fleetMag(0, 2, 0.1, 18, 0)).toBeCloseTo(19, 9); // 1 + 18
  });
  test("matches closed form away from t0", () => {
    // exp(0.5) − 2·0.1·5 + 18
    expect(T.fleetMag(5, 2, 0.1, 18, 0)).toBeCloseTo(18.648721, 5);
  });
});

describe("mjdEnvelope", () => {
  test("returns the global min/max MJD across bands, ignoring NaN", () => {
    const env = T.mjdEnvelope([
      { points: [{ mjd: 100 }, { mjd: 50 }] },
      { points: [{ mjd: 200 }, { mjd: NaN }] },
    ]);
    expect(env.min).toBe(50);
    expect(env.max).toBe(200);
  });
  test("empty input → null", () => {
    expect(T.mjdEnvelope([])).toBeNull();
  });
});
