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
