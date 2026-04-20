import pytest

from src.services.survey_config import SC


def test_sc_returns_correct_survey():
    assert SC("lsst").name == "lsst"
    assert SC("ztf").name == "ztf"


def test_sc_unknown_survey_raises():
    with pytest.raises(ValueError):
        SC("panstarrs")


def test_ztf_extra_params_remaps_field_names():
    out = SC("ztf").extra_params({
        "survey": "ztf",
        "class_name": "SN",
        "n_det": 5,
        "probability": 0.9,
    })
    assert "class" in out and out["class"] == "SN"
    assert "ndet" in out and out["ndet"] == 5
    assert "survey" not in out
    assert out["ranking"] == 1
    assert out["probability"] == 0.9


def test_lsst_extra_params_passthrough_and_drops_none():
    out = SC("lsst").extra_params({
        "class_name": "AGN",
        "n_det": 10,
        "probability": None,
    })
    # LSST list_objects endpoint expects `survey` as a query param.
    assert out == {"class_name": "AGN", "n_det": 10, "survey": "lsst"}


def test_band_sets_differ():
    assert SC("lsst").bands == ("u", "g", "r", "i", "z", "y")
    assert SC("ztf").bands == ("g", "r", "i")


def test_extinction_coefficients_match_fitzpatrick():
    assert SC("lsst").extinction_r["r"] == pytest.approx(2.273)
    assert SC("ztf").extinction_r["g"] == pytest.approx(3.237)
