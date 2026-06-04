/* Unit tests for the pure multi-harmonic least-squares core of
 * src/static/js/periodogram.js, reached via the window.__pgTest hook.
 *
 * The headline test injects a sinusoid of known period into irregularly
 * sampled data and confirms the periodogram recovers it — the property that
 * actually matters scientifically, and the one with no coverage until now.
 *
 * Note on aliasing: a multi-harmonic fit (NH harmonics) places strong power
 * at both P and 2P for a *pure* sinusoid (at trial period 2P the signal lands
 * entirely in the 2nd harmonic). That is correct behaviour, so the recovery
 * tests search a period range that excludes the 2P alias.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let PG;

// Deterministic LCG so the synthetic light curve is identical every run
// (Math.random is unavailable in workflow scripts and undesirable in tests).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Build one band of irregularly-sampled sinusoidal data, centered + weighted
// exactly as periodogram.js's compute() prepares it before the GLS loop.
function makeBand(period, { n = 60, baseline = 100, amp = 400, noise = 30, seed = 777 } = {}) {
  const rnd = lcg(seed);
  const t = [], val = [], err = [];
  for (let i = 0; i < n; i++) {
    const ti = baseline * rnd();
    t.push(ti);
    val.push(1000 + amp * Math.sin((2 * Math.PI * ti) / period) + noise * (rnd() - 0.5));
    err.push(20);
  }
  const tMin = Math.min(...t);
  let wSum = 0, wvSum = 0;
  for (let i = 0; i < val.length; i++) { const w = 1 / (err[i] * err[i]); wSum += w; wvSum += w * val[i]; }
  const mean = wvSum / wSum;
  return {
    band: {
      dt: Float64Array.from(t.map((x) => x - tMin)),
      w: Float64Array.from(err.map((e) => 1 / (e * e))),
      resid: Float64Array.from(val.map((v) => v - mean)),
    },
    T: Math.max(...t) - tMin,
  };
}

// Scan a period range and return the top peaks, mirroring compute()'s grid.
function topPeaks(band, T, minP, maxP, { NH = 4, oversample = 5 } = {}) {
  const df = 1 / (oversample * T);
  const minFreq = 1 / maxP, maxFreq = 1 / minP;
  const nFreq = Math.ceil((maxFreq - minFreq) / df);
  const scratch = PG.makeMhScratch(NH);
  const freqs = new Float64Array(nFreq), power = new Float64Array(nFreq);
  for (let fi = 0; fi < nFreq; fi++) {
    const f = minFreq + fi * df;
    freqs[fi] = f;
    power[fi] = PG.mhPowerAtFreq([band], 2 * Math.PI * f, NH, scratch);
  }
  return PG.findTopPeaks(Array.from(freqs), Array.from(power), 5, df);
}

beforeAll(() => {
  loadScript("src/static/js/periodogram.js");
  PG = window.__pgTest;
});

describe("multi-harmonic periodogram — period recovery", () => {
  test("recovers an injected P = 3.7 d (range excludes 2P alias)", () => {
    const { band, T } = makeBand(3.7);
    const peaks = topPeaks(band, T, 0.5, 6);
    expect(peaks[0].x).toBeCloseTo(3.7, 2);
  });

  test("recovers a different injected P = 2.15 d (not hard-coded)", () => {
    const { band, T } = makeBand(2.15, { seed: 4242 });
    const peaks = topPeaks(band, T, 0.5, 4);
    expect(peaks[0].x).toBeCloseTo(2.15, 2);
  });

  test("the 2P alias is itself a top peak over a wider range", () => {
    const { band, T } = makeBand(3.7);
    const peaks = topPeaks(band, T, 0.5, 20);
    const periods = peaks.map((p) => p.x);
    // Both the fundamental and its 2P alias should surface among the peaks.
    expect(periods.some((p) => Math.abs(p - 3.7) < 0.1)).toBe(true);
    expect(periods.some((p) => Math.abs(p - 7.4) < 0.2)).toBe(true);
  });
});

describe("mhPowerAtFreq — degenerate inputs", () => {
  test("flat residuals give ~zero power (nothing to fit)", () => {
    const N = 30;
    const band = {
      dt: Float64Array.from({ length: N }, (_, i) => i),
      w: Float64Array.from({ length: N }, () => 1),
      resid: new Float64Array(N), // all zero
    };
    const scratch = PG.makeMhScratch(4);
    const p = PG.mhPowerAtFreq([band], 2 * Math.PI * 0.1, 4, scratch);
    expect(p).toBeCloseTo(0, 9);
  });

  test("too-few points (rank-deficient normal matrix) → 0, no throw", () => {
    // 2 points cannot constrain a 9-parameter (NH=4) fit; the Cholesky guard
    // rejects the non-positive-definite matrix and contributes 0 power.
    const band = {
      dt: Float64Array.from([0, 1]),
      w: Float64Array.from([1, 1]),
      resid: Float64Array.from([5, -5]),
    };
    const scratch = PG.makeMhScratch(4);
    expect(() => PG.mhPowerAtFreq([band], 2 * Math.PI * 0.3, 4, scratch)).not.toThrow();
    expect(PG.mhPowerAtFreq([band], 2 * Math.PI * 0.3, 4, scratch)).toBe(0);
  });
});

describe("findTopPeaks", () => {
  test("returns peaks sorted by power, as {x: period, y: power}", () => {
    // Frequencies 0.1..0.5; strongest at 0.25 (period 4), next at 0.5 (2).
    const freqs = [0.1, 0.2, 0.25, 0.3, 0.5];
    const power = [1, 2, 9, 2, 5];
    const peaks = PG.findTopPeaks(freqs, power, 3, null);
    expect(peaks[0].x).toBeCloseTo(1 / 0.25, 6); // period 4 d, the strongest
    expect(peaks[0].y).toBe(9);
    // Descending power.
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i].y).toBeLessThanOrEqual(peaks[i - 1].y);
    }
  });
});
