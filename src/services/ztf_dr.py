"""ZTF Data Release light-curve fetch + shaping.

The DR endpoint (`ztf/dr/v1/light_curve/`) takes ra/dec/radius and returns
one entry per `(fieldid, rcid, filterid)` match within the cone. Each entry
carries parallel arrays `hmjd`, `mag`, `magerr`, effectively surfacing the
full archival light curve (2018+) at that sky position.

For rendering alongside alert photometry we flatten across matches and group
by band — multiple fielddchunks in g all land in one "g" series. Mag → nJy
conversion reuses the AB ZP 31.4 convention used for ZTF alert magnitudes
(normalize.py); DR points are photometric so we populate `sci_flux` and leave
`flux` (difference) null, which makes the client's Diff/Sci toggle hide them
in Diff mode automatically.
"""
from __future__ import annotations

import logging
from typing import Any

from . import alerce_client
from .normalize import ztf_mag_to_njy, ztf_magerr_to_njyerr

log = logging.getLogger(__name__)

ZTF_DR_URL = "https://api.alerce.online/ztf/dr/v1/light_curve/"

_FID_TO_BAND: dict[int, str] = {1: "g", 2: "r", 3: "i"}
_BAND_ORDER: tuple[str, ...] = ("g", "r", "i")


def _shape_epoch(mjd: Any, mag: Any, mag_err: Any) -> dict[str, Any] | None:
    if mjd is None or mag is None:
        return None
    sci_flux = ztf_mag_to_njy(float(mag))
    e_sci_flux = (
        ztf_magerr_to_njyerr(float(mag), float(mag_err))
        if mag_err is not None
        else None
    )
    return {
        "mjd": float(mjd),
        # DR is archival science photometry — no difference flux exists.
        "flux": None,
        "e_flux": None,
        "sci_flux": sci_flux,
        "e_sci_flux": e_sci_flux,
        # DR epochs aren't alerts, so no candid and no stamp to click through to.
        "identifier": None,
        "has_stamp": False,
    }


def shape_dr(raw: Any) -> dict[str, Any]:
    entries = raw if isinstance(raw, list) else []
    buckets: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        band = _FID_TO_BAND.get(entry.get("filterid"))
        if band is None:
            continue
        hmjd = entry.get("hmjd") or []
        mag = entry.get("mag") or []
        magerr = entry.get("magerr") or []
        for i, t in enumerate(hmjd):
            m = mag[i] if i < len(mag) else None
            em = magerr[i] if i < len(magerr) else None
            shaped = _shape_epoch(t, m, em)
            if shaped is not None:
                buckets.setdefault(band, []).append(shaped)

    bands = [
        {"name": b, "points": sorted(buckets[b], key=lambda p: p["mjd"])}
        for b in _BAND_ORDER
        if b in buckets
    ]
    return {
        "bands": bands,
        "n_pts": sum(len(b["points"]) for b in bands),
    }


async def get_ztf_dr(*, ra: float, dec: float, radius: float = 1.5) -> dict[str, Any]:
    raw = await alerce_client._get(
        ZTF_DR_URL,
        params={"ra": ra, "dec": dec, "radius": radius},
    )
    return shape_dr(raw)
