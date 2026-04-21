import math

import pytest

from src.services.normalize import (
    AB_ZP_NJY,
    normalize_det,
    normalize_dets,
    ztf_mag_to_njy,
)


def test_ztf_mag_to_njy_at_zero_point():
    # mag == zero point → 1 nJy.
    assert ztf_mag_to_njy(AB_ZP_NJY) == pytest.approx(1.0)


def test_ztf_mag_to_njy_one_mag_brighter():
    # A source 2.5 mag brighter is 10x the flux.
    assert ztf_mag_to_njy(AB_ZP_NJY - 2.5) == pytest.approx(10.0)


def test_normalize_ztf_maps_fid_and_converts_flux():
    out = normalize_det(
        {
            "mjd": 60000.0,
            "fid": 1,
            "magpsf": 20.0,
            "sigmapsf": 0.05,
            "isdiffpos": "t",
            "candid": 1234567890123456789,
        },
        survey="ztf",
    )
    assert out["band"] == "g"
    assert out["mjd"] == 60000.0
    assert out["psf_flux"] == pytest.approx(ztf_mag_to_njy(20.0))
    assert out["e_psf_flux"] > 0
    assert out["isdiffpos"] == 1
    # candid preserved as string — int64-safe.
    assert out["candid"] == "1234567890123456789"


def test_normalize_ztf_fid_to_band_mapping():
    assert normalize_det({"fid": 1, "magpsf": 19.0}, "ztf")["band"] == "g"
    assert normalize_det({"fid": 2, "magpsf": 19.0}, "ztf")["band"] == "r"
    assert normalize_det({"fid": 3, "magpsf": 19.0}, "ztf")["band"] == "i"


def test_normalize_ztf_rejects_bad_ecorr_sentinel():
    out = normalize_det(
        {"fid": 1, "magpsf": 20.0, "magpsf_corr": 19.9, "sigmapsf_corr": 100.0},
        survey="ztf",
    )
    assert out["mag_corr"] == 19.9
    assert out["e_mag_corr"] is None


def test_normalize_ztf_rejects_mag_100_sentinel():
    # ZTF forced photometry uses mag == 100 as "no usable measurement"; the
    # normalizer must zero the flux fields rather than emit ~1e-27 nJy.
    out = normalize_det(
        {"fid": 1, "magpsf": 100.0, "sigmapsf": 0.1}, survey="ztf"
    )
    assert out["mag"] is None
    assert out["psf_flux"] is None
    assert out["e_psf_flux"] is None


def test_normalize_ztf_rejects_mag_corr_100_sentinel():
    # Same sentinel applied on the science-flux (corr) side.
    out = normalize_det(
        {"fid": 1, "magpsf": 19.5, "sigmapsf": 0.05,
         "magpsf_corr": 100.0, "sigmapsf_corr": 0.05},
        survey="ztf",
    )
    # Diff side survives.
    assert out["psf_flux"] is not None
    # Science side zeroed out.
    assert out["mag_corr"] is None
    assert out["science_flux"] is None
    assert out["e_science_flux"] is None


def test_normalize_ztf_isdiffpos_forms():
    for raw, expected in [(1, 1), (-1, -1), ("1", 1), ("-1", -1),
                          ("t", 1), ("f", -1), (True, 1), (False, -1)]:
        out = normalize_det({"fid": 1, "magpsf": 19.0, "isdiffpos": raw}, "ztf")
        assert out["isdiffpos"] == expected, f"raw={raw!r}"


def test_normalize_lsst_passthrough_and_mag_derivation():
    out = normalize_det(
        {
            "mjd": 60500.0,
            "band": "r",
            "psfFlux": 1.0,      # 1 nJy → mag = 31.4
            "psfFluxErr": 0.1,
            "candid": 9876543210987654321,
        },
        survey="lsst",
    )
    assert out["band"] == "r"
    assert out["psf_flux"] == 1.0
    assert out["mag"] == pytest.approx(AB_ZP_NJY)
    assert out["e_mag"] == pytest.approx((2.5 / math.log(10.0)) * 0.1)
    assert out["candid"] == "9876543210987654321"


def test_normalize_dets_batch():
    batch = [{"fid": 1, "magpsf": 19.0}, {"fid": 2, "magpsf": 20.0}]
    out = normalize_dets(batch, "ztf")
    assert [d["band"] for d in out] == ["g", "r"]


def test_normalize_unknown_survey_raises():
    with pytest.raises(ValueError):
        normalize_det({}, "panstarrs")
