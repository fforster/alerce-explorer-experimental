/* Unit tests for src/static/js/coords.js — the free-text RA/Dec parser and
 * the smart date→MJD converter. These are the pure functions exposed on
 * window for the search form's hx-vals expressions.
 *
 * The async name resolver (resolveName) hits CDS Sesame over the network and
 * is left to a Tier-3 / integration test; only the offline parsers are here.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

beforeAll(() => {
  loadScript("src/static/js/coords.js");
});

describe("parseCoordinates", () => {
  // Every accepted spelling of the same sky position must yield (150, -30).
  test.each([
    ["plain degrees", "150.0 -30.0"],
    ["comma-separated degrees", "150.0, -30.0"],
    ["sexagesimal colons", "10:00:00 -30:00:00"],
    ["letter-annotated HMS/DMS", "10h00m00s -30d00m00s"],
  ])("%s → {150, -30}", (_label, input) => {
    const c = window.parseCoordinates(input);
    expect(c.ra).toBeCloseTo(150, 6);
    expect(c.dec).toBeCloseTo(-30, 6);
  });

  test("rejects garbage and empty input", () => {
    expect(window.parseCoordinates("hello world")).toBeNull();
    expect(window.parseCoordinates("")).toBeNull();
    expect(window.parseCoordinates(null)).toBeNull();
  });

  test("rejects out-of-range degrees", () => {
    expect(window.parseCoordinates("400 0")).toBeNull(); // RA > 360
    expect(window.parseCoordinates("10 120")).toBeNull(); // Dec > 90
  });

  test("preserves positive declination sign", () => {
    expect(window.parseCoordinates("10:00:00 +30:00:00").dec).toBeCloseTo(30, 6);
  });
});

describe("smartDateToMJD", () => {
  test("passes an MJD through unchanged", () => {
    expect(window.smartDateToMJD("59000")).toBe(59000);
  });

  test("converts Julian Date (JD − 2400000.5)", () => {
    expect(window.smartDateToMJD("2459000.5")).toBeCloseTo(59000, 6);
  });

  test("converts a calendar date (UTC) to MJD", () => {
    expect(window.smartDateToMJD("2020-05-31")).toBeCloseTo(59000, 6);
  });

  test("returns null for unparseable input", () => {
    expect(window.smartDateToMJD("not a date")).toBeNull();
    expect(window.smartDateToMJD("")).toBeNull();
    expect(window.smartDateToMJD(null)).toBeNull();
  });
});

describe("mjdToCalendarStr", () => {
  test("round-trips with smartDateToMJD", () => {
    const iso = window.mjdToCalendarStr(59000); // → "2020-05-31T00:00:00"
    expect(iso.startsWith("2020-05-31")).toBe(true);
    expect(window.smartDateToMJD(iso)).toBeCloseTo(59000, 6);
  });
});
