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
import { beforeAll, describe, expect, test } from "vitest";
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
