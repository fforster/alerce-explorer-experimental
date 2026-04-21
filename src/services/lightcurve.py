"""Lightcurve fetch + normalization.

Returns difference-flux detections plus (where available) forced photometry.
Non-detections and the ZTF v2 mag_corr merge still land in a later slice.

Raw ALeRCE response shapes:
  LSST /lightcurve_api/lightcurve        → {"detections": [...]}
  LSST /lightcurve_api/forced-photometry → [...]
  ZTF  v1 objects/{oid}/lightcurve       → {"detections": [...], "non_detections": [...]}
  ZTF  v2 lightcurve/{oid}               → {"detections": [...], "forced_photometry": [...]}

FP records share the same per-survey field layout as detections, so we reuse
`normalize_det` rather than writing a parallel normalizer.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from . import alerce_client
from .normalize import normalize_dets
from .survey_config import SC

log = logging.getLogger(__name__)


def _bucket_by_band(normalized: list[dict[str, Any]], cfg) -> list[dict[str, Any]]:
    """Group normalized rows by band, drop rows missing mjd/flux, and order
    bands by the survey's canonical ordering so legend entries stay stable
    across objects."""
    bands: dict[str, list[dict[str, Any]]] = {}
    for d in normalized:
        if d.get("mjd") is None or d.get("psf_flux") is None:
            continue
        band = d.get("band") or "unknown"
        bands.setdefault(band, []).append(
            {
                "mjd": d["mjd"],
                # `flux` carries difference-flux (psf_flux on diff image);
                # `sci_flux` is the absolute science-image flux when the survey
                # exposes it. The client picks which to plot via the Diff/Sci
                # toggle; null sci_flux means "no science photometry for this
                # point" and the client skips it in Sci mode.
                "flux": d["psf_flux"],
                "e_flux": d.get("e_psf_flux"),
                "sci_flux": d.get("science_flux"),
                "e_sci_flux": d.get("e_science_flux"),
                # `identifier` + `has_stamp` let the client drive the stamps
                # panel from a chart click without another round trip.
                "identifier": d.get("identifier"),
                "has_stamp": d.get("has_stamp", False),
            }
        )
    ordered = [
        {"name": b, "points": sorted(bands[b], key=lambda p: p["mjd"])}
        for b in cfg.bands
        if b in bands
    ]
    for b, pts in bands.items():
        if b not in cfg.bands:
            ordered.append({"name": b, "points": sorted(pts, key=lambda p: p["mjd"])})
    return ordered


def shape_lightcurve(
    raw: dict[str, Any],
    *,
    survey: str,
    fp_raw: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    cfg = SC(survey)
    det_bands = _bucket_by_band(normalize_dets(raw.get("detections") or [], survey), cfg)
    fp_bands = _bucket_by_band(normalize_dets(fp_raw or [], survey), cfg)

    return {
        "survey": survey,
        "bands": det_bands,
        "forced_phot_bands": fp_bands,
        "n_det": sum(len(b["points"]) for b in det_bands),
        "n_fp": sum(len(b["points"]) for b in fp_bands),
        # Gates the client-side Diff/Sci toggle; LSST doesn't publish absolute
        # science flux so the toggle is hidden entirely there.
        "has_science_flux": cfg.has_science_flux,
    }


def _extract_fp(fp_resp: Any, survey: str) -> list[dict[str, Any]]:
    """Different FP endpoints ship FP records in different shapes."""
    if fp_resp is None:
        return []
    if isinstance(fp_resp, list):
        return fp_resp  # LSST forced-photometry endpoint returns a plain list
    if isinstance(fp_resp, dict):
        # ZTF v2 lightcurve response has forced_photometry as a sub-key.
        fps = fp_resp.get("forced_photometry") or fp_resp.get("forcedPhotometry") or []
        return fps if isinstance(fps, list) else []
    return []


def _merge_ztf_v2_corr(
    v1_dets: list[dict[str, Any]], fp_resp: Any
) -> list[dict[str, Any]]:
    """Overlay v2 mag_corr/e_mag_corr onto v1 detections, joined by candid.

    ZTF's v1 lightcurve almost always emits sigmapsf_corr = 100.0 (the
    "unreliable" sentinel), which normalize_ztf rejects — resulting in empty
    sci-mode error bars. The v2 endpoint (already fetched for FP) carries the
    reference-subtracted, flux-calibrated correction we actually want, so we
    join by candid (string compare for LSST safety even though ZTF candids
    fit in 64 bits) and patch v1's magpsf_corr/sigmapsf_corr before
    normalization. Silently no-ops when the v2 response is missing or not
    the expected shape — the panel still renders, just without sci errors.
    """
    if not isinstance(fp_resp, dict):
        return v1_dets
    v2_dets = fp_resp.get("detections") or []
    if not isinstance(v2_dets, list):
        return v1_dets
    v2_by_candid: dict[str, dict[str, Any]] = {}
    for d in v2_dets:
        if not isinstance(d, dict):
            continue
        cid = d.get("candid")
        if cid is not None:
            v2_by_candid[str(cid)] = d
    if not v2_by_candid:
        return v1_dets
    for d in v1_dets:
        cid = d.get("candid")
        if cid is None:
            continue
        v2 = v2_by_candid.get(str(cid))
        if v2 is None:
            continue
        # Only override when v2 actually supplies a value, so we don't wipe
        # a (rare) reliable v1 field with a None from v2.
        if v2.get("mag_corr") is not None:
            d["magpsf_corr"] = v2["mag_corr"]
        # Prefer e_mag_corr_ext (reference-flux-inclusive error): in practice
        # `e_mag_corr` itself is often also the 100.0 sentinel on ALeRCE
        # ZTF v2, while `e_mag_corr_ext` carries the usable value. Fall back
        # to e_mag_corr when _ext isn't present.
        e_corr = v2.get("e_mag_corr_ext")
        if e_corr is None:
            e_corr = v2.get("e_mag_corr")
        if e_corr is not None:
            d["sigmapsf_corr"] = e_corr
    return v1_dets


async def _fetch_fp(url: str | None) -> Any:
    if url is None:
        return None
    try:
        return await alerce_client._get(url)
    except Exception as e:
        # FP is optional: don't fail the whole light-curve panel if FP is down.
        log.warning("forced-photometry fetch failed (%s): %s", url, e)
        return None


async def get_lightcurve(*, survey: str, oid: str) -> dict[str, Any]:
    cfg = SC(survey)
    fp_url = cfg.fp_url(oid) if cfg.has_forced_phot else None
    raw, fp_resp = await asyncio.gather(
        alerce_client._get(cfg.lightcurve_url(oid)),
        _fetch_fp(fp_url),
    )
    if not isinstance(raw, dict):
        raise ValueError(f"Unexpected lightcurve response shape: {type(raw).__name__}")
    # ZTF only: pull mag_corr/e_mag_corr from v2 into v1 so sci-mode error
    # bars aren't defeated by v1's sigmapsf_corr=100 sentinel.
    if survey == "ztf" and isinstance(raw.get("detections"), list):
        raw["detections"] = _merge_ztf_v2_corr(raw["detections"], fp_resp)
    fp_raw = _extract_fp(fp_resp, survey)
    return shape_lightcurve(raw, survey=survey, fp_raw=fp_raw)
