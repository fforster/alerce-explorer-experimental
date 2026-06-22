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

describe("syncDatePickerFromText", () => {
  // Mirrors the form layout: a free-text date field plus its hidden
  // datetime-local picker sibling at id="<textId>-cal".
  function makePair(textValue) {
    // step="1" matches the form's pickers — without it datetime-local
    // sanitizes to minute precision and drops the seconds.
    document.body.innerHTML = `
      <input id="filter-date-from" type="text" value="${textValue}" />
      <input id="filter-date-from-cal" type="datetime-local" step="1" value="2099-01-01T00:00:00" />
    `;
    return document.getElementById("filter-date-from-cal");
  }

  // NOTE: jsdom's datetime-local sanitizer drops seconds even with step="1",
  // so we assert to the minute (startsWith) — same compromise as the
  // mjdToCalendarStr test above. The fractional MJD (.5 = 12:00 UTC) proves
  // the time-of-day flows through, not just the date.
  test("typing an MJD (with time of day) updates the hidden UTC picker", () => {
    const cal = makePair("59000.5"); // 2020-05-31 12:00:00 UTC
    window.syncDatePickerFromText("filter-date-from");
    expect(cal.value.startsWith("2020-05-31T12:00")).toBe(true);
  });

  test("a JD and a calendar date both drive the picker", () => {
    let cal = makePair("2459000.5"); // JD → MJD 59000 → 2020-05-31 00:00
    window.syncDatePickerFromText("filter-date-from");
    expect(cal.value.startsWith("2020-05-31T00:00")).toBe(true);

    cal = makePair("2020-05-31");
    window.syncDatePickerFromText("filter-date-from");
    expect(cal.value.startsWith("2020-05-31T00:00")).toBe(true);
  });

  test("unparseable text leaves the picker untouched", () => {
    const cal = makePair("not a date");
    window.syncDatePickerFromText("filter-date-from");
    expect(cal.value.startsWith("2099-01-01T00:00")).toBe(true);
  });

  test("clearing the text field clears the picker", () => {
    const cal = makePair("");
    window.syncDatePickerFromText("filter-date-from");
    expect(cal.value).toBe("");
  });

  test("delegated change event syncs without an explicit call", () => {
    const cal = makePair("59000.5");
    document
      .getElementById("filter-date-from")
      .dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(cal.value.startsWith("2020-05-31T12:00")).toBe(true);
  });
});
