"""Tests for shape_lightcurve: bucketing, band ordering, unit handling."""
from __future__ import annotations

import math

from src.services.lightcurve import _merge_ztf_v2_corr, shape_lightcurve


def _ztf_det(mjd, fid, magpsf, sigmapsf=0.05, candid="100"):
    return {
        "mjd": mjd, "fid": fid, "magpsf": magpsf,
        "sigmapsf": sigmapsf, "candid": candid, "isdiffpos": 1,
    }


def _lsst_det(mjd, band_int, flux, flux_err=10.0, measurement_id=1):
    return {
        "mjd": mjd, "band": band_int,
        "band_map": {"1": "g", "2": "r", "3": "i", "4": "z", "5": "y", "6": "u"},
        "psfFlux": flux, "psfFluxErr": flux_err,
        "measurement_id": measurement_id,
    }


def test_ztf_bucket_by_band_and_convert_mag_to_njy():
    raw = {"detections": [
        _ztf_det(60000.0, 1, 20.0, candid="1"),
        _ztf_det(60001.0, 2, 19.0, candid="2"),
        _ztf_det(60002.0, 1, 19.5, candid="3"),
    ]}
    out = shape_lightcurve(raw, survey="ztf")
    band_names = [b["name"] for b in out["bands"]]
    # ZTF bands appear in survey canonical order g, r, i
    assert band_names == ["g", "r"]
    assert out["n_det"] == 3
    # mag 20 → 10^((31.4-20)/2.5) ≈ 36307.8 nJy
    g_first = out["bands"][0]["points"][0]
    assert math.isclose(g_first["flux"], 10 ** ((31.4 - 20.0) / 2.5), rel_tol=1e-9)


def test_ztf_points_sorted_by_mjd():
    raw = {"detections": [
        _ztf_det(60005.0, 1, 20.0, candid="b"),
        _ztf_det(60001.0, 1, 20.0, candid="a"),
    ]}
    out = shape_lightcurve(raw, survey="ztf")
    assert [p["mjd"] for p in out["bands"][0]["points"]] == [60001.0, 60005.0]


def test_ztf_drops_rows_missing_mag_or_mjd():
    raw = {"detections": [
        _ztf_det(60000.0, 1, 20.0, candid="1"),
        {"mjd": 60001.0, "fid": 2, "candid": "2"},         # no magpsf
        {"fid": 1, "magpsf": 20.0, "candid": "3"},          # no mjd
    ]}
    out = shape_lightcurve(raw, survey="ztf")
    assert out["n_det"] == 1


def test_lsst_passes_flux_through_and_resolves_band_letter():
    raw = {"detections": [
        _lsst_det(60000.0, 1, 1234.5),
        _lsst_det(60001.0, 4, 500.0),
    ]}
    out = shape_lightcurve(raw, survey="lsst")
    # LSST canonical order is u,g,r,i,z,y so g comes before z
    band_names = [b["name"] for b in out["bands"]]
    assert band_names == ["g", "z"]
    assert out["bands"][0]["points"][0]["flux"] == 1234.5
    assert out["bands"][1]["points"][0]["flux"] == 500.0


def test_empty_detections_returns_zero_count():
    out = shape_lightcurve({"detections": []}, survey="lsst")
    assert out["n_det"] == 0
    assert out["bands"] == []
    assert out["n_fp"] == 0
    assert out["forced_phot_bands"] == []


def test_identifier_preserved_as_string():
    raw = {"detections": [_ztf_det(60000.0, 1, 20.0, candid=12345)]}
    out = shape_lightcurve(raw, survey="ztf")
    p = out["bands"][0]["points"][0]
    assert p["identifier"] == "12345"


def test_has_stamp_flag_propagates_from_upstream():
    raw = {"detections": [
        {**_ztf_det(60000.0, 1, 20.0, candid="1"), "has_stamp": True},
        {**_ztf_det(60001.0, 1, 20.0, candid="2"), "has_stamp": False},
        _ztf_det(60002.0, 1, 20.0, candid="3"),  # has_stamp missing → False
    ]}
    out = shape_lightcurve(raw, survey="ztf")
    flags = [p["has_stamp"] for p in out["bands"][0]["points"]]
    assert flags == [True, False, False]


def test_lsst_identifier_uses_measurement_id():
    raw = {"detections": [_lsst_det(60000.0, 1, 1000.0, measurement_id=9123456789012345)]}
    out = shape_lightcurve(raw, survey="lsst")
    assert out["bands"][0]["points"][0]["identifier"] == "9123456789012345"


def test_ztf_sci_flux_propagated_from_mag_corr():
    raw = {"detections": [{
        "mjd": 60000.0, "fid": 1,
        "magpsf": 20.0, "sigmapsf": 0.05,
        "magpsf_corr": 19.8, "sigmapsf_corr": 0.04,
        "candid": "1", "isdiffpos": 1,
    }]}
    out = shape_lightcurve(raw, survey="ztf")
    p = out["bands"][0]["points"][0]
    assert p["sci_flux"] == math.pow(10.0, (31.4 - 19.8) / 2.5)
    assert p["e_sci_flux"] is not None and p["e_sci_flux"] > 0


def test_ztf_sci_flux_none_when_mag_corr_missing():
    raw = {"detections": [_ztf_det(60000.0, 1, 20.0, candid="1")]}
    out = shape_lightcurve(raw, survey="ztf")
    p = out["bands"][0]["points"][0]
    assert p["sci_flux"] is None
    assert p["e_sci_flux"] is None


def test_has_science_flux_reflects_survey_capability():
    # Both surveys publish science (absolute) flux — ZTF via magpsf_corr, LSST
    # via scienceFlux — so the toggle is available on both.
    raw = {"detections": [_ztf_det(60000.0, 1, 20.0, candid="1")]}
    assert shape_lightcurve(raw, survey="ztf")["has_science_flux"] is True
    raw_lsst = {"detections": [_lsst_det(60000.0, 1, 1000.0)]}
    assert shape_lightcurve(raw_lsst, survey="lsst")["has_science_flux"] is True


def test_lsst_fp_buckets_into_forced_phot_bands():
    raw = {"detections": [_lsst_det(60000.0, 1, 1000.0)]}
    fp = [
        _lsst_det(59999.0, 1, 50.0, measurement_id=10),
        _lsst_det(59998.0, 2, 30.0, measurement_id=11),
    ]
    out = shape_lightcurve(raw, survey="lsst", fp_raw=fp)
    assert out["n_fp"] == 2
    fp_names = [b["name"] for b in out["forced_phot_bands"]]
    assert fp_names == ["g", "r"]
    # Detections are independent of FP.
    assert out["n_det"] == 1
    assert [b["name"] for b in out["bands"]] == ["g"]


def test_ztf_fp_converts_mag_to_njy_same_as_detections():
    raw = {"detections": []}
    fp = [_ztf_det(60000.0, 1, 20.0, candid=999)]
    out = shape_lightcurve(raw, survey="ztf", fp_raw=fp)
    import math as _m
    assert out["n_fp"] == 1
    assert _m.isclose(
        out["forced_phot_bands"][0]["points"][0]["flux"],
        10 ** ((31.4 - 20.0) / 2.5),
        rel_tol=1e-9,
    )


def test_fp_none_is_same_as_no_fp():
    raw = {"detections": [_lsst_det(60000.0, 1, 1000.0)]}
    a = shape_lightcurve(raw, survey="lsst", fp_raw=None)
    b = shape_lightcurve(raw, survey="lsst", fp_raw=[])
    assert a == b
    assert a["n_fp"] == 0


def test_merge_ztf_v2_corr_overrides_sentinel_sigmapsf():
    """v1's 100.0 sigmapsf_corr sentinel blocks sci-mode error bars; the v2
    lightcurve carries the real correction and should win the join."""
    v1 = [{
        "mjd": 60000.0, "fid": 1,
        "magpsf": 20.0, "sigmapsf": 0.05,
        "magpsf_corr": 19.8, "sigmapsf_corr": 100.0,  # sentinel → would reject
        "candid": "abc123", "isdiffpos": 1,
    }]
    fp_resp = {
        "detections": [
            {"candid": "abc123", "mag_corr": 19.7, "e_mag_corr": 0.04},
        ],
        "forced_photometry": [],
    }
    merged = _merge_ztf_v2_corr(list(v1), fp_resp)
    assert merged[0]["sigmapsf_corr"] == 0.04
    assert merged[0]["magpsf_corr"] == 19.7


def test_merge_ztf_v2_corr_prefers_e_mag_corr_ext():
    """On ALeRCE ZTF v2, `e_mag_corr` itself is often the 100.0 sentinel and
    `e_mag_corr_ext` carries the real error — checked against live data for
    ZTF18aaylgug. Take _ext when both are present."""
    v1 = [{
        "mjd": 60000.0, "fid": 2, "magpsf": 19.99, "sigmapsf": 0.15,
        "magpsf_corr": 17.55, "sigmapsf_corr": 100.0,
        "candid": "527220614415010003", "isdiffpos": -1,
    }]
    fp_resp = {"detections": [{
        "candid": "527220614415010003",
        "mag_corr": 17.55,
        "e_mag_corr": 100.0,           # sentinel again
        "e_mag_corr_ext": 0.016424736,  # the value we want
    }]}
    merged = _merge_ztf_v2_corr(list(v1), fp_resp)
    assert merged[0]["sigmapsf_corr"] == 0.016424736


def test_merge_ztf_v2_corr_joins_by_candid_string():
    """Candid comparison uses string conversion so int/str shapes both work
    (belt-and-braces for the LSST-OID-safety pattern, though ZTF candids
    fit in 64 bits)."""
    v1 = [{"mjd": 1.0, "fid": 1, "magpsf": 20.0,
           "magpsf_corr": 20.0, "sigmapsf_corr": 100.0, "candid": 12345}]
    fp_resp = {"detections": [
        {"candid": "12345", "mag_corr": 19.9, "e_mag_corr": 0.03},
    ]}
    merged = _merge_ztf_v2_corr(list(v1), fp_resp)
    assert merged[0]["sigmapsf_corr"] == 0.03


def test_merge_ztf_v2_corr_noops_on_missing_v2_match():
    """Detections with no v2 counterpart keep their v1 fields untouched
    (including the sentinel — downstream normalization still rejects it)."""
    v1 = [{"mjd": 1.0, "fid": 1, "magpsf": 20.0,
           "magpsf_corr": 20.0, "sigmapsf_corr": 100.0, "candid": "only-in-v1"}]
    fp_resp = {"detections": [
        {"candid": "something-else", "mag_corr": 19.9, "e_mag_corr": 0.03},
    ]}
    merged = _merge_ztf_v2_corr(list(v1), fp_resp)
    assert merged[0]["sigmapsf_corr"] == 100.0


def test_merge_ztf_v2_corr_noops_on_bad_fp_shape():
    v1 = [{"mjd": 1.0, "fid": 1, "magpsf": 20.0, "candid": "x"}]
    assert _merge_ztf_v2_corr(v1, None) is v1
    assert _merge_ztf_v2_corr(v1, []) is v1
    assert _merge_ztf_v2_corr(v1, {"detections": "not a list"}) is v1


def test_shape_lightcurve_picks_up_merged_e_sci_flux_end_to_end():
    """Full flow: bad v1 sigmapsf_corr + good v2 e_mag_corr → e_sci_flux
    makes it through the pipeline so the client-side error-bar plugin has
    something to draw in sci mode."""
    from src.services.lightcurve import get_lightcurve  # noqa: F401

    # Exercise the merge via shape_lightcurve directly (get_lightcurve is
    # network-bound). The route-level merge is covered separately.
    v1 = [{
        "mjd": 60000.0, "fid": 1,
        "magpsf": 20.0, "sigmapsf": 0.05,
        "magpsf_corr": 19.8, "sigmapsf_corr": 100.0,
        "candid": "cand-1", "isdiffpos": 1,
    }]
    fp_resp = {
        "detections": [{"candid": "cand-1", "mag_corr": 19.8, "e_mag_corr": 0.04}],
        "forced_photometry": [],
    }
    merged_v1 = _merge_ztf_v2_corr(list(v1), fp_resp)
    out = shape_lightcurve({"detections": merged_v1}, survey="ztf")
    p = out["bands"][0]["points"][0]
    assert p["e_sci_flux"] is not None and p["e_sci_flux"] > 0
