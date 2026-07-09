/* Integration test: cross-survey stamps picker.
 *
 * Proves the full click path once a LSST<->ZTF crossmatch lands — the picker
 * grows a labeled ZTF optgroup (setCrossSurveyStampOptions), and selecting a
 * ZTF epoch (onStampsPickerChange -> setSelectedIdentifier ->
 * updateStampsForIdentifier) repoints the stamp canvas to the ZTF stamp
 * service with the matched OID + candid substituted. jsdom has no 2d canvas,
 * so getContext is stubbed with no-op drawing calls.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, stroke() {}, translate() {}, rotate() {}, scale() {}, drawImage() {}, setTransform() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, fillText() {}, createImageData: () => ({ data: [] }), putImageData() {} });
  loadScript("src/static/js/selection.js"); loadScript("src/static/js/stamps.js");
});

describe("cross-survey stamps end-to-end DOM", () => {
  test("selecting the ZTF epoch repoints stamps to the ZTF service w/ matched OID", () => {
    // Panel as the server renders it for an LSST primary, incl. per-survey
    // URL templates (both __OID__ + __IDENT__).
    document.body.innerHTML = `
      <div id="stamps-panel" data-oid="170604736974684316" data-survey="lsst"
        data-url-template-science="https://lsst/sci?oid=170604736974684316&id=__IDENT__"
        data-url-template-science-lsst="https://lsst/sci?oid=__OID__&id=__IDENT__"
        data-url-template-science-ztf="https://avro.alerce.online/get_stamp?oid=__OID__&candid=__IDENT__&type=science">
        <select name="identifier" onchange="window.onStampsPickerChange(this)">
          <option value="500" data-survey="lsst" data-oid="170604736974684316">MJD 60880.000 · LSST r</option>
        </select>
        <canvas class="stamp-canvas" data-stamp-type="science"
          data-stamp-url="https://lsst/sci?oid=170604736974684316&id=500"></canvas>
      </div>`;

    // Cross-survey options from the real bundle (ZTF18ackiehi).
    window.setCrossSurveyStampOptions({
      primaryOid: "170604736974684316",
      survey: "ztf",
      oid: "ZTF18ackiehi",
      detections: [{ identifier: "3123456789", mjd: 60879.363, mjd_utc: "2025-08-01 08:42:00 UTC", band: "r" }],
    });

    const select = document.querySelector('select[name="identifier"]');
    const xopt = select.querySelector('optgroup[data-xsurvey="1"] option');
    expect(xopt).toBeTruthy();
    expect(xopt.textContent).toContain("ZTF r");

    // Simulate the user picking the ZTF epoch.
    select.value = "3123456789";
    window.onStampsPickerChange(select);

    // The science canvas should now point at the ZTF stamp service with the
    // matched OID + candid substituted.
    const canvas = document.querySelector("canvas.stamp-canvas");
    expect(canvas.dataset.stampUrl).toBe(
      "https://avro.alerce.online/get_stamp?oid=ZTF18ackiehi&candid=3123456789&type=science",
    );
    // Selection propagated globally.
    expect(window._selectedIdentifier).toBe("3123456789");
    expect(window._selectedSurvey).toBe("ztf");
  });
});
