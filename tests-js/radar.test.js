/* Unit tests for the pure data-shaping helpers in src/static/js/radar.js
 * (classifier-probability radar), reached via window.__radarTest. The Chart.js
 * construction is left to Tier 3; these cover the value/label/scale logic.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let R;
const GROUP = {
  key: "stamp_classifier_1.0.0",
  classifier_name: "stamp",
  classes: [
    { class_name: "SN", probability: 0.7, is_max: true },
    { class_name: "AGN", probability: 0.2, is_max: false },
    { class_name: "VS", probability: null, is_max: false }, // missing prob
  ],
};

beforeAll(() => {
  loadScript("src/static/js/radar.js");
  R = window.__radarTest;
});

describe("buildData", () => {
  test("labels follow class order; null probability becomes 0", () => {
    const d = R.buildData(GROUP);
    expect(d.labels).toEqual(["SN", "AGN", "VS"]);
    expect(d.datasets[0].data).toEqual([0.7, 0.2, 0]);
  });

  test("the max class is colored differently from the rest", () => {
    const d = R.buildData(GROUP);
    const [snColor, agnColor] = d.datasets[0].pointBackgroundColor;
    expect(snColor).not.toBe(agnColor); // is_max highlight
  });
});

describe("scaleForGroup — auto-zoom to the peak probability", () => {
  test("max = peak × 1.05 (headroom), step = max/5", () => {
    const s = R.scaleForGroup(GROUP);
    expect(s.max).toBeCloseTo(0.735, 6); // 0.7 × 1.05
    expect(s.stepSize).toBeCloseTo(0.147, 6);
  });

  test("never exceeds 1.0 (probabilities are bounded)", () => {
    const s = R.scaleForGroup({ classes: [{ probability: 0.99 }] });
    expect(s.max).toBeLessThanOrEqual(1);
  });

  test("degenerate all-zero group falls back to a full [0,1] axis", () => {
    expect(R.scaleForGroup({ classes: [{ probability: 0 }] })).toEqual({ max: 1, stepSize: 0.2 });
    expect(R.scaleForGroup({ classes: [] })).toEqual({ max: 1, stepSize: 0.2 });
  });
});

describe("formatTick", () => {
  test("0 stays '0'; 2 dp normally; 3 dp once below 0.1", () => {
    expect(R.formatTick(0)).toBe("0");
    expect(R.formatTick(0.5)).toBe("0.50");
    expect(R.formatTick(0.05)).toBe("0.050");
  });
});

describe("findGroup", () => {
  test("returns the matching key, else the first group", () => {
    const ctx = { groups: [GROUP, { key: "other" }] };
    expect(R.findGroup(ctx, "other").key).toBe("other");
    expect(R.findGroup(ctx, "missing").key).toBe(GROUP.key); // fallback
  });
});
