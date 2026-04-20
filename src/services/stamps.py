"""Stamp URLs + detection picker metadata.

The stamp images themselves (FITS bytes) are fetched directly by the browser
— this service only tells the page which detections have stamps and what
URLs to hit for each cutout type.

Identifier conventions:
  - ZTF uses `candid` (string; keep as string for 64-bit safety)
  - LSST uses `measurement_id` (can exceed 2**53; safe_json already quotes it)
"""
from __future__ import annotations

from typing import Any

from . import alerce_client
from .survey_config import SC

STAMP_TYPES: tuple[str, ...] = ("science", "template", "difference")


def _identifier(det: dict[str, Any], survey: str) -> str | None:
    key = "candid" if survey == "ztf" else "measurement_id"
    v = det.get(key)
    return str(v) if v is not None else None


def _band_letter(det: dict[str, Any], survey: str) -> str | None:
    if survey == "ztf":
        fid = det.get("fid")
        return {1: "g", 2: "r", 3: "i"}.get(fid)
    band_map = det.get("band_map") or {}
    band = det.get("band")
    if band is None:
        return None
    return band_map.get(str(band))


def shape_stamps_context(
    raw_lc: dict[str, Any],
    *,
    survey: str,
    oid: str,
    identifier: str | None,
) -> dict[str, Any]:
    dets = raw_lc.get("detections") or []
    picker: list[dict[str, Any]] = []
    for d in dets:
        ident = _identifier(d, survey)
        if ident is None or not d.get("has_stamp"):
            continue
        mjd = d.get("mjd")
        if mjd is None:
            continue
        picker.append(
            {"identifier": ident, "mjd": mjd, "band": _band_letter(d, survey)}
        )
    picker.sort(key=lambda p: p["mjd"], reverse=True)  # most recent first

    selected = None
    if identifier is not None:
        selected = next((p for p in picker if p["identifier"] == identifier), None)
    if selected is None and picker:
        selected = picker[0]

    cfg = SC(survey)
    stamp_urls = (
        {t: cfg.stamp_url(oid=oid, identifier=selected["identifier"], stamp_type=t)
         for t in STAMP_TYPES}
        if selected
        else {}
    )

    return {
        "oid": oid,
        "survey": survey,
        "detections": picker,
        "selected": selected,
        "stamp_types": list(STAMP_TYPES),
        "stamp_urls": stamp_urls,
    }


async def get_stamps_context(
    *, survey: str, oid: str, identifier: str | None = None
) -> dict[str, Any]:
    cfg = SC(survey)
    raw_lc = await alerce_client._get(cfg.lightcurve_url(oid))
    if not isinstance(raw_lc, dict):
        raise ValueError(f"Unexpected lightcurve response shape: {type(raw_lc).__name__}")
    return shape_stamps_context(raw_lc, survey=survey, oid=oid, identifier=identifier)
