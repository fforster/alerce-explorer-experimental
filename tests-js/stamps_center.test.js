/* Stamp centring geometry — the fix for cutouts clipped at a detector edge.
 *
 * A survey carves a fixed-size cutout around the alert; when the alert lands
 * near a detector boundary the box is truncated, so the alert is no longer at
 * the image's geometric centre. The renderer therefore anchors the WCS
 * REFERENCE PIXEL (CRPIX) at the canvas centre — where the CSS crosshair sits —
 * rather than the middle of the pixel grid.
 *
 * Reference case throughout: ZTF26abngxfo candid 3510493201915015030, a 48x63
 * cutout whose alert sits at CRPIX1 ~ 31.59 instead of the geometric 24.5.
 */
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let S;

beforeAll(() => {
  loadScript("src/static/js/stamps.js");
  S = window.__stampsTest;
});

describe("stampFlipY", () => {
  test("flips when the Dec axis increases with row", () => {
    expect(S.stampFlipY({ CD2_2: 1 / 3600 })).toBe(true);
    expect(S.stampFlipY({ CDELT2: 0.0002 })).toBe(true);
  });

  test("does not flip for a negative or absent CD2_2", () => {
    expect(S.stampFlipY({ CD2_2: -1 / 3600 })).toBe(false);
    expect(S.stampFlipY({})).toBe(false); // WCS-less ZTF header
  });
});

describe("stampAnchor", () => {
  // The regression lock: whenever CRPIX is the geometric centre the anchor must
  // land on (nx/2, ny/2), i.e. exactly what the renderer did before this fix.
  // Every unclipped stamp — the overwhelming majority — goes through here.
  test("reduces to the geometric centre for a centred CRPIX (flipped)", () => {
    const n = 63;
    const a = S.stampAnchor((n + 1) / 2, (n + 1) / 2, n, n, true);
    expect(a.ax).toBeCloseTo(n / 2, 10);
    expect(a.ay).toBeCloseTo(n / 2, 10);
  });

  test("reduces to the geometric centre for a centred CRPIX (unflipped)", () => {
    const n = 63;
    const a = S.stampAnchor((n + 1) / 2, (n + 1) / 2, n, n, false);
    expect(a.ax).toBeCloseTo(n / 2, 10);
    expect(a.ay).toBeCloseTo(n / 2, 10);
  });

  test("the flip inverts the row term only", () => {
    const flipped = S.stampAnchor(10, 20, 48, 63, true);
    const plain = S.stampAnchor(10, 20, 48, 63, false);
    expect(flipped.ax).toBe(plain.ax);
    expect(plain.ay).toBeCloseTo(19.5, 10); // crpix2 - 0.5
    expect(flipped.ay).toBeCloseTo(63 + 0.5 - 20, 10);
  });

  test("real clipped epoch sits ~7 px off the geometric centre", () => {
    const nx = 48;
    const crpix1 = 3055.591796875 - 3025 + 1; // 31.59…
    const a = S.stampAnchor(crpix1, 32.2, nx, 63, false);
    expect(a.ax).toBeCloseTo(31.0918, 3);
    // Which is what the old geometric-centre anchor got wrong:
    expect(a.ax - nx / 2).toBeGreaterThan(7.0);
  });
});

describe("stampFitScale", () => {
  test("matches the legacy outSize/max(nx,ny) for a centred anchor", () => {
    for (const [nx, ny] of [[63, 63], [48, 63], [63, 48], [100, 100]]) {
      const s = S.stampFitScale(180, nx / 2, ny / 2, nx, ny);
      expect(s).toBeCloseTo(180 / Math.max(nx, ny), 10);
    }
  });

  test("clipped epoch keeps the same angular scale as its unclipped sibling", () => {
    // 48x63 anchored at the true CRPIX still spans ~63 px about the anchor, so
    // the field of view is unchanged — the image just gains padding on the
    // truncated side rather than sliding sideways. (Not exact: the alert is
    // 0.2 px off the y centre, so the fit is that much tighter.)
    const crpix1 = 3055.591796875 - 3025 + 1;
    const a = S.stampAnchor(crpix1, 32.2, 48, 63, false);
    expect(S.stampFitScale(180, a.ax, a.ay, 48, 63)).toBeCloseTo(180 / 63, 1);
  });

  test("keeps the whole image inside the canvas for an off-centre anchor", () => {
    const nx = 48, ny = 63, outSize = 180;
    const ax = 40, ay = 10; // badly off-centre both ways
    const s = S.stampFitScale(outSize, ax, ay, nx, ny);
    // Every image edge, measured from the anchor and scaled, must stay within
    // the half-canvas.
    for (const d of [ax, nx - ax, ay, ny - ay]) {
      expect(d * s).toBeLessThanOrEqual(outSize / 2 + 1e-9);
    }
  });
});

describe("parseStampUrl", () => {
  test("extracts oid + candid + survey from a ZTF stamp URL", () => {
    const out = S.parseStampUrl(
      "https://avro.alerce.online/get_stamp?oid=ZTF26abngxfo"
      + "&candid=3510493201915015030&type=science&format=fits",
    );
    expect(out).toEqual({
      oid: "ZTF26abngxfo", ident: "3510493201915015030", survey: "ztf",
    });
  });

  test("extracts measurement_id for LSST", () => {
    const out = S.parseStampUrl(
      "https://api-lsst.alerce.online/stamps_api/stamp?survey_id=lsst"
      + "&oid=123&measurement_id=456&stamp_type=cutoutScience",
    );
    expect(out.survey).toBe("lsst");
    expect(out.ident).toBe("456");
  });

  test("degrades to blanks on junk rather than throwing", () => {
    expect(() => S.parseStampUrl("!!! not a url")).not.toThrow();
    expect(S.parseStampUrl("").survey).toBe("");
  });
});

/* The renderer transform. jsdom has no canvas backend, so we record the 2D
 * calls, replay them as an affine matrix, and assert where the anchor lands. */
function recordingCanvas(width, height) {
  const calls = [];
  const recorded = {
    translate: (x, y) => calls.push(["translate", x, y]),
    rotate: (a) => calls.push(["rotate", a]),
    scale: (x, y) => calls.push(["scale", x, y]),
    drawImage: (...a) => calls.push(["drawImage", ...a]),
  };
  // Everything else the compass / scale-bar overlays call (fill, stroke,
  // fillText, …) is a no-op — we only care about the placement transform, and
  // a Proxy keeps this from breaking whenever an overlay gains a new call.
  const props = {};
  const ctx = new Proxy(props, {
    get: (t, p) => (p in recorded ? recorded[p] : (p in t ? t[p] : () => {})),
    set: (t, p, v) => { t[p] = v; return true; },
  });
  return { width, height, getContext: () => ctx, calls, dataset: {} };
}

// Compose the recorded ops up to drawImage into a 2x3 matrix and apply it.
function anchorLandsAt(calls) {
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let draw = null;
  for (const c of calls) {
    if (c[0] === "translate") m = mul(m, [1, 0, 0, 1, c[1], c[2]]);
    else if (c[0] === "scale") m = mul(m, [c[1], 0, 0, c[2], 0, 0]);
    else if (c[0] === "rotate") {
      const s = Math.sin(c[1]), co = Math.cos(c[1]);
      m = mul(m, [co, s, -s, co, 0, 0]);
    } else if (c[0] === "drawImage") { draw = c; break; }
  }
  // drawImage places the source's (0,0) at (dx, dy), so the anchor — drawn at
  // (-ax, -ay) — is the transform's origin.
  return { x: m[4], y: m[5], dx: draw[2], dy: draw[3] };
}

describe("blitStampCanvas anchoring", () => {
  const nx = 48, ny = 63;
  const crpix1 = 3055.591796875 - 3025 + 1;
  const crpix2 = 2209.19970703125 - 2178 + 1;

  function blit({ zoom = 1, northAngle = 0, crpix = true }) {
    const canvas = recordingCanvas(180, 180);
    const cached = {
      srcCanvas: { width: nx, height: ny },
      nx, ny, northAngle, header: {}, flipY: false,
      crpix1: crpix ? crpix1 : null,
      crpix2: crpix ? crpix2 : null,
    };
    S.blitStampCanvas(canvas, cached, zoom);
    return anchorLandsAt(canvas.calls);
  }

  test.each([1, 2, 4])("alert stays on the crosshair at zoom %s", (zoom) => {
    const got = blit({ zoom });
    expect(got.x).toBeCloseTo(90, 6); // canvas centre == CSS crosshair at 50%
    expect(got.y).toBeCloseTo(90, 6);
  });

  test("alert stays on the crosshair under rotation", () => {
    const got = blit({ zoom: 2, northAngle: Math.PI / 6 });
    expect(got.x).toBeCloseTo(90, 6);
    expect(got.y).toBeCloseTo(90, 6);
  });

  test("draws the image offset by the anchor, not by half its size", () => {
    const got = blit({});
    const a = S.stampAnchor(crpix1, crpix2, nx, ny, false);
    expect(got.dx).toBeCloseTo(-a.ax, 10);
    expect(got.dy).toBeCloseTo(-a.ay, 10);
    expect(got.dx).not.toBeCloseTo(-nx / 2, 3); // i.e. NOT the old behaviour
  });

  test("falls back to the geometric centre when CRPIX is unknown", () => {
    const got = blit({ crpix: false });
    expect(got.dx).toBeCloseTo(-nx / 2, 10);
    expect(got.dy).toBeCloseTo(-ny / 2, 10);
  });
});

describe("augmentZTFStampWCS", () => {
  const ZTF_URL = "https://avro.alerce.online/get_stamp?oid=OBJ&candid=99"
                + "&type=science&format=fits";

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="aladin-host" data-ra="10.0" data-dec="20.0"></div>
      <div id="stamps-panel" data-survey="ztf" data-oid="OBJ">
        <select name="identifier">
          <option value="99" data-ra="10.5" data-dec="20.5" selected></option>
          <option value="98" data-ra="11.5" data-dec="21.5"></option>
        </select>
        <canvas class="stamp-canvas"></canvas>
      </div>`;
  });

  function canvasWithUrl(url) {
    const c = document.querySelector("canvas.stamp-canvas");
    c.dataset.stampUrl = url;
    return c;
  }

  test("anchors on the SELECTED detection, not the object mean", () => {
    const header = {};
    S.augmentZTFStampWCS(header, 63, 63, canvasWithUrl(ZTF_URL));
    // The aladin-host mean (10.0, 20.0) is deliberately different — using it is
    // what made the Aladin footprint disagree with the pixels.
    expect(header.CRVAL1).toBe(10.5);
    expect(header.CRVAL2).toBe(20.5);
  });

  test("preserves a CRPIX recovered from the clipped-cutout lookup", () => {
    const header = { CRPIX1: 31.59, CRPIX2: 32.2 };
    S.augmentZTFStampWCS(header, 48, 63, canvasWithUrl(ZTF_URL));
    expect(header.CRPIX1).toBe(31.59); // NOT overwritten with (48+1)/2
    expect(header.CRPIX2).toBe(32.2);
  });

  test("assumes the geometric centre only when CRPIX is absent", () => {
    const header = {};
    S.augmentZTFStampWCS(header, 63, 63, canvasWithUrl(ZTF_URL));
    expect(header.CRPIX1).toBe(32);
    expect(header.CRPIX2).toBe(32);
  });

  test("is a no-op when the header already carries a WCS (LSST)", () => {
    const header = { CRVAL1: 1, CRVAL2: 2, CRPIX1: 5, CRPIX2: 6 };
    S.augmentZTFStampWCS(header, 63, 63, canvasWithUrl(ZTF_URL));
    expect(header.CRVAL1).toBe(1);
    expect(header.CRPIX1).toBe(5);
    expect(header.CD1_1).toBeUndefined();
  });

  test("does not synthesise for a non-ZTF stamp URL", () => {
    const header = {};
    S.augmentZTFStampWCS(header, 63, 63, canvasWithUrl(
      "https://api-lsst.alerce.online/stamps_api/stamp?oid=1&measurement_id=2",
    ));
    expect(header.CRVAL1).toBeUndefined();
  });

  test("falls back to the object mean when the option has no coords", () => {
    document.querySelectorAll("option").forEach((o) => {
      delete o.dataset.ra; delete o.dataset.dec;
    });
    const header = {};
    S.augmentZTFStampWCS(header, 63, 63, canvasWithUrl(ZTF_URL));
    expect(header.CRVAL1).toBe(10.0);
  });
});

describe("footprint on a clipped cutout", () => {
  test("spans the true 48x63 pixels and centres on the alert", () => {
    const crpix1 = 3055.591796875 - 3025 + 1;
    const crpix2 = 2209.19970703125 - 2178 + 1;
    const P = 1 / 3600;
    const header = {
      CRPIX1: crpix1, CRPIX2: crpix2, CRVAL1: 80.2511448, CRVAL2: 6.5583817,
      CD1_1: -P, CD1_2: 0, CD2_1: 0, CD2_2: P,
    };
    const corners = S.computeStampFootprint(header, 48, 63);
    expect(corners).toHaveLength(4);
    const decs = corners.map((c) => c[1]);
    // 63 px at 1"/px = 63" tall.
    expect((Math.max(...decs) - Math.min(...decs)) * 3600).toBeCloseTo(63, 0);
    // The polygon's centre is offset from the alert — that asymmetry is the
    // whole point: the alert is NOT in the middle of a clipped cutout.
    const midDec = (Math.max(...decs) + Math.min(...decs)) / 2;
    expect(Math.abs(midDec - header.CRVAL2) * 3600).toBeLessThan(1);
    const ras = corners.map((c) => c[0]);
    const midRa = (Math.max(...ras) + Math.min(...ras)) / 2;
    const offsetArcsec = Math.abs(midRa - header.CRVAL1) * 3600
                       * Math.cos(header.CRVAL2 * Math.PI / 180);
    expect(offsetArcsec).toBeGreaterThan(6);
  });
});
