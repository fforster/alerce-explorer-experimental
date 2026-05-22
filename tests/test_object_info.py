"""Tests for shape_object_info — handles ZTF ↔ LSST field differences."""
from __future__ import annotations

from src.services.object_info import shape_object_info


def test_ztf_uses_ndet_and_derives_non_det():
    raw = {
        "oid": "ZTF21abc",
        "meanra": 180.0,
        "meandec": -30.0,
        "firstmjd": 60000.0,
        "lastmjd": 60100.0,
        "ndet": 12,
        "ncovhist": 50,
        "ndethist": 12,
        "corrected": True,
        "stellar": False,
    }
    info = shape_object_info(raw, survey="ztf")
    assert info["n_det"] == 12
    assert info["n_non_det"] == 38  # 50 - 12
    assert info["corrected"] is True
    assert info["stellar"] is False
    assert info["delta_mjd"] == 100.0


def test_ztf_missing_cov_hist_leaves_non_det_none():
    raw = {"oid": "ZTF21abc", "ndet": 5}
    info = shape_object_info(raw, survey="ztf")
    assert info["n_det"] == 5
    assert info["n_non_det"] is None


def test_lsst_uses_snake_case_fields():
    raw = {
        "oid": 123456789012345678,
        "meanra": 45.0,
        "meandec": -10.0,
        "firstmjd": 60000.0,
        "lastmjd": 60050.0,
        "n_det": 8,
        "n_non_det": 3,
        "n_forced": 50,
    }
    info = shape_object_info(raw, survey="lsst")
    assert info["oid"] == "123456789012345678"
    assert info["n_det"] == 8
    assert info["n_non_det"] == 3
    assert info["n_forced"] == 50
    # ZTF-only fields are None on LSST
    assert info["corrected"] is None
    assert info["stellar"] is None


def test_ra_dec_get_hms_dms_strings():
    raw = {"oid": "x", "meanra": 180.0, "meandec": -30.0}
    info = shape_object_info(raw, survey="ztf")
    assert info["ra_hms"] == "12:00:00.000"
    assert info["dec_dms"].startswith("-30:")


def test_archives_included():
    raw = {"oid": "ZTF21abc", "meanra": 180.0, "meandec": -30.0}
    info = shape_object_info(raw, survey="ztf")
    names = [link["name"] for link in info["archives"]]
    assert "SIMBAD" in names
    assert "DESI Legacy Survey DR11" in names


def test_delta_mjd_prefers_explicit_field():
    raw = {"oid": "x", "firstmjd": 60000.0, "lastmjd": 60100.0, "deltamjd": 42.0}
    info = shape_object_info(raw, survey="ztf")
    assert info["delta_mjd"] == 42.0


def test_delta_mjd_human_breaks_into_yr_d_h_m_s():
    # 365.25 d + 1 d + 1 h + 1 m + 1 s = 1 yr 1 d 1 h 1 m 1.00 s
    delta = 365.25 + 1.0 + 1.0 / 24.0 + 1.0 / 1440.0 + 1.0 / 86400.0
    raw = {"oid": "x", "firstmjd": 60000.0, "lastmjd": 60000.0 + delta}
    info = shape_object_info(raw, survey="ztf")
    assert info["delta_mjd_human"] == "1 yr 1 d 1 h 1 m 1.00 s"


def test_delta_mjd_human_strips_leading_zero_units():
    # 1 h 2 m 3 s — no yr/d, leading zero units omitted
    delta = 1.0 / 24.0 + 2.0 / 1440.0 + 3.0 / 86400.0
    raw = {"oid": "x", "firstmjd": 60000.0, "lastmjd": 60000.0 + delta}
    info = shape_object_info(raw, survey="ztf")
    assert info["delta_mjd_human"] == "1 h 2 m 3.00 s"


def test_delta_mjd_human_keeps_interior_zeros():
    # 1 d 0 h 0 m 1 s — interior zeros stay so the units stay readable
    delta = 1.0 + 1.0 / 86400.0
    raw = {"oid": "x", "firstmjd": 60000.0, "lastmjd": 60000.0 + delta}
    info = shape_object_info(raw, survey="ztf")
    assert info["delta_mjd_human"] == "1 d 0 h 0 m 1.00 s"


def test_delta_mjd_human_zero_shows_seconds_only():
    raw = {"oid": "x", "firstmjd": 60000.0, "lastmjd": 60000.0}
    info = shape_object_info(raw, survey="ztf")
    assert info["delta_mjd_human"] == "0.00 s"


def test_delta_mjd_human_none_when_missing():
    info = shape_object_info({"oid": "x"}, survey="ztf")
    assert info["delta_mjd_human"] is None


def test_missing_ra_dec_returns_none():
    raw = {"oid": "x"}
    info = shape_object_info(raw, survey="ztf")
    assert info["ra"] is None
    assert info["ra_hms"] is None
    assert info["dec_dms"] is None
    # Galactic / ecliptic are pure rotations — no ra/dec → no output.
    assert info["l_gal"] is None
    assert info["b_gal"] is None
    assert info["lambda_ecl"] is None
    assert info["beta_ecl"] is None


def test_galactic_ecliptic_fields_emitted_when_ra_dec_present():
    """Spot-check: Galactic Center RA/Dec should round-trip to (ℓ ≈ 0, b ≈ 0).
    Templates read these fields to prefill data-gal / data-ecl attributes,
    so shape_object_info is the natural place to compute them."""
    raw = {"oid": "x", "meanra": 266.40499, "meandec": -28.93617}
    info = shape_object_info(raw, survey="ztf")
    # Tolerances match the unit-test margin in test_coordinates.
    dl = min(abs(info["l_gal"]), abs(info["l_gal"] - 360.0))
    assert dl < 0.01
    assert abs(info["b_gal"]) < 0.01
    # Ecliptic values are finite and in range; numeric correctness is the
    # job of test_coordinates.
    assert 0.0 <= info["lambda_ecl"] < 360.0
    assert -90.0 <= info["beta_ecl"] <= 90.0
