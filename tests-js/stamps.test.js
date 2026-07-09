/* Unit tests for the pure FITS-pipeline + WCS math in src/static/js/stamps.js
 * (the in-browser LSST stamp renderer), reached via window.__stampsTest.
 *
 * parseFitsHeader / readFitsImageData run against a hand-built synthetic FITS
 * ArrayBuffer (80-char ASCII cards in a 2880-byte block, big-endian data);
 * the WCS helpers take plain header objects. The canvas blit / stretch-to-
 * pixels rendering is left to Tier 3.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let S;
const ARCSEC = 1 / 3600;

// One 80-column FITS card: keyword (cols 0–7), "= " (8–9), value from col 10.
function card(key, val) {
  return (key.padEnd(8) + "= " + String(val)).padEnd(80).slice(0, 80);
}

// Build a minimal but valid single-HDU FITS file as an ArrayBuffer.
function buildFits({ bitpix, naxis1, naxis2, extra = [], data = [] }) {
  const cards = [
    card("SIMPLE", "T"), card("BITPIX", bitpix), card("NAXIS", 2),
    card("NAXIS1", naxis1), card("NAXIS2", naxis2), ...extra, "END".padEnd(80),
  ];
  let headerStr = cards.join("");
  headerStr = headerStr.padEnd(2880 * Math.ceil(headerStr.length / 2880), " ");
  const headerArr = new TextEncoder().encode(headerStr);
  const bpp = Math.abs(bitpix) / 8;
  const buf = new ArrayBuffer(headerArr.length + data.length * bpp);
  new Uint8Array(buf).set(headerArr, 0);
  const dv = new DataView(buf, headerArr.length);
  data.forEach((v, i) => {
    const o = i * bpp;
    if (bitpix === 16) dv.setInt16(o, v, false);
    else if (bitpix === -32) dv.setFloat32(o, v, false);
  });
  return buf;
}

beforeAll(() => {
  loadScript("src/static/js/stamps.js");
  S = window.__stampsTest;
});

describe("parseFitsHeader", () => {
  test("parses typed cards and locates the data offset after the END block", () => {
    const buf = buildFits({ bitpix: 16, naxis1: 2, naxis2: 2 });
    const fits = S.parseFitsHeader(buf, 0);
    expect(fits.header.SIMPLE).toBe(true); // "T" → boolean
    expect(fits.bitpix).toBe(16);
    expect(fits.naxis1).toBe(2);
    expect(fits.naxis2).toBe(2);
    expect(fits.headerEndByte).toBe(2880); // one header block
  });
});

describe("readFitsImageData", () => {
  test("reads big-endian int16 and applies BZERO/BSCALE (v·BSCALE + BZERO)", () => {
    const buf = buildFits({
      bitpix: 16, naxis1: 2, naxis2: 2,
      extra: [card("BZERO", 1000), card("BSCALE", 2)],
      data: [0, 10, -5, 100],
    });
    const fits = S.parseFitsHeader(buf, 0);
    const px = S.readFitsImageData(buf, fits);
    expect(Array.from(px)).toEqual([1000, 1020, 990, 1200]);
  });

  test("reads big-endian float32 with no rescaling", () => {
    const buf = buildFits({ bitpix: -32, naxis1: 2, naxis2: 1, data: [1.5, -2.25] });
    const fits = S.parseFitsHeader(buf, 0);
    const px = S.readFitsImageData(buf, fits);
    expect(px[0]).toBeCloseTo(1.5, 6);
    expect(px[1]).toBeCloseTo(-2.25, 6);
  });
});

describe("effectiveCDMatrix — all WCS conventions collapse to one CD matrix", () => {
  const expected = { cd11: -ARCSEC, cd12: 0, cd21: 0, cd22: ARCSEC };

  test("CD_ij style (ZTF)", () => {
    expect(S.effectiveCDMatrix({ CD1_1: -ARCSEC, CD1_2: 0, CD2_1: 0, CD2_2: ARCSEC })).toEqual(expected);
  });
  test("PC_ij + CDELT style (LSST)", () => {
    // Field-wise (not toEqual): cdelt1·0 yields −0, which Object.is — and thus
    // toEqual — distinguishes from +0.
    const cd = S.effectiveCDMatrix({ PC1_1: 1, PC2_2: 1, PC1_2: 0, PC2_1: 0, CDELT1: -ARCSEC, CDELT2: ARCSEC });
    expect(cd.cd11).toBeCloseTo(-ARCSEC, 12);
    expect(cd.cd12).toBeCloseTo(0, 12);
    expect(cd.cd21).toBeCloseTo(0, 12);
    expect(cd.cd22).toBeCloseTo(ARCSEC, 12);
  });
  test("CDELT + CROTA2 = 0 (legacy)", () => {
    const cd = S.effectiveCDMatrix({ CDELT1: -ARCSEC, CDELT2: ARCSEC, CROTA2: 0 });
    expect(cd.cd11).toBeCloseTo(-ARCSEC, 12);
    expect(cd.cd22).toBeCloseTo(ARCSEC, 12);
  });
  test("returns null when no WCS keywords are present", () => {
    expect(S.effectiveCDMatrix({})).toBeNull();
  });
});

describe("pixelToWorldTAN — gnomonic projection", () => {
  const H = { CRPIX1: 1, CRPIX2: 1, CRVAL1: 150, CRVAL2: 2, CD1_1: -ARCSEC, CD1_2: 0, CD2_1: 0, CD2_2: ARCSEC };

  test("returns CRVAL exactly at the reference pixel", () => {
    expect(S.pixelToWorldTAN(1, 1, H)).toEqual([150, 2]);
  });

  test("+1 column moves East (RA decreases) by ~1″/cos(dec)", () => {
    const [ra, dec] = S.pixelToWorldTAN(2, 1, H);
    expect(ra).toBeLessThan(150);
    expect(150 - ra).toBeCloseTo(ARCSEC / Math.cos(2 * Math.PI / 180), 6);
    expect(dec).toBeCloseTo(2, 6);
  });

  test("returns null without the required keywords", () => {
    expect(S.pixelToWorldTAN(1, 1, { CRVAL1: 1 })).toBeNull();
  });
});

describe("computeNorthAngle", () => {
  test("0 for an N-up, E-left frame (diag CD, cd11<0, cd22>0)", () => {
    expect(S.computeNorthAngle({ CD1_1: -ARCSEC, CD1_2: 0, CD2_1: 0, CD2_2: ARCSEC })).toBe(0);
  });
  test("non-zero for a rotated frame", () => {
    const r = 30 * Math.PI / 180;
    const cd = { CD1_1: -ARCSEC * Math.cos(r), CD1_2: ARCSEC * Math.sin(r), CD2_1: ARCSEC * Math.sin(r), CD2_2: ARCSEC * Math.cos(r) };
    expect(Math.abs(S.computeNorthAngle(cd))).toBeGreaterThan(0.01);
  });
  test("0 when the CD matrix is unavailable", () => {
    expect(S.computeNorthAngle({})).toBe(0);
  });
});

describe("computeStampFootprint", () => {
  test("returns the four sky corners of the image", () => {
    const H = { CRPIX1: 1, CRPIX2: 1, CRVAL1: 150, CRVAL2: 2, CD1_1: -ARCSEC, CD1_2: 0, CD2_1: 0, CD2_2: ARCSEC };
    const fp = S.computeStampFootprint(H, 2, 2);
    expect(fp).toHaveLength(4);
    fp.forEach(([ra, dec]) => {
      expect(Number.isFinite(ra)).toBe(true);
      expect(Number.isFinite(dec)).toBe(true);
    });
  });
  test("null when the WCS can't project", () => {
    expect(S.computeStampFootprint({}, 2, 2)).toBeNull();
  });
});

describe("zscaleStretch", () => {
  test("returns the 1% / 99.5% percentiles, ignoring non-finite pixels", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i).concat([NaN, Infinity]);
    expect(S.zscaleStretch(arr)).toEqual({ vmin: 1, vmax: 99 });
  });
  test("guards a flat image (vmax forced above vmin)", () => {
    expect(S.zscaleStretch([5, 5, 5])).toEqual({ vmin: 5, vmax: 6 });
  });
  test("all-NaN input falls back to [0, 1]", () => {
    expect(S.zscaleStretch([NaN, NaN])).toEqual({ vmin: 0, vmax: 1 });
  });
});

describe("detectSurveyFromStampUrl", () => {
  test("classifies LSST and ZTF stamp hosts, else empty", () => {
    expect(S.detectSurveyFromStampUrl("https://api-lsst.alerce.online/stamp")).toBe("lsst");
    expect(S.detectSurveyFromStampUrl("https://avro.alerce.online/get_stamp")).toBe("ztf");
    expect(S.detectSurveyFromStampUrl("https://example.com/x")).toBe("");
    expect(S.detectSurveyFromStampUrl(null)).toBe("");
  });
});

describe("cross-survey picker options", () => {
  test("stampOptionLabel mirrors the server row format", () => {
    expect(S.stampOptionLabel(60123.456, "2023-01-01 00:00:00 UTC", "ZTF", "g"))
      .toBe("MJD 60123.456 (2023-01-01 00:00:00 UTC) · ZTF g");
    // Missing UTC / band degrade gracefully.
    expect(S.stampOptionLabel(60123.4, "", "LSST", null)).toBe("MJD 60123.400");
  });

  test("surveyLabelFor maps the two surveys, upper-cases the rest", () => {
    expect(S.surveyLabelFor("lsst")).toBe("LSST");
    expect(S.surveyLabelFor("ztf")).toBe("ZTF");
    expect(S.surveyLabelFor("des")).toBe("DES");
  });

  // Minimal stamps panel: a picker <select> with two primary options, as the
  // server renders for an LSST primary view.
  function buildPanel(primarySurvey, primaryOid) {
    document.body.innerHTML = `
      <div id="stamps-panel" data-oid="${primaryOid}" data-survey="${primarySurvey}">
        <select name="identifier">
          <option value="100" data-survey="${primarySurvey}" data-oid="${primaryOid}">MJD 60002.000 · LSST g</option>
          <option value="101" data-survey="${primarySurvey}" data-oid="${primaryOid}">MJD 60001.000 · LSST r</option>
        </select>
      </div>`;
    return document.querySelector('select[name="identifier"]');
  }

  test("appends a labeled cross-survey optgroup and wraps the primary options", () => {
    const select = buildPanel("lsst", "LSSTOID");
    S.applyXStampOptions({
      primaryOid: "LSSTOID",
      survey: "ztf",
      oid: "ZTF26abc",
      detections: [
        { identifier: "900", mjd: 60003.5, mjd_utc: "2023-04-01 12:00:00 UTC", band: "g" },
        { identifier: "901", mjd: 60000.5, mjd_utc: "", band: "r" },
      ],
    });

    const groups = select.querySelectorAll("optgroup");
    expect(groups.length).toBe(2);
    // Primary options wrapped in an "LSST" group, order preserved.
    expect(groups[0].label).toBe("LSST");
    expect(groups[0].dataset.primary).toBe("1");
    expect(Array.from(groups[0].querySelectorAll("option")).map((o) => o.value))
      .toEqual(["100", "101"]);
    // Cross-survey group carries the matched survey + OID on each option.
    expect(groups[1].label).toBe("ZTF");
    expect(groups[1].dataset.xsurvey).toBe("1");
    const xopts = groups[1].querySelectorAll("option");
    expect(xopts.length).toBe(2);
    expect(xopts[0].value).toBe("900");
    expect(xopts[0].dataset.survey).toBe("ztf");
    expect(xopts[0].dataset.oid).toBe("ZTF26abc");
    expect(xopts[0].textContent).toBe("MJD 60003.500 (2023-04-01 12:00:00 UTC) · ZTF g");
    expect(xopts[1].textContent).toBe("MJD 60000.500 · ZTF r");
  });

  test("is re-runnable — replaces the prior cross group, keeps one primary group", () => {
    const select = buildPanel("lsst", "LSSTOID");
    const payload = {
      primaryOid: "LSSTOID", survey: "ztf", oid: "ZTF26abc",
      detections: [{ identifier: "900", mjd: 60003.5, mjd_utc: "", band: "g" }],
    };
    S.applyXStampOptions(payload);
    S.applyXStampOptions(payload);
    expect(select.querySelectorAll('optgroup[data-primary="1"]').length).toBe(1);
    expect(select.querySelectorAll('optgroup[data-xsurvey="1"]').length).toBe(1);
    expect(select.querySelectorAll('optgroup[data-xsurvey="1"] option').length).toBe(1);
  });

  test("ignores a payload whose primaryOid doesn't match the current panel", () => {
    const select = buildPanel("lsst", "LSSTOID");
    S.applyXStampOptions({
      primaryOid: "OTHEROID", survey: "ztf", oid: "ZTF26abc",
      detections: [{ identifier: "900", mjd: 60003.5, mjd_utc: "", band: "g" }],
    });
    expect(select.querySelectorAll("optgroup").length).toBe(0);
    expect(select.querySelectorAll("option").length).toBe(2);
  });

  test("no-op (flat picker preserved) when there are no cross-survey detections", () => {
    const select = buildPanel("lsst", "LSSTOID");
    S.applyXStampOptions({ primaryOid: "LSSTOID", survey: "ztf", oid: "ZTF26abc", detections: [] });
    expect(select.querySelectorAll("optgroup").length).toBe(0);
    expect(select.querySelectorAll("option").length).toBe(2);
  });
});
