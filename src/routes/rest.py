"""JSON endpoints — used for programmatic clients and for the client-side JS
features (Chart.js, FITS, Aladin) that need data rather than HTML fragments.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from ..services import analytics as analytics_service
from ..services import lsst_neighbors as lsst_neighbors_service
from ..services import object_info as object_info_service
from ..services import xmatch_cache as xmatch_cache_service
from ..services import ztf_dr as ztf_dr_service

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["rest"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/ux_events")
async def ux_events(request: Request) -> Response:
    """Sink for client-side rrweb session-replay batches.

    Path is deliberately neutral (``/ux_events``, not ``/analytics``) so
    Brave/uBlock tracker filter lists don't block the beacon. Always answers
    204 No Content — even when collection is disabled or the body is
    unparseable — so the browser never retries and the response never leaks
    whether tracking is on. The body arrives via ``navigator.sendBeacon``
    (which can't set custom headers), so we read and parse the raw bytes
    ourselves rather than relying on a Pydantic model.
    """
    if not analytics_service.is_enabled():
        return Response(status_code=204)
    raw = await request.body()
    try:
        payload = json.loads(raw)
    except Exception:
        return Response(status_code=204)
    client_ip = request.client.host if request.client else None
    try:
        analytics_service.append(payload, client_ip=client_ip)
    except Exception:
        log.exception("analytics append failed")
    return Response(status_code=204)


@router.get("/ztf_dr")
async def ztf_dr(
    ra: float = Query(..., ge=0.0, le=360.0),
    dec: float = Query(..., ge=-90.0, le=90.0),
    radius: float = Query(1.5, gt=0.0, le=60.0),
) -> dict:
    """ZTF Data Release light-curve cone-search, flattened per band.

    Client loads this only when the user clicks the ZTF DR toggle on a ZTF
    object; server keeps the route public and survey-agnostic so the same
    endpoint could eventually back a standalone DR viewer.
    """
    try:
        return await ztf_dr_service.get_ztf_dr(ra=ra, dec=dec, radius=radius)
    except Exception as e:
        log.exception("ztf_dr fetch failed")
        raise HTTPException(status_code=502, detail=f"Upstream error: {e}") from e


@router.get("/xmatch_overlay")
async def xmatch_overlay(
    oid: str = Query(...),
    survey_id: str = Query(...),
) -> dict:
    """Spec-z overlay sources for one object, from the bulk-crossmatch cache.

    Drives the Aladin spec-z overlay (static/js/specz.js). Cache-first: the
    results-page prefetch usually has this object warm, so the overlay appears
    instantly; a cold call resolves the object's ra/dec via object_info and
    computes (then caches) it. Returns ``{"oid", "overlay": [...]}``; overlay is
    the list of spec-z marker dicts ``{cat_id,name,ra,dec,z,z_err,type,sep,color,size}``.
    """
    record = await xmatch_cache_service.get(oid)
    if record is None:
        try:
            info = await object_info_service.get_object_info(survey=survey_id, oid=oid)
            ra, dec = info.get("ra"), info.get("dec")
        except Exception:
            log.warning("xmatch_overlay object_info failed for %s", oid)
            ra = dec = None
        record = await xmatch_cache_service.get_or_compute(oid, ra, dec)
    return {"oid": oid, "overlay": record.get("overlay", [])}


@router.get("/lsst_neighbors")
async def lsst_neighbors(
    ra: float = Query(..., ge=0.0, le=360.0),
    dec: float = Query(..., ge=-90.0, le=90.0),
    lastmjd: float = Query(..., gt=0.0),
    exclude_oid: str | None = Query(None),
) -> list[dict]:
    """LSST cone-search around (ra, dec) within 10 arcmin AND ±2 hr of
    `lastmjd`. The Aladin sky-view panel calls this after spec-z catalogs
    have loaded, then plots the returned objects as gray squares so the user
    can spot contemporaneous detections (potential trails)."""
    try:
        return await lsst_neighbors_service.get_lsst_neighbors(
            ra=ra, dec=dec, lastmjd=lastmjd, exclude_oid=exclude_oid,
        )
    except Exception as e:
        log.exception("lsst_neighbors fetch failed")
        raise HTTPException(status_code=502, detail=f"Upstream error: {e}") from e
