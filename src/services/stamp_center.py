"""Where does the alert actually sit inside a stamp cutout?

The stamps panel draws the cutout so that the alert position lands under the
centre crosshair. That is trivially the image's geometric centre *as long as
the cutout wasn't clipped* — but a survey carves the cutout out of a finite
detector, so an alert within half a cutout of a detector edge gets a truncated,
off-centre postage stamp.

LSST ships a real WCS and the correct ``CRPIX`` comes straight from the FITS
header, so none of this is needed. **ZTF stamps carry no WCS whatsoever** (no
``CRPIX``/``CRVAL``/``CD``), which makes a clipped cutout impossible to
distinguish from a centred one by inspecting the file: a 48x63 ZTF stamp still
has the source at the alert position, just no longer in the middle.

What pins it down is the alert's position on the detector — ``candidate.xpos``
/ ``candidate.ypos`` in the AVRO record — combined with the survey's nominal
cutout size and detector shape (both on :class:`SurveyConfig`). Worked example,
ZTF26abngxfo candid 3510493201915015030, ``xpos=3055.59`` on a 3072-wide
quadrant with a 63 px cutout::

    centre 3056 -> wanted [3025 .. 3087] -> clipped to [3025 .. 3072]
    width = 48 (matches the observed NAXIS1), CRPIX1 = 3056 - 3025 + 1 = 32

versus a geometric centre of (48+1)/2 = 24.5 — a 7.5 px ≈ 7.5" error, which is
what this module exists to remove.

Note ``xpos``/``ypos`` are NOT in the ALeRCE detections payload; only the AVRO
record has them. So this is fetched lazily by the client, and only when the
cutout comes back smaller than nominal on some axis.
"""
from __future__ import annotations

import logging
import math
from typing import Any

from . import avro as avro_service
from .survey_config import SC

log = logging.getLogger(__name__)


def clipped_axis(pos: float, limit: int, full_size: int) -> tuple[int, float]:
    """Cutout width and 1-indexed CRPIX along one axis.

    ``pos`` is the alert's (1-indexed) coordinate on the detector, ``limit`` the
    detector extent along that axis, ``full_size`` the nominal cutout size.

    The survey centres a ``full_size`` box on the *pixel containing* the alert
    and keeps whatever falls inside the detector. Returns ``(width, crpix)``:
    ``width`` is the surviving extent — which the caller should check against
    the observed ``NAXISn`` — and ``crpix`` is where the alert lands inside it.

    The window bounds come from the rounded position (they are integer pixel
    edges), but ``crpix`` keeps the *fractional* offset, so ``CRVAL`` is exactly
    the alert's RA/Dec rather than the centre of its pixel. An unclipped cutout
    therefore gives ``crpix ≈ (width + 1) / 2``, within the sub-pixel offset.
    """
    centre = math.floor(pos + 0.5)  # round-half-up; deterministic across ports
    half = full_size // 2
    lo = max(1, centre - half)
    hi = min(limit, centre + half)
    return hi - lo + 1, pos - lo + 1


def _unavailable(reason: str) -> dict[str, Any]:
    return {"available": False, "reason": reason}


def _candidate_field(rows: list[dict[str, Any]], name: str) -> float | None:
    """Pull one numeric field out of avro.get_avro_info's flattened rows."""
    for r in rows:
        if r.get("name") == name:
            try:
                v = float(r.get("value"))
            except (TypeError, ValueError):
                return None
            return v if math.isfinite(v) else None
    return None


async def get_stamp_center(
    *, survey: str, oid: str, candid: str
) -> dict[str, Any]:
    """Reconstruct ``(crpix1, crpix2)`` for one detection's cutout.

    Every failure mode degrades to ``available=False`` with a human-readable
    ``reason`` — the client falls back to geometric-centre anchoring, which is
    exactly today's behaviour, so a flaky AVRO service can't break the panel.
    """
    try:
        cfg = SC(survey)
    except ValueError as e:
        return _unavailable(str(e))

    full_size = cfg.stamp_full_size
    shape = cfg.detector_shape
    if not full_size or not shape:
        # The survey's stamps carry a real WCS (LSST) — CRPIX is in the header
        # and reconstruction is neither possible nor needed. No HTTP call.
        return _unavailable(
            f"{survey.upper()} stamps carry a WCS; CRPIX comes from the header."
        )

    info = await avro_service.get_avro_info(oid=oid, candid=candid, survey=survey)
    if not info.get("available"):
        return _unavailable(info.get("reason") or "AVRO record unavailable.")

    rows = info.get("rows") or []
    xpos = _candidate_field(rows, "xpos")
    ypos = _candidate_field(rows, "ypos")
    if xpos is None or ypos is None:
        return _unavailable("AVRO record carried no xpos/ypos.")

    nx, crpix1 = clipped_axis(xpos, shape[0], full_size)
    ny, crpix2 = clipped_axis(ypos, shape[1], full_size)
    return {
        "available": True,
        "crpix1": crpix1,
        "crpix2": crpix2,
        "nx": nx,
        "ny": ny,
        "xpos": xpos,
        "ypos": ypos,
    }
