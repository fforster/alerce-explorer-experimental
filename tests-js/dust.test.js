/* Unit tests for src/static/js/dust.js — only the pure galacticLatitude()
 * transform. fetchEBV() does network I/O against the dust proxy and belongs
 * in an integration test, so it is not covered here.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

beforeAll(() => {
  loadScript("src/static/js/dust.js");
});

describe("dust.galacticLatitude", () => {
  test("North Galactic Pole → b = +90°", () => {
    // The NGP J2000 position the module itself encodes.
    expect(window.dust.galacticLatitude(192.85948, 27.12825)).toBeCloseTo(90, 4);
  });

  test("Galactic centre → b ≈ 0°", () => {
    expect(window.dust.galacticLatitude(266.405, -28.936)).toBeCloseTo(0, 2);
  });

  test("returns a value within [-90, 90]", () => {
    for (const [ra, dec] of [[0, 0], [123, 45], [359, -89], [180, 80]]) {
      const b = window.dust.galacticLatitude(ra, dec);
      expect(b).toBeGreaterThanOrEqual(-90);
      expect(b).toBeLessThanOrEqual(90);
    }
  });
});
