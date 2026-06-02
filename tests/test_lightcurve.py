"""Tests for shape_lightcurve: bucketing, band ordering, unit handling."""
from __future__ import annotations

import math

from src.services.lightcurve import (
    _extract_multiband_period,
    _merge_ztf_v2_corr,
    shape_lightcurve,
)


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


def test_multiband_period_threads_into_shape():
    raw = {"detections": [_ztf_det(60000.0, 1, 20.0, candid="1")]}
    out = shape_lightcurve(raw, survey="ztf", multiband_period=1.234567)
    assert out["multiband_period"] == 1.234567


def test_multiband_period_defaults_to_none():
    """Surveys without a features endpoint (LSST) or objects without a
    period-finding score shouldn't surface the Fold button — None sentinel."""
    out = shape_lightcurve({"detections": []}, survey="lsst")
    assert out["multiband_period"] is None


def test_extract_multiband_period_finds_named_row():
    features = [
        {"name": "Amplitude", "value": 0.5, "fid": 1},
        {"name": "Multiband_period", "value": 2.345, "fid": 12},
        {"name": "Period_fit", "value": 0.001, "fid": 12},
    ]
    assert _extract_multiband_period(features) == 2.345


def test_extract_multiband_period_rejects_sentinels():
    # None / negative / NaN / non-numeric should all map to None so the
    # client hides the Fold button instead of folding at junk.
    assert _extract_multiband_period([{"name": "Multiband_period", "value": None}]) is None
    assert _extract_multiband_period([{"name": "Multiband_period", "value": -1.0}]) is None
    assert _extract_multiband_period([{"name": "Multiband_period", "value": float("nan")}]) is None
    assert _extract_multiband_period([{"name": "Multiband_period", "value": "n/a"}]) is None


def test_extract_multiband_period_missing_row_is_none():
    assert _extract_multiband_period([{"name": "Amplitude", "value": 0.5}]) is None
    assert _extract_multiband_period([]) is None
    assert _extract_multiband_period(None) is None
    assert _extract_multiband_period({"not": "a list"}) is None


def test_extract_multiband_period_picks_latest_version():
    """The feature endpoint bundles every extractor version ever run, each
    with its own Multiband_period. The API appends newest last, and the
    features-table modal defaults to the last version — the folding period
    must match that, or the user sees two different periods for one object
    (seen in the wild on ZTF20acuwouz)."""
    features = [
        {"name": "Multiband_period", "value": 0.465, "fid": 12,
         "version": "lc_classifier_1.2.1-P"},
        {"name": "Multiband_period", "value": 0.112, "fid": 12,
         "version": "lc_classifier_1.2.1-P-transitional"},
        {"name": "Multiband_period", "value": 1.0, "fid": 12, "version": "23.12.26a85"},
        {"name": "Multiband_period", "value": 10.22, "fid": 12, "version": "25.0.1a8"},
        {"name": "Multiband_period", "value": 10.16, "fid": 12, "version": "27.5.6"},
    ]
    assert _extract_multiband_period(features) == 10.16


def test_extract_multiband_period_hides_when_preferred_version_has_no_period():
    """If the preferred (pattern-ranked) version's Multiband_period is
    NaN/None, return None so the Fold button is hidden. Matches the
    features-table modal, which would render "—" for that version and the
    user shouldn't see a button folding at some other version's period."""
    features = [
        {"name": "Multiband_period", "value": 1.5, "version": "25.0.0"},
        {"name": "Multiband_period", "value": float("nan"), "version": "27.5.6"},
    ]
    # 27.5.6 ranks above 25.0.0 by (first, second) DESC; its value is NaN.
    assert _extract_multiband_period(features) is None


def test_extract_multiband_period_ignores_older_versions_with_larger_value():
    """Pattern-aware version picking beats simple "last-seen wins". An
    older `lc_classifier_1.2.1-P` value must not be picked over the
    newer `27.5.6` value (the ZTF20acuwouz case)."""
    features = [
        # Order intentionally scrambled to prove we don't rely on list order.
        {"name": "Multiband_period", "value": 10.16, "version": "27.5.6"},
        {"name": "Multiband_period", "value": 0.465, "version": "lc_classifier_1.2.1-P"},
        {"name": "Multiband_period", "value": 1.0, "version": "23.12.26a85"},
    ]
    assert _extract_multiband_period(features) == 10.16


def test_get_lightcurve_core_does_not_fetch_features_or_fp(monkeypatch):
    """Core LC fetch is detections-only — keeps the synchronous /htmx/lightcurve
    response fast (~2 s instead of ~15 s, which the slow TNS bridge dominated).
    Features and FP are now deferred via /htmx/lc_features and /htmx/lc_fp."""
    import asyncio

    from src.services import alerce_client, lightcurve as lc_mod

    calls: list[str] = []

    async def fake_get(url: str):
        calls.append(url)
        return {"detections": [_ztf_det(60000.0, 1, 20.0, candid="1")]}

    monkeypatch.setattr(alerce_client, "_get", fake_get)
    out = asyncio.run(lc_mod.get_lightcurve(survey="ztf", oid="ZTF20abcxyz"))
    assert out["n_det"] == 1
    # No FP, no features — those land via the deferred bundles.
    assert out["multiband_period"] is None
    assert out["parametric_fits"] == {}
    assert all("features" not in u for u in calls)
    assert all("v2" not in u for u in calls)


def test_get_lc_features_bundle_threads_period_and_fits(monkeypatch):
    """One features fetch populates both Multiband_period (Fold button) and
    the parametric-fits bundle. The "single fetch, two outputs" invariant
    is what keeps the periodogram pipeline-period reference line and the
    overlay picker from drifting apart from the modal."""
    import asyncio

    from src.services import alerce_client, lightcurve as lc_mod

    feature_calls = 0

    async def fake_get(url: str):
        nonlocal feature_calls
        if "features" in url:
            feature_calls += 1
            return [
                {"name": "Multiband_period", "value": 3.14, "fid": 12, "version": "27.5.6"},
                {"name": "SPM_A", "value": 0.5, "fid": 1, "version": "27.5.6"},
                {"name": "SPM_beta", "value": 0.3, "fid": 1, "version": "27.5.6"},
                {"name": "SPM_t0", "value": 5.0, "fid": 1, "version": "27.5.6"},
                {"name": "SPM_gamma", "value": 2.0, "fid": 1, "version": "27.5.6"},
                {"name": "SPM_tau_rise", "value": 1.0, "fid": 1, "version": "27.5.6"},
                {"name": "SPM_tau_fall", "value": 10.0, "fid": 1, "version": "27.5.6"},
            ]
        return {}

    monkeypatch.setattr(alerce_client, "_get", fake_get)
    out = asyncio.run(lc_mod.get_lc_features_bundle(survey="ztf", oid="ZTF20abcxyz"))
    assert feature_calls == 1
    assert out["multiband_period"] == 3.14
    assert out["parametric_fits"]["spm"]["g"]["A"] == 0.5


def test_get_lc_features_bundle_tolerates_failure(monkeypatch):
    """A broken features endpoint produces an empty bundle — Fold + overlay
    picker stay hidden, panel stays up."""
    import asyncio

    from src.services import alerce_client, lightcurve as lc_mod

    async def fake_get(url: str):
        raise RuntimeError("features endpoint down")

    monkeypatch.setattr(alerce_client, "_get", fake_get)
    out = asyncio.run(lc_mod.get_lc_features_bundle(survey="ztf", oid="ZTF20abcxyz"))
    assert out == {"multiband_period": None, "parametric_fits": {}}


def test_get_lc_features_bundle_empty_for_lsst(monkeypatch):
    """LSST has no features endpoint configured, so the bundle skips the
    fetch entirely and returns the same empty shape."""
    import asyncio

    from src.services import alerce_client, lightcurve as lc_mod

    called = False

    async def fake_get(url: str):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(alerce_client, "_get", fake_get)
    out = asyncio.run(lc_mod.get_lc_features_bundle(survey="lsst", oid="lsst-oid-1"))
    assert out == {"multiband_period": None, "parametric_fits": {}}
    assert not called


def test_get_lc_fp_bundle_reshapes_with_v2_corr_merge(monkeypatch):
    """The deferred FP fetch re-fetches the v1 LC alongside FP and re-merges
    v2 mag_corr — that's the only path to valid ZTF sci-mode error bars."""
    import asyncio

    from src.services import alerce_client, lightcurve as lc_mod

    async def fake_get(url: str):
        if "v2" in url:
            return {
                "detections": [{"candid": "1", "mag_corr": 19.5,
                                "e_mag_corr_ext": 0.04}],
                "forced_photometry": [],
            }
        # ZTF v1 lightcurve
        return {"detections": [
            _ztf_det(60000.0, 1, 20.0, sigmapsf=100.0, candid="1"),
        ]}

    monkeypatch.setattr(alerce_client, "_get", fake_get)
    out = asyncio.run(lc_mod.get_lc_fp_bundle(survey="ztf", oid="ZTF20abcxyz"))
    # v2 mag_corr/e_mag_corr_ext made it through to the band's e_sci_flux.
    g_pt = out["bands"][0]["points"][0]
    assert g_pt["e_sci_flux"] is not None
    assert g_pt["e_sci_flux"] > 0


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


# ── Cross-survey bundle (LSST ↔ ZTF photometry overlay) ────────────────────

def test_get_lc_xsurvey_bundle_lsst_to_ztf(monkeypatch):
    """LSST primary → conesearch ZTF → return ZTF detections shaped as a
    standard bundle, with the matched ZTF oid stamped on so the client can
    label the legend group."""
    import asyncio

    from src.services import lightcurve as lc_mod
    from src.services import object_info as object_info_mod
    from src.services import object_list as object_list_mod

    async def fake_object_info(*, survey: str, oid: str):
        assert (survey, oid) == ("lsst", "313888627082919999")
        return {"ra": 150.17067, "dec": 1.36823}

    async def fake_get_objects_list(**kwargs):
        # Conesearch on the *other* survey (ZTF) at the LSST coords.
        assert kwargs["survey"] == "ztf"
        assert kwargs["radius"] == lc_mod.XSURVEY_RADIUS_ARCSEC
        return {"items": [{"oid": "ZTF17aabhbva"}]}

    async def fake_fp_bundle(*, survey: str, oid: str):
        # Pretend the matched ZTF object has one g detection.
        assert (survey, oid) == ("ztf", "ZTF17aabhbva")
        return {
            "survey": "ztf",
            "bands": [{"name": "g", "points": [{
                "mjd": 60000.0, "flux": 1000.0, "e_flux": 50.0,
                "sci_flux": None, "e_sci_flux": None,
                "identifier": "1", "has_stamp": False, "isdiffpos": 1,
            }]}],
            "forced_phot_bands": [],
            "n_det": 1, "n_fp": 0, "has_science_flux": True,
            "multiband_period": None, "parametric_fits": {},
        }

    monkeypatch.setattr(object_info_mod, "get_object_info", fake_object_info)
    monkeypatch.setattr(object_list_mod, "get_objects_list", fake_get_objects_list)
    monkeypatch.setattr(lc_mod, "get_lc_fp_bundle", fake_fp_bundle)

    out = asyncio.run(
        lc_mod.get_lc_xsurvey_bundle(survey="lsst", oid="313888627082919999")
    )
    assert out is not None
    assert out["survey"] == "ztf"
    assert out["oid"] == "ZTF17aabhbva"
    assert out["bands"][0]["name"] == "g"


def test_get_lc_xsurvey_bundle_ztf_to_lsst(monkeypatch):
    """Same in reverse: ZTF primary picks LSST as the cone-search target."""
    import asyncio

    from src.services import lightcurve as lc_mod
    from src.services import object_info as object_info_mod
    from src.services import object_list as object_list_mod

    async def fake_object_info(*, survey: str, oid: str):
        return {"ra": 150.17067, "dec": 1.36823}

    seen_other = []

    async def fake_get_objects_list(**kwargs):
        seen_other.append(kwargs["survey"])
        return {"items": [{"oid": "313888627082919999"}]}

    async def fake_fp_bundle(*, survey: str, oid: str):
        return {
            "survey": "lsst",
            "bands": [{"name": "r", "points": [{
                "mjd": 60005.0, "flux": 800.0, "e_flux": 40.0,
                "sci_flux": 7000.0, "e_sci_flux": 50.0,
                "identifier": "m1", "has_stamp": True, "isdiffpos": None,
            }]}],
            "forced_phot_bands": [],
            "n_det": 1, "n_fp": 0, "has_science_flux": True,
            "multiband_period": None, "parametric_fits": {},
        }

    monkeypatch.setattr(object_info_mod, "get_object_info", fake_object_info)
    monkeypatch.setattr(object_list_mod, "get_objects_list", fake_get_objects_list)
    monkeypatch.setattr(lc_mod, "get_lc_fp_bundle", fake_fp_bundle)

    out = asyncio.run(
        lc_mod.get_lc_xsurvey_bundle(survey="ztf", oid="ZTF17aabhbva")
    )
    assert seen_other == ["lsst"]
    assert out["survey"] == "lsst"
    assert out["oid"] == "313888627082919999"


def test_get_lc_xsurvey_bundle_returns_none_when_no_coords(monkeypatch):
    """object_info without ra/dec ⇒ no conesearch, no bundle."""
    import asyncio

    from src.services import lightcurve as lc_mod
    from src.services import object_info as object_info_mod
    from src.services import object_list as object_list_mod

    list_called = False

    async def fake_object_info(*, survey: str, oid: str):
        return {"ra": None, "dec": None}

    async def fake_get_objects_list(**kwargs):
        nonlocal list_called
        list_called = True
        return {"items": []}

    monkeypatch.setattr(object_info_mod, "get_object_info", fake_object_info)
    monkeypatch.setattr(object_list_mod, "get_objects_list", fake_get_objects_list)

    out = asyncio.run(
        lc_mod.get_lc_xsurvey_bundle(survey="lsst", oid="x")
    )
    assert out is None
    assert not list_called


def test_get_lc_xsurvey_bundle_returns_none_when_no_match(monkeypatch):
    """Empty conesearch result ⇒ None (no bundle, no FP fetch)."""
    import asyncio

    from src.services import lightcurve as lc_mod
    from src.services import object_info as object_info_mod
    from src.services import object_list as object_list_mod

    fp_called = False

    async def fake_object_info(*, survey: str, oid: str):
        return {"ra": 10.0, "dec": 20.0}

    async def fake_get_objects_list(**kwargs):
        return {"items": []}

    async def fake_fp_bundle(*, survey: str, oid: str):
        nonlocal fp_called
        fp_called = True
        return {}

    monkeypatch.setattr(object_info_mod, "get_object_info", fake_object_info)
    monkeypatch.setattr(object_list_mod, "get_objects_list", fake_get_objects_list)
    monkeypatch.setattr(lc_mod, "get_lc_fp_bundle", fake_fp_bundle)

    out = asyncio.run(
        lc_mod.get_lc_xsurvey_bundle(survey="lsst", oid="x")
    )
    assert out is None
    assert not fp_called


def test_get_lc_xsurvey_bundle_skips_empty_match(monkeypatch):
    """Match with zero detections + zero FP isn't worth a legend group —
    return None so the legend stays clean."""
    import asyncio

    from src.services import lightcurve as lc_mod
    from src.services import object_info as object_info_mod
    from src.services import object_list as object_list_mod

    async def fake_object_info(*, survey: str, oid: str):
        return {"ra": 10.0, "dec": 20.0}

    async def fake_get_objects_list(**kwargs):
        return {"items": [{"oid": "ZTF99stub"}]}

    async def fake_fp_bundle(*, survey: str, oid: str):
        return {"survey": "ztf", "bands": [], "forced_phot_bands": [],
                "n_det": 0, "n_fp": 0}

    monkeypatch.setattr(object_info_mod, "get_object_info", fake_object_info)
    monkeypatch.setattr(object_list_mod, "get_objects_list", fake_get_objects_list)
    monkeypatch.setattr(lc_mod, "get_lc_fp_bundle", fake_fp_bundle)

    out = asyncio.run(
        lc_mod.get_lc_xsurvey_bundle(survey="lsst", oid="x")
    )
    assert out is None


def test_assemble_gp_series_windows_forced_photometry():
    """Detections are always kept; forced photometry only within
    GP_FP_WINDOW_DAYS of the global detection span. Det + FP for the same band
    merge into one group (the GP treats both as difference flux)."""
    from src.services.lightcurve import _assemble_gp_series, GP_FP_WINDOW_DAYS

    assert GP_FP_WINDOW_DAYS == 30.0
    bundle = {
        "survey": "ztf",
        "bands": [{"name": "g", "points": [
            {"mjd": 100.0, "flux": 500.0, "e_flux": 40.0},
            {"mjd": 130.0, "flux": 900.0, "e_flux": 40.0},
        ]}],
        "forced_phot_bands": [{"name": "g", "points": [
            {"mjd": 50.0, "flux": 5.0, "e_flux": 10.0},    # 50 d before first → out
            {"mjd": 75.0, "flux": 8.0, "e_flux": 10.0},    # 25 d before → in
            {"mjd": 115.0, "flux": 700.0, "e_flux": 30.0}, # between dets → in
            {"mjd": 155.0, "flux": 50.0, "e_flux": 20.0},  # 25 d after last → in
            {"mjd": 200.0, "flux": 2.0, "e_flux": 10.0},   # 70 d after → out
        ]}],
    }
    series = _assemble_gp_series([("ztf", bundle)])
    assert len(series) == 1
    g = series[0]
    assert g["band"] == "g" and g["surveys"] == ["ztf"]
    assert sorted(g["mjd"]) == [75.0, 100.0, 115.0, 130.0, 155.0]


def test_assemble_gp_series_skips_bands_without_wavelength():
    """An `unknown` band has no central wavelength → it can't sit on the
    kernel's wavelength axis and is dropped."""
    from src.services.lightcurve import _assemble_gp_series

    bundle = {
        "survey": "ztf",
        "bands": [
            {"name": "g", "points": [{"mjd": 100.0, "flux": 500.0, "e_flux": 40.0}]},
            {"name": "unknown", "points": [{"mjd": 100.0, "flux": 5.0, "e_flux": 1.0}]},
        ],
        "forced_phot_bands": [],
    }
    series = _assemble_gp_series([("ztf", bundle)])
    assert [g["band"] for g in series] == ["g"]


def test_assemble_gp_series_pools_same_band_across_telescopes():
    """The same band letter from two telescopes is pooled into one group (ZTF g
    + LSST g → a single `g`), recording both contributing surveys and averaging
    their central wavelengths. Distinct letters would stay separate."""
    from src.services.lightcurve import _assemble_gp_series
    from src.services.survey_config import SC

    lsst = {"survey": "lsst", "forced_phot_bands": [],
            "bands": [{"name": "g", "points": [{"mjd": 100.0, "flux": 500.0, "e_flux": 40.0}]}]}
    ztf = {"survey": "ztf", "forced_phot_bands": [],
           "bands": [{"name": "g", "points": [{"mjd": 101.0, "flux": 480.0, "e_flux": 35.0}]}]}
    series = _assemble_gp_series([("lsst", lsst), ("ztf", ztf)])

    # One pooled group, both surveys, both points.
    assert len(series) == 1
    g = series[0]
    assert g["band"] == "g"
    assert g["surveys"] == ["lsst", "ztf"]
    assert sorted(g["mjd"]) == [100.0, 101.0]
    # Wavelength is the mean of the two telescopes' g central wavelengths.
    expected = (SC("lsst").band_wavelengths["g"] + SC("ztf").band_wavelengths["g"]) / 2
    assert g["lambda_eff"] == expected


def test_assemble_gp_series_uses_science_flux_when_requested():
    """A folded fit (science=True) reads sci_flux/e_sci_flux and drops epochs
    that have only difference flux."""
    from src.services.lightcurve import _assemble_gp_series

    bundle = {
        "survey": "ztf",
        "bands": [{"name": "g", "points": [
            {"mjd": 100.0, "flux": 500.0, "e_flux": 40.0, "sci_flux": 9000.0, "e_sci_flux": 60.0},
            {"mjd": 101.0, "flux": 480.0, "e_flux": 35.0, "sci_flux": None, "e_sci_flux": None},
        ]}],
        "forced_phot_bands": [],
    }
    sci = _assemble_gp_series([("ztf", bundle)], science=True)
    assert len(sci) == 1
    g = sci[0]
    # Only the epoch with sci_flux survives, and the value is the science flux.
    assert g["mjd"] == [100.0]
    assert g["flux"] == [9000.0]
    assert g["eflux"] == [60.0]
    # Difference-flux assembly (default) keeps both epochs at their diff flux.
    diff = _assemble_gp_series([("ztf", bundle)])
    assert sorted(diff[0]["flux"]) == [480.0, 500.0]
