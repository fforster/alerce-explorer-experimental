"""Object-detail shaping: call the ALeRCE object endpoint and normalize to a
common schema the basic-information template renders.

Field differences handled here (not in the template):
  - ZTF:  ndet            (no n_det)         → n_det
          ncovhist-ndethist                  → n_non_det (approx)
          corrected, stellar                 → kept
  - LSST: n_det, n_non_det, n_forced         → kept
          no corrected/stellar
"""
from __future__ import annotations

from typing import Any

from . import alerce_client
from .coordinates import (
    dec_to_dms,
    equatorial_to_ecliptic,
    equatorial_to_galactic,
    ra_to_hms,
)
from .other_archives import build_archive_links


def _maybe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _maybe_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _format_delta_mjd_human(delta_days: float | None) -> str | None:
    """Format a duration in days as 'XX yr XX d XX h XX m XX.XX s' (Julian year = 365.25 d).

    Leading zero units are dropped so '0 yr 0 d 1 h 2 m 3.00 s' renders as '1 h 2 m 3.00 s';
    the seconds field is always kept so the all-zero case shows '0.00 s'.
    """
    if delta_days is None:
        return None
    sign = "-" if delta_days < 0 else ""
    total_seconds = abs(delta_days) * 86400.0
    year_seconds = 365.25 * 86400.0
    years = int(total_seconds // year_seconds)
    remainder = total_seconds - years * year_seconds
    days = int(remainder // 86400.0)
    remainder -= days * 86400.0
    hours = int(remainder // 3600.0)
    remainder -= hours * 3600.0
    minutes = int(remainder // 60.0)
    seconds = remainder - minutes * 60.0
    parts: list[str] = []
    started = False
    for value, unit in ((years, "yr"), (days, "d"), (hours, "h"), (minutes, "m")):
        if started or value > 0:
            parts.append(f"{value} {unit}")
            started = True
    parts.append(f"{seconds:.2f} s")
    return sign + " ".join(parts)


def shape_object_info(raw: dict[str, Any], *, survey: str) -> dict[str, Any]:
    oid = str(raw.get("oid")) if raw.get("oid") is not None else None
    ra = _maybe_float(raw.get("meanra"))
    dec = _maybe_float(raw.get("meandec"))
    firstmjd = _maybe_float(raw.get("firstmjd"))
    lastmjd = _maybe_float(raw.get("lastmjd"))
    delta = _maybe_float(raw.get("deltamjd") or raw.get("deltajd"))
    if delta is None and firstmjd is not None and lastmjd is not None:
        delta = lastmjd - firstmjd

    if survey == "ztf":
        n_det = _maybe_int(raw.get("ndet"))
        ndethist = _maybe_int(raw.get("ndethist"))
        ncovhist = _maybe_int(raw.get("ncovhist"))
        n_non_det = (
            ncovhist - ndethist
            if ncovhist is not None and ndethist is not None
            else None
        )
        corrected = raw.get("corrected")
        stellar = raw.get("stellar")
    else:
        n_det = _maybe_int(raw.get("n_det"))
        n_non_det = _maybe_int(raw.get("n_non_det"))
        corrected = None
        stellar = None
    n_forced = _maybe_int(raw.get("n_forced"))

    ra_hms = ra_to_hms(ra) if ra is not None else None
    dec_dms = dec_to_dms(dec) if dec is not None else None

    # Galactic + ecliptic are pure rotations of (ra, dec), so they go or
    # stay together: None when either input is missing. Computed server-side
    # once per object — the values are small and deterministic, so pushing
    # them into the template data attributes beats doing the rotation in
    # JavaScript on every toggle click.
    if ra is not None and dec is not None:
        l_gal, b_gal = equatorial_to_galactic(ra, dec)
        lambda_ecl, beta_ecl = equatorial_to_ecliptic(ra, dec)
    else:
        l_gal = b_gal = lambda_ecl = beta_ecl = None

    archives = build_archive_links(ra=ra, dec=dec)

    return {
        "oid": oid,
        "survey": survey,
        "ra": ra,
        "dec": dec,
        "ra_hms": ra_hms,
        "dec_dms": dec_dms,
        "l_gal": l_gal,
        "b_gal": b_gal,
        "lambda_ecl": lambda_ecl,
        "beta_ecl": beta_ecl,
        "firstmjd": firstmjd,
        "lastmjd": lastmjd,
        "delta_mjd": delta,
        "delta_mjd_human": _format_delta_mjd_human(delta),
        "n_det": n_det,
        "n_non_det": n_non_det,
        "n_forced": n_forced,
        "corrected": corrected,
        "stellar": stellar,
        "archives": archives,
    }


async def get_object_info(*, survey: str, oid: str) -> dict[str, Any]:
    raw = await alerce_client.get_object(survey, oid)
    if not isinstance(raw, dict):
        raise ValueError(f"Unexpected object response shape: {type(raw).__name__}")
    return shape_object_info(raw, survey=survey)
