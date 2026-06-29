"""catsHTM crossmatch lookup.

Wraps `catshtm.alerce.online/crossmatch_all` into a templated, themed shape.
The endpoint returns a list of single-entry dicts, one per matched catalog:

    [
        {"DECaLS": {"RA": {"unit": "deg", "value": 180.0001}, ...}},
        {"GAIA/DR2": {...}},
        ...
    ]

Each field value is itself either `{unit, value}` or `{unit, values: [...]}`.
We flatten that into ordered `(key, value_display, unit)` triples so the
template doesn't have to know about the catsHTM payload shape — and so we
can drop empty catalogs (the API occasionally returns `{"X": {}}`) without
the template needing to guard each cell.

Future xmatch catalogs (VizieR, AllWISE, …) can ride alongside catsHTM by
appending to the same shaped `catalogs` list.
"""
from __future__ import annotations

import logging
import math
from typing import Any

import httpx

from .safe_json import safe_json_loads

log = logging.getLogger(__name__)

# catsHTM field keys that hold the matched object's position, by axis. catsHTM
# returns RA/Dec per catalog; key names + units vary, so we match case-insensitively.
_RA_KEYS = {"ra", "raj2000", "ra_icrs", "_raj2000", "alpha", "alphawin_j2000", "radeg"}
_DEC_KEYS = {"dec", "de", "dej2000", "de_icrs", "_dej2000", "delta", "deltawin_j2000", "dedeg"}


def _catshtm_markers(raw: Any) -> list[dict[str, Any]]:
    """Pull {name, ra, dec} (deg) per catsHTM catalog so the 'show all in Aladin'
    button can plot them. Values arrive as {unit, value}; rad → deg if flagged."""
    markers: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return markers
    for entry in raw:
        if not isinstance(entry, dict) or not entry:
            continue
        name = next(iter(entry.keys()))
        body = entry[name]
        if not isinstance(body, dict):
            continue
        ra = dec = None
        prop_bits: list[str] = []
        for key, val in body.items():
            kl = str(key).strip().lower()
            if kl in _RA_KEYS or kl in _DEC_KEYS:
                # Position — used for the marker, not repeated in the details.
                unit = (val.get("unit") if isinstance(val, dict) else "") or ""
                v = val.get("value") if isinstance(val, dict) else val
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    continue
                if str(unit).strip().lower().startswith("rad"):
                    f = math.degrees(f)
                if kl in _RA_KEYS:
                    ra = f
                else:
                    dec = f
                continue
            disp = _shape_field(val)
            if disp == "—":
                continue
            unit = _shape_unit(val)
            prop_bits.append(f"{key} {disp}{(' ' + unit) if unit else ''}")
        if ra is not None and dec is not None:
            # Cap the details so a many-column catalog stays a readable one-liner.
            markers.append({"name": str(name), "ra": ra, "dec": dec,
                            "props": " · ".join(prop_bits[:8])})
    return markers

CATSHTM_URL = "https://catshtm.alerce.online"
DEFAULT_RADIUS_ARCSEC = 30.0
# Crossmatch is not on the critical path — pick a tighter timeout than the
# main API client (30s) so a slow catsHTM doesn't hang the panel forever.
_TIMEOUT = httpx.Timeout(15.0)


def _format_value(v: Any) -> str:
    """Numbers → 6-decimal float (matches the prototype); everything else
    is stringified verbatim. None becomes an em-dash so blank cells read
    as "no value" instead of "0"."""
    if v is None:
        return "—"
    if isinstance(v, bool):
        # bool is a subclass of int; check first so True/False don't render
        # as "1.000000"/"0.000000".
        return "true" if v else "false"
    if isinstance(v, float):
        return f"{v:.6f}"
    return str(v)


def _shape_field(val: Any) -> str:
    """Reduce a catsHTM field cell ({unit, value} | {unit, values} | scalar)
    to a single display string."""
    if isinstance(val, dict):
        if "value" in val:
            return _format_value(val["value"])
        if "values" in val:
            vs = val["values"]
            if isinstance(vs, list):
                return ", ".join(_format_value(v) for v in vs)
            return _format_value(vs)
        return "—"
    if isinstance(val, list):
        return ", ".join(_format_value(v) for v in val)
    return _format_value(val)


def _shape_unit(val: Any) -> str | None:
    """Extract the cell's unit string when present + non-trivial. Spaces and
    the catsHTM " " sentinel ("dimensionless") are dropped."""
    if isinstance(val, dict):
        unit = val.get("unit")
        if isinstance(unit, str) and unit.strip():
            return unit.strip()
    return None


def shape_crossmatch(raw: Any) -> list[dict[str, Any]]:
    """Flatten the catsHTM response into [{name, fields:[{key,value,unit}]}].

    Catalogs with no fields, or where the body isn't a dict, are dropped —
    catsHTM occasionally returns empty hits which would otherwise render as
    bare title rows.
    """
    catalogs: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return catalogs
    for entry in raw:
        if not isinstance(entry, dict) or not entry:
            continue
        # Each entry is a single-key dict: {catalog_name: {field: ...}}.
        name = next(iter(entry.keys()))
        body = entry[name]
        if not isinstance(body, dict) or not body:
            continue
        fields = [
            {"key": key, "value": _shape_field(val), "unit": _shape_unit(val)}
            for key, val in body.items()
        ]
        if fields:
            catalogs.append({"name": str(name), "fields": fields})
    return catalogs


async def get_crossmatch(
    *,
    ra: float | None,
    dec: float | None,
    radius: float = DEFAULT_RADIUS_ARCSEC,
) -> dict[str, Any]:
    """Fetch catsHTM crossmatch and return a shaped panel context.

    Shape:
        {
            "available": bool,    # False iff coords missing
            "ra": float | None,
            "dec": float | None,
            "radius": float,      # arcsec
            "catalogs": [...],    # see shape_crossmatch
            "n_catalogs": int,
            "error": str | None,  # set on network/HTTP failure
        }

    No coords → available=False, no fetch. Network failure → available=True
    with an error message so the panel can show "we tried, here's why"
    instead of pretending no matches were found.
    """
    ctx: dict[str, Any] = {
        "available": ra is not None and dec is not None,
        "ra": ra,
        "dec": dec,
        "radius": radius,
        "catalogs": [],
        "n_catalogs": 0,
        "error": None,
        "markers": [],
    }
    if not ctx["available"]:
        return ctx
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            r = await client.get(
                f"{CATSHTM_URL}/crossmatch_all",
                params={"ra": ra, "dec": dec, "radius": radius},
            )
            r.raise_for_status()
            data = safe_json_loads(r.content)
    except Exception as e:
        log.warning("catsHTM crossmatch fetch failed (ra=%s, dec=%s): %s", ra, dec, e)
        ctx["error"] = str(e)
        return ctx
    catalogs = shape_crossmatch(data)
    ctx["catalogs"] = catalogs
    ctx["n_catalogs"] = len(catalogs)
    ctx["markers"] = _catshtm_markers(data)   # positions for the Aladin "show all" button
    return ctx
