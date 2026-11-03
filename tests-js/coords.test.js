/* Unit tests for src/static/js/coords.js — the free-text RA/Dec parser and
 * the smart date→MJD converter. These are the pure functions exposed on
 * window for the search form's hx-vals expressions.
 *
 * The name resolver's network call is stubbed (see the describe blocks at the
 * bottom), so its outcome mapping and the button's waiting signal are covered
 * here too — the live Sesame round trip is left to Tier-3 / manual QA.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
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

/* Name resolution: outcome messages + the waiting signal.
 *
 * Neither existed before. The only feedback was the button's `title`
 * attribute — invisible unless hovered — so a failed resolve was
 * indistinguishable from nothing happening. With CDS Sesame offline and no
 * mirror available (trap #20) that silent failure became the common case.
 *
 * The distinction these tests protect: "no such object" and "the service is
 * unreachable" are different situations for the user. One means fix the
 * spelling; the other means no spelling will help. Collapsing both into a
 * bare `null` is the bug.
 */
const sesameXml = (ra, dec) =>
  `<?xml version="1.0"?><Sesame><Target><Resolver>` +
  `<jradeg>${ra}</jradeg><jdedeg>${dec}</jdedeg>` +
  `</Resolver></Target></Sesame>`;

const okResp = (body) => ({ ok: true, status: 200, text: async () => body });

function form() {
  document.body.innerHTML = `
    <input id="nm" value="" />
    <input id="co" value="" />
    <button id="bt">Resolve</button>
    <div id="st" hidden></div>`;
  return {
    name: document.getElementById("nm"),
    coords: document.getElementById("co"),
    btn: document.getElementById("bt"),
    status: document.getElementById("st"),
  };
}

const ids = { nameId: "nm", coordsId: "co", btnId: "bt", statusId: "st" };

describe("resolveNameDetailed outcome mapping", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test("a resolved name reports ok with coordinates", async () => {
    vi.stubGlobal("fetch", async () => okResp(sesameXml(10.684, 41.269)));
    const r = await window.resolveNameDetailed("M31");
    expect(r.status).toBe(window.RESOLVE_STATUS.OK);
    expect(r.ra).toBeCloseTo(10.684, 3);
    expect(r.dec).toBeCloseTo(41.269, 3);
  });

  test("an empty or whitespace name never hits the network", async () => {
    let called = 0;
    vi.stubGlobal("fetch", async () => { called += 1; return okResp(""); });
    for (const v of ["", "   ", null, undefined]) {
      expect((await window.resolveNameDetailed(v)).status)
        .toBe(window.RESOLVE_STATUS.EMPTY);
    }
    expect(called).toBe(0);
  });

  test("a 200 with no coordinates is NOT_FOUND, not unavailable", async () => {
    // Sesame answers 200 with a document carrying no <jradeg> for a name it
    // doesn't know, so this is a genuine miss and the user should retype.
    vi.stubGlobal("fetch", async () =>
      okResp(`<?xml version="1.0"?><Sesame><Target/></Sesame>`));
    expect((await window.resolveNameDetailed("not a real object")).status)
      .toBe(window.RESOLVE_STATUS.NOT_FOUND);
  });

  test("unparseable coordinates are NOT_FOUND", async () => {
    vi.stubGlobal("fetch", async () => okResp(sesameXml("", "")));
    expect((await window.resolveNameDetailed("x")).status)
      .toBe(window.RESOLVE_STATUS.NOT_FOUND);
  });

  test("a thrown fetch is UNAVAILABLE — the CDS-offline case", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    expect((await window.resolveNameDetailed("M31")).status)
      .toBe(window.RESOLVE_STATUS.UNAVAILABLE);
  });

  test("a timeout is UNAVAILABLE, so the button can't hang forever", async () => {
    vi.stubGlobal("fetch", async () => {
      const e = new Error("timed out"); e.name = "TimeoutError"; throw e;
    });
    expect((await window.resolveNameDetailed("M31")).status)
      .toBe(window.RESOLVE_STATUS.UNAVAILABLE);
  });

  test("an HTTP error is the service failing, not a bad name", async () => {
    for (const status of [500, 502, 404, 403]) {
      vi.stubGlobal("fetch", async () => ({ ok: false, status, text: async () => "" }));
      expect((await window.resolveNameDetailed("M31")).status)
        .toBe(window.RESOLVE_STATUS.UNAVAILABLE);
    }
  });

  test("the request carries an abort signal", async () => {
    let opts;
    vi.stubGlobal("fetch", async (_u, o) => { opts = o; return okResp(sesameXml(1, 2)); });
    await window.resolveNameDetailed("M31");
    expect(opts && opts.signal).toBeTruthy();
  });

  test("resolveName keeps its original coords-or-null contract", async () => {
    vi.stubGlobal("fetch", async () => okResp(sesameXml(10, 20)));
    expect(await window.resolveName("M31")).toEqual({ ra: 10, dec: 20 });
    vi.stubGlobal("fetch", async () => { throw new Error("down"); });
    expect(await window.resolveName("M31")).toBeNull();
  });
});

describe("resolveMessage wording", () => {
  const S = () => window.RESOLVE_STATUS;

  test("each outcome gets its own actionable message", () => {
    const ok = window.resolveMessage(
      { status: S().OK, name: "M31", ra: 10.684708, dec: 41.26875 });
    expect(ok).toContain("10.684708");
    expect(ok).toContain("41.268750");

    expect(window.resolveMessage({ status: S().EMPTY, name: "" }))
      .toMatch(/type a name/i);

    const nf = window.resolveMessage({ status: S().NOT_FOUND, name: "zzz" });
    expect(nf).toContain("zzz");
    expect(nf).toMatch(/spelling|RA\/Dec/i);

    // Must name the service and tell the user what to do instead — no
    // spelling correction will help when Sesame itself is gone.
    const un = window.resolveMessage({ status: S().UNAVAILABLE, name: "M31" });
    expect(un).toMatch(/Sesame/);
    expect(un).toMatch(/manually|RA\/Dec/i);
    expect(un).not.toMatch(/spelling/i);
  });

  test("the not-found and unavailable messages differ", () => {
    expect(window.resolveMessage({ status: S().NOT_FOUND, name: "x" }))
      .not.toBe(window.resolveMessage({ status: S().UNAVAILABLE, name: "x" }));
  });
});

describe("resolveNameInteractive: waiting signal and feedback", () => {
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

  test("the button shows a busy state while in flight, then restores", async () => {
    const el = form();
    el.name.value = "M31";
    let seen = null;
    vi.stubGlobal("fetch", async () => {
      // Sampled mid-flight: this is the waiting signal under test.
      seen = {
        text: el.btn.textContent,
        disabled: el.btn.disabled,
        busy: el.btn.dataset.busy,
        aria: el.btn.getAttribute("aria-busy"),
        status: el.status.textContent,
        hidden: el.status.hidden,
      };
      return okResp(sesameXml(10.684, 41.269));
    });

    await window.resolveNameInteractive(ids);

    expect(seen.text).toBe("Resolving…");
    expect(seen.disabled).toBe(true);
    expect(seen.busy).toBe("1");
    expect(seen.aria).toBe("true");
    expect(seen.status).toContain("M31");
    expect(seen.hidden).toBe(false);

    // Restored afterwards.
    expect(el.btn.textContent).toBe("Resolve");
    expect(el.btn.disabled).toBe(false);
    expect(el.btn.dataset.busy).toBeUndefined();
    expect(el.btn.getAttribute("aria-busy")).toBeNull();
  });

  test("success fills the coords field and confirms visibly", async () => {
    const el = form();
    el.name.value = "M31";
    vi.stubGlobal("fetch", async () => okResp(sesameXml(10.684708, 41.26875)));

    const r = await window.resolveNameInteractive(ids);

    expect(r.status).toBe(window.RESOLVE_STATUS.OK);
    expect(el.coords.value).toBe("10.684708 41.268750");
    expect(el.status.hidden).toBe(false);
    expect(el.status.dataset.kind).toBe("ok");
    expect(el.status.textContent).toContain("10.684708");
  });

  test("an unreachable resolver shows a visible error and leaves coords alone", async () => {
    const el = form();
    el.name.value = "M31";
    el.coords.value = "1.0 2.0";
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });

    const r = await window.resolveNameInteractive(ids);

    expect(r.status).toBe(window.RESOLVE_STATUS.UNAVAILABLE);
    expect(el.status.dataset.kind).toBe("error");
    expect(el.status.hidden).toBe(false);
    expect(el.status.textContent).toMatch(/Sesame/);
    expect(el.status.classList.contains("tw-text-red-400")).toBe(true);
    // A failed resolve must never clobber coordinates already entered.
    expect(el.coords.value).toBe("1.0 2.0");
  });

  test("a name that doesn't exist reports a miss, not an outage", async () => {
    const el = form();
    el.name.value = "zzz not an object";
    vi.stubGlobal("fetch", async () =>
      okResp(`<?xml version="1.0"?><Sesame><Target/></Sesame>`));

    const r = await window.resolveNameInteractive(ids);

    expect(r.status).toBe(window.RESOLVE_STATUS.NOT_FOUND);
    expect(el.status.dataset.kind).toBe("error");
    expect(el.status.textContent).toContain("zzz not an object");
    expect(el.status.textContent).not.toMatch(/Sesame/);
  });

  test("an empty field is a hint, not an error, and skips the network", async () => {
    const el = form();
    let called = 0;
    vi.stubGlobal("fetch", async () => { called += 1; return okResp(""); });

    const r = await window.resolveNameInteractive(ids);

    expect(r.status).toBe(window.RESOLVE_STATUS.EMPTY);
    expect(el.status.dataset.kind).toBe("hint");
    expect(el.status.classList.contains("tw-text-red-400")).toBe(false);
    expect(called).toBe(0);
  });

  test("the button is restored even if the resolver throws outright", async () => {
    const el = form();
    el.name.value = "M31";
    // A stuck "Resolving…" on a dead button is the worst possible outcome,
    // so the restore sits in a finally block.
    const boom = () => { throw new Error("DOMParser exploded"); };
    const orig = window.DOMParser;
    window.DOMParser = function () { return { parseFromString: boom }; };
    vi.stubGlobal("fetch", async () => okResp(sesameXml(1, 2)));

    await expect(window.resolveNameInteractive(ids)).rejects.toThrow();
    expect(el.btn.disabled).toBe(false);
    expect(el.btn.textContent).toBe("Resolve");
    window.DOMParser = orig;
  });

  test("repeated resolves don't accumulate the busy label", async () => {
    const el = form();
    el.name.value = "M31";
    vi.stubGlobal("fetch", async () => okResp(sesameXml(1, 2)));
    await window.resolveNameInteractive(ids);
    await window.resolveNameInteractive(ids);
    await window.resolveNameInteractive(ids);
    expect(el.btn.textContent).toBe("Resolve");
  });

  test("missing elements are a no-op rather than a crash", async () => {
    document.body.innerHTML = "";
    expect(await window.resolveNameInteractive(ids)).toBeNull();
    expect(await window.resolveNameInteractive({})).toBeNull();
  });

  test("works without a status element or button", async () => {
    document.body.innerHTML = `<input id="nm" value="M31"/><input id="co"/>`;
    vi.stubGlobal("fetch", async () => okResp(sesameXml(5, 6)));
    const r = await window.resolveNameInteractive({ nameId: "nm", coordsId: "co" });
    expect(r.status).toBe(window.RESOLVE_STATUS.OK);
    expect(document.getElementById("co").value).toBe("5.000000 6.000000");
  });
});
