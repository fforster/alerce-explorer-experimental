/* Unit tests for src/static/js/cosmology.js (Planck-2018 distance modulus).
 *
 * Reference values were generated from the implementation itself and pinned
 * here so an accidental change to H0/Omega_m or the integrator is caught.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

beforeAll(() => {
  loadScript("src/static/js/cosmology.js");
});

describe("cosmology.distanceModulus", () => {
  // μ(z) for the Planck-2018 flat ΛCDM params baked into cosmology.js.
  // 3-dp tolerance: well inside the integrator's own precision, but tight
  // enough to flag a cosmology-parameter regression.
  test.each([
    [0.01, 33.2573],
    [0.1, 38.395],
    [0.5, 42.3322],
    [1.0, 44.1634],
  ])("μ(z=%f) ≈ %f", (z, mu) => {
    expect(window.cosmology.distanceModulus(z)).toBeCloseTo(mu, 3);
  });

  test("returns NaN for non-physical redshift", () => {
    expect(window.cosmology.distanceModulus(0)).toBeNaN();
    expect(window.cosmology.distanceModulus(-1)).toBeNaN();
    expect(window.cosmology.distanceModulus(NaN)).toBeNaN();
  });

  test("is monotonically increasing in z", () => {
    let prev = -Infinity;
    for (const z of [0.05, 0.1, 0.2, 0.5, 1, 2, 3]) {
      const mu = window.cosmology.distanceModulus(z);
      expect(mu).toBeGreaterThan(prev);
      prev = mu;
    }
  });
});

describe("cosmology.luminosityDistance", () => {
  test("d_L = (1+z) · d_C", () => {
    const z = 0.3;
    const dc = window.cosmology.comovingDistance(z);
    expect(window.cosmology.luminosityDistance(z)).toBeCloseTo((1 + z) * dc, 6);
  });

  test("NaN for z ≤ 0", () => {
    expect(window.cosmology.comovingDistance(0)).toBeNaN();
    expect(window.cosmology.luminosityDistance(-0.5)).toBeNaN();
  });
});
