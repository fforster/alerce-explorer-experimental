"""Tests for the clipped-cutout reference-pixel reconstruction.

The numbers in the "real epoch" tests come from ZTF26abngxfo, which is what
surfaced the bug: candid 3510493201915015030 lands 16 px from the x edge of its
CCD quadrant, so its cutout arrives 48x63 instead of 63x63 and the source sits
~7 px off the image's geometric centre. Its sibling epoch is unclipped and acts
as the regression control.
"""
from __future__ import annotations

import asyncio

from src.services import alerce_client
from src.services import avro as avro_service
from src.services import stamp_center as stamp_center_service
from src.services.stamp_center import clipped_axis
from src.services.survey_config import SC


def _run(coro):
    return asyncio.run(coro)


# ZTF quadrant geometry, mirrored from SURVEY_CONFIG.
QX, QY, FULL = 3072, 3080, 63


def test_real_clipped_epoch_reproduces_observed_size():
    """The x axis clips at the high edge: 63 -> 48, alert 7 px off centre."""
    width, crpix = clipped_axis(3055.591796875, QX, FULL)
    assert width == 48  # matches the observed NAXIS1
    assert crpix == 3055.591796875 - 3025 + 1
    # Geometric centre would be 24.5 — this is the error being corrected.
    assert crpix - (width + 1) / 2 > 7.0


def test_real_unclipped_epoch_is_the_control():
    """Same object, different epoch: nothing clips, so CRPIX is the centre."""
    width, crpix = clipped_axis(689.23046875, QX, FULL)
    assert width == 63
    assert abs(crpix - (width + 1) / 2) < 0.5  # sub-pixel, i.e. centred


def test_real_epoch_y_axis_unclipped():
    width, crpix = clipped_axis(2209.19970703125, QY, FULL)
    assert width == 63
    assert abs(crpix - (width + 1) / 2) < 0.5


def test_low_edge_clip():
    """The reproduction case only exercised the HIGH edge; the low edge clamps
    `lo` to 1 instead, which is a different branch."""
    width, crpix = clipped_axis(5.4, QX, FULL)
    # centre=5, wanted [-26..36] -> clipped to [1..36]
    assert width == 36
    assert crpix == 5.4  # 5.4 - 1 + 1
    # The alert is far LEFT of the geometric centre here (opposite sign to the
    # high-edge case), which is exactly what a naive centre-anchor gets wrong.
    assert crpix - (width + 1) / 2 < -13.0


def test_both_axes_clipped_at_a_corner():
    wx, cx = clipped_axis(3060.0, QX, FULL)
    wy, cy = clipped_axis(4.0, QY, FULL)
    assert (wx, wy) == (44, 35)
    assert (cx, cy) == (3060.0 - 3029 + 1, 4.0)


def test_exactly_centred_is_the_geometric_centre():
    width, crpix = clipped_axis(1000.0, QX, FULL)
    assert width == FULL
    assert crpix == (FULL + 1) / 2


def test_survey_config_carries_ztf_geometry():
    ztf = SC("ztf")
    assert ztf.stamp_full_size == 63
    assert ztf.detector_shape == (3072, 3080)


def test_survey_config_lsst_has_no_synthetic_geometry():
    """LSST ships a real WCS, so reconstruction is neither possible nor needed."""
    lsst = SC("lsst")
    assert lsst.stamp_full_size is None
    assert lsst.detector_shape is None


def test_lsst_short_circuits_without_any_upstream_call(monkeypatch):
    called = False

    async def fake_get(url):
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(alerce_client, "_get", fake_get)
    out = _run(stamp_center_service.get_stamp_center(
        survey="lsst", oid="123", candid="456",
    ))
    assert out["available"] is False
    assert called is False


def test_happy_path_returns_crpix_and_predicted_size(monkeypatch):
    async def fake_avro(*, oid, candid, survey):
        return {
            "available": True,
            "rows": [
                {"name": "xpos", "value": 3055.591796875},
                {"name": "ypos", "value": 2209.19970703125},
            ],
        }

    monkeypatch.setattr(avro_service, "get_avro_info", fake_avro)
    out = _run(stamp_center_service.get_stamp_center(
        survey="ztf", oid="ZTF26abngxfo", candid="3510493201915015030",
    ))
    assert out["available"] is True
    # nx/ny let the client self-check the reconstruction against the bytes it
    # actually received before shifting anything.
    assert (out["nx"], out["ny"]) == (48, 63)
    assert out["crpix1"] == 3055.591796875 - 3025 + 1


def test_missing_xpos_degrades_rather_than_raising(monkeypatch):
    async def fake_avro(*, oid, candid, survey):
        return {"available": True, "rows": [{"name": "magpsf", "value": 19.1}]}

    monkeypatch.setattr(avro_service, "get_avro_info", fake_avro)
    out = _run(stamp_center_service.get_stamp_center(
        survey="ztf", oid="x", candid="y",
    ))
    assert out["available"] is False
    assert "xpos" in out["reason"]


def test_non_numeric_xpos_degrades(monkeypatch):
    async def fake_avro(*, oid, candid, survey):
        return {
            "available": True,
            "rows": [
                {"name": "xpos", "value": "null"},
                {"name": "ypos", "value": 100.0},
            ],
        }

    monkeypatch.setattr(avro_service, "get_avro_info", fake_avro)
    out = _run(stamp_center_service.get_stamp_center(
        survey="ztf", oid="x", candid="y",
    ))
    assert out["available"] is False


def test_upstream_failure_propagates_reason(monkeypatch):
    async def fake_avro(*, oid, candid, survey):
        return {"available": False, "reason": "Upstream error: boom", "rows": []}

    monkeypatch.setattr(avro_service, "get_avro_info", fake_avro)
    out = _run(stamp_center_service.get_stamp_center(
        survey="ztf", oid="x", candid="y",
    ))
    assert out["available"] is False
    assert "boom" in out["reason"]


def test_unknown_survey_degrades(monkeypatch):
    out = _run(stamp_center_service.get_stamp_center(
        survey="nope", oid="x", candid="y",
    ))
    assert out["available"] is False
