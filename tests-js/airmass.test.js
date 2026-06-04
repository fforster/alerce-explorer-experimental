/* Unit tests for the pure astronomy kit in src/static/js/airmass.js, reached
 * via window.__amTest. These are checked against textbook physics (zenith
 * airmass = 1, sec z at 30° altitude ≈ 2, transit altitude = 90°, solstice
 * solar declination ≈ the obliquity) rather than pinned magic numbers, so a
 * regression in the formulae is caught as a physics error.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let A;
beforeAll(() => {
  loadScript("src/static/js/airmass.js");
  A = window.__amTest;
});

describe("_jd — Julian date", () => {
  test("J2000.0 epoch (2000-01-01 12:00 UTC) = JD 2451545.0", () => {
    expect(A._jd(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)))).toBeCloseTo(2451545.0, 6);
  });
});

describe("_altitude", () => {
  test("an object transits at the zenith when Dec = latitude and HA = 0", () => {
    // lst = ra → HA = 0; dec = lat = −30 → altitude 90°.
    expect(A._altitude(0, -30, -30, 0)).toBeCloseTo(90, 4);
  });

  test("clamps to [-90, 90]", () => {
    for (const alt of [A._altitude(0, 80, -80, 180), A._altitude(123, 45, -20, 77)]) {
      expect(alt).toBeGreaterThanOrEqual(-90);
      expect(alt).toBeLessThanOrEqual(90);
    }
  });
});

describe("_airmass — Pickering (2002)", () => {
  test("≈ 1 at the zenith", () => {
    expect(A._airmass(90)).toBeCloseTo(1.0, 4);
  });
  test("≈ sec(60°) = 2 at 30° altitude (Pickering deviates slightly)", () => {
    // Plane-parallel sec(z) = 2 exactly; Pickering gives 1.993, intentionally
    // a touch lower — so check to 1 dp, not 2.
    expect(A._airmass(30)).toBeCloseTo(2.0, 1);
  });
  test("null below the horizon and beyond 15 airmasses", () => {
    expect(A._airmass(0)).toBeNull();
    expect(A._airmass(-5)).toBeNull();
    expect(A._airmass(2)).toBeNull(); // very low → > 15 airmasses
  });
});

describe("_angSep — great-circle separation", () => {
  test("0 for identical points", () => {
    expect(A._angSep(10, 20, 10, 20)).toBeCloseTo(0, 6);
  });
  test("90° along the equator", () => {
    expect(A._angSep(0, 0, 90, 0)).toBeCloseTo(90, 4);
  });
  test("180° for antipodal points", () => {
    expect(A._angSep(0, 0, 180, 0)).toBeCloseTo(180, 4);
  });
});

describe("_sunRaDec — low-precision solar ephemeris", () => {
  test("declination ≈ +23.4° at the June solstice", () => {
    const jd = A._jd(new Date(Date.UTC(2024, 5, 20, 0, 0, 0)));
    expect(A._sunRaDec(jd).dec).toBeCloseTo(23.4, 1);
  });
  test("declination ≈ −23.4° at the December solstice", () => {
    const jd = A._jd(new Date(Date.UTC(2024, 11, 21, 12, 0, 0)));
    expect(A._sunRaDec(jd).dec).toBeLessThan(-23.0);
  });
  test("RA wrapped into [0, 360)", () => {
    const jd = A._jd(new Date(Date.UTC(2024, 2, 1, 0, 0, 0)));
    const ra = A._sunRaDec(jd).ra;
    expect(ra).toBeGreaterThanOrEqual(0);
    expect(ra).toBeLessThan(360);
  });
});

describe("_moonRaDec / _moonPhase", () => {
  // Note: compute jd inside each test — describe-body runs at collection time,
  // before beforeAll has loaded the script, so A is not yet defined there.
  const jd = () => A._jd(new Date(Date.UTC(2024, 5, 20, 0, 0, 0)));
  test("Moon position is on the sky (valid RA/Dec)", () => {
    const m = A._moonRaDec(jd());
    expect(m.ra).toBeGreaterThanOrEqual(0);
    expect(m.ra).toBeLessThan(360);
    expect(Math.abs(m.dec)).toBeLessThanOrEqual(90);
  });
  test("illuminated fraction is in [0, 1]", () => {
    const p = A._moonPhase(jd());
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe("_lst / _twilightColor / OBSERVATORIES", () => {
  test("local sidereal time wraps into [0, 360)", () => {
    const lst = A._lst(A._jd(new Date(Date.UTC(2024, 5, 20, 3, 0, 0))), -70.74);
    expect(lst).toBeGreaterThanOrEqual(0);
    expect(lst).toBeLessThan(360);
  });
  test("twilight shading: daylight tinted, true night null", () => {
    expect(A._twilightColor(5)).toMatch(/^rgba/);
    expect(A._twilightColor(-20)).toBeNull();
  });
  test("Rubin/LSST is the preset at index 1", () => {
    expect(A.OBSERVATORIES[1].name).toMatch(/Rubin|LSST/);
    expect(A.OBSERVATORIES[1].lat).toBeCloseTo(-30.2447, 4);
  });
});
