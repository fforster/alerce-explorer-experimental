"""Tests for shape_stamps_context: picker construction + URL building."""
from __future__ import annotations

from src.services.stamps import shape_stamps_context


def _ztf_det(mjd, fid, candid, has_stamp=True):
    return {"mjd": mjd, "fid": fid, "candid": candid, "has_stamp": has_stamp}


def _lsst_det(mjd, band_int, mid, has_stamp=True):
    return {
        "mjd": mjd, "band": band_int, "measurement_id": mid,
        "band_map": {"1": "g", "2": "r", "3": "i", "4": "z", "5": "y", "6": "u"},
        "has_stamp": has_stamp,
    }


def test_ztf_picker_sorted_mjd_desc_and_identifier_is_string():
    raw = {"detections": [
        _ztf_det(60001.0, 1, 111),
        _ztf_det(60005.0, 2, 222),
        _ztf_det(60003.0, 1, 333),
    ]}
    ctx = shape_stamps_context(raw, survey="ztf", oid="ZTF21abc", identifier=None)
    assert [d["identifier"] for d in ctx["detections"]] == ["222", "333", "111"]
    assert ctx["selected"]["identifier"] == "222"


def test_ztf_picker_drops_detections_without_stamp():
    raw = {"detections": [
        _ztf_det(60001.0, 1, 111, has_stamp=False),
        _ztf_det(60002.0, 2, 222, has_stamp=True),
    ]}
    ctx = shape_stamps_context(raw, survey="ztf", oid="x", identifier=None)
    assert [d["identifier"] for d in ctx["detections"]] == ["222"]


def test_selected_identifier_wins_when_provided():
    raw = {"detections": [
        _ztf_det(60005.0, 1, 111),
        _ztf_det(60001.0, 1, 222),
    ]}
    ctx = shape_stamps_context(raw, survey="ztf", oid="x", identifier="222")
    # 111 is the most recent but we asked for 222.
    assert ctx["selected"]["identifier"] == "222"


def test_selected_falls_back_to_most_recent_if_identifier_missing():
    raw = {"detections": [_ztf_det(60005.0, 1, 111), _ztf_det(60001.0, 1, 222)]}
    ctx = shape_stamps_context(raw, survey="ztf", oid="x", identifier="does-not-exist")
    assert ctx["selected"]["identifier"] == "111"


def test_ztf_stamp_urls_use_avro_host_and_type_names():
    raw = {"detections": [_ztf_det(60000.0, 1, 42)]}
    ctx = shape_stamps_context(raw, survey="ztf", oid="ZTF21abc", identifier=None)
    urls = ctx["stamp_urls"]
    assert set(urls) == {"science", "template", "difference"}
    assert "avro.alerce.online" in urls["science"]
    assert "oid=ZTF21abc" in urls["science"]
    assert "candid=42" in urls["science"]
    assert "type=science" in urls["science"]
    assert "type=template" in urls["template"]
    assert "type=difference" in urls["difference"]


def test_lsst_stamp_urls_use_cutout_names_and_measurement_id():
    raw = {"detections": [_lsst_det(60000.0, 2, 99999999999)]}
    ctx = shape_stamps_context(raw, survey="lsst", oid="LSST-1", identifier=None)
    urls = ctx["stamp_urls"]
    assert "api-lsst.alerce.online" in urls["science"]
    assert "measurement_id=99999999999" in urls["science"]
    assert "stamp_type=cutoutScience" in urls["science"]
    assert "stamp_type=cutoutTemplate" in urls["template"]
    assert "stamp_type=cutoutDifference" in urls["difference"]
    assert "file_format=fits" in urls["science"]


def test_lsst_band_letter_resolved_via_band_map():
    raw = {"detections": [_lsst_det(60000.0, 4, 1)]}  # band 4 → "z"
    ctx = shape_stamps_context(raw, survey="lsst", oid="x", identifier=None)
    assert ctx["detections"][0]["band"] == "z"


def test_empty_detections_yields_empty_picker_and_no_urls():
    ctx = shape_stamps_context({"detections": []}, survey="ztf", oid="x", identifier=None)
    assert ctx["detections"] == []
    assert ctx["selected"] is None
    assert ctx["stamp_urls"] == {}


def test_large_lsst_measurement_id_preserved_as_string():
    raw = {"detections": [_lsst_det(60000.0, 1, 9007199254740993)]}  # > 2**53
    ctx = shape_stamps_context(raw, survey="lsst", oid="x", identifier=None)
    assert ctx["selected"]["identifier"] == "9007199254740993"
