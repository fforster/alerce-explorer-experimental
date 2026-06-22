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


def test_ztf_extra_params_drops_classifier_version():
    # ZTF's /objects endpoint silently returns zero rows when given a
    # classifier_version (the form's "Latest" resolves lc_classifier to a
    # concrete version) instead of ignoring the unknown filter — so we must
    # strip it. LSST keeps it (see test below).
    out = SC("ztf").extra_params({
        "classifier": "lc_classifier",
        "classifier_version": "hierarchical_random_forest_1.0.0",
    })
    assert "classifier_version" not in out
    assert out["classifier"] == "lc_classifier"


def test_ztf_extra_params_sorts_by_probability_desc():
    out = SC("ztf").extra_params({})
    assert out["order_by"] == "probability"
    assert out["order_mode"] == "DESC"


def test_lsst_extra_params_passthrough_and_drops_none():
    out = SC("lsst").extra_params({
        "class_name": "AGN",
        "n_det": 10,
        "probability": None,
    })
    assert out == {
        "class_name": "AGN",
        "n_det": 10,
        "survey": "lsst",
        "order_by": "probability",
        "order_mode": "DESC",
    }


def test_band_sets_differ():
    assert SC("lsst").bands == ("u", "g", "r", "i", "z", "y")
    assert SC("ztf").bands == ("g", "r", "i")


def test_fp_url_builders():
    assert "forced-photometry" in SC("lsst").fp_url("170226393632735260")
    assert "oid=170226393632735260" in SC("lsst").fp_url("170226393632735260")
    ztf_url = SC("ztf").fp_url("ZTF21abc")
    assert "v2/lightcurve/lightcurve/ZTF21abc" in ztf_url
    assert "survey_id=ztf" in ztf_url


def test_extinction_coefficients_match_fitzpatrick():
    assert SC("lsst").extinction_r["r"] == pytest.approx(2.273)
    assert SC("ztf").extinction_r["g"] == pytest.approx(3.237)
