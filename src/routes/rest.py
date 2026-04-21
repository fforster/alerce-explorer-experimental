"""JSON endpoints — used for programmatic clients and for the client-side JS
features (Chart.js, FITS, Aladin) that need data rather than HTML fragments.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from ..services import ztf_dr as ztf_dr_service

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["rest"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
