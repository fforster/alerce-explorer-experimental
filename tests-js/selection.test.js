/* DOM-level tests for src/static/js/selection.js — the cross-panel detection
 * selection sync. setSelectedIdentifier is the single entry point every
 * light-curve / scatter click funnels through; it updates the global
 * selection, dispatches the stamps repaint (routed by survey + oid for
 * cross-survey clicks), and mirrors the identifier into the URL.
 *
 * Chart.js is undefined under jsdom, so the chart-redraw path is a guarded
 * no-op here — exactly the branch we want, since we are testing the state /
 * dispatch / URL contract, not canvas pixels.
 */
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadScript } from "./helpers/load.js";

beforeAll(() => {
  loadScript("src/static/js/selection.js");
});

beforeEach(() => {
  window._selectedIdentifier = null;
  window._selectedSurvey = null;
  // Fresh spy each test so call counts don't leak between cases.
  window.updateStampsForIdentifier = vi.fn();
  // Clear any identifier left in the URL by a prior test.
  const url = new URL(window.location.href);
  url.searchParams.delete("identifier");
  history.replaceState(null, "", url.toString());
});

describe("setSelectedIdentifier", () => {
  test("sets the global selection and survey", () => {
    window.setSelectedIdentifier("12345", "ztf", "OID-A");
    expect(window._selectedIdentifier).toBe("12345");
    expect(window._selectedSurvey).toBe("ztf");
  });

  test("coerces a numeric identifier to a string", () => {
    window.setSelectedIdentifier(999, "lsst", "OID-B");
    expect(window._selectedIdentifier).toBe("999");
    expect(typeof window._selectedIdentifier).toBe("string");
  });

  test("dispatches the stamps repaint with survey + oid (cross-survey routing)", () => {
    window.setSelectedIdentifier("abc", "lsst", "OID-C");
    expect(window.updateStampsForIdentifier).toHaveBeenCalledWith("abc", "lsst", "OID-C");
  });

  test("mirrors the identifier into the URL", () => {
    window.setSelectedIdentifier("55", "ztf", "OID-D");
    const ident = new URLSearchParams(window.location.search).get("identifier");
    expect(ident).toBe("55");
  });

  test("empty identifier is a no-op (no state change, no dispatch)", () => {
    window._selectedIdentifier = "keep-me";
    window.setSelectedIdentifier("", "ztf", "OID-E");
    expect(window._selectedIdentifier).toBe("keep-me");
    expect(window.updateStampsForIdentifier).not.toHaveBeenCalled();
  });

  test("survey defaults to null when omitted (in-survey caller)", () => {
    window.setSelectedIdentifier("77");
    expect(window._selectedSurvey).toBeNull();
    expect(window.updateStampsForIdentifier).toHaveBeenCalledWith("77", undefined, undefined);
  });
});
