"""Bulk peak/last magnitude lookup via the ALeRCE TAP service.

The object-list and object-info endpoints carry no brightness, so the results
table's "Peak mag" / "Last mag" columns are filled from precomputed per-band
magnitude statistics served over TAP (IVOA Table Access Protocol) at
`https://tap.alerce.online/tap/sync`. One bulk ADQL query per page
(`WHERE oid IN (...)`) covers every visible object — no per-object round trips.

Per-survey sources (field names verified against the live service):
  ZTF  → `ztf.magstat`               oid = the ZTF name string; per-band key
                                     `fid` (1=g, 2=r, 3=i); `magmin` (brightest
                                     mag), `maglast`, `lastmjd`.
  LSST → `alerce_tap.lsst_dia_object` oid = 64-bit int; per-band `{b}_psffluxmax`
                                     (difference PSF peak flux, nJy). No per-band
                                     last magnitude exists.

`alerce_tap.magstat` is deliberately NOT used for ZTF: it keys on an internal
integer oid that does not match the Explorer's ZTF names.

Peak = brightest across bands (ZTF: min `magmin`; LSST: max flux → mag via the
AB zero-point). Last = `maglast` of the band with the latest `lastmjd` (ZTF
only; LSST has no per-band last magnitude → None → "—" in the table).

TAP `/sync` returns a VOTable **XML** error document even when `FORMAT=json` is
requested (malformed query / service error), so parsing never assumes JSON — a
non-JSON or wrong-shape body degrades to an empty result and the cells resolve
to "—" rather than raising.
"""
from __future__ import annotations

import logging
import math
from typing import Any

import httpx

from .normalize import AB_ZP_NJY, ZTF_FID_TO_BAND
from .safe_json import safe_json_loads

log = logging.getLogger(__name__)

TAP_SYNC_URL = "https://tap.alerce.online/tap/sync"
_TIMEOUT = httpx.Timeout(30.0)

# LSST difference-PSF peak-flux columns in `alerce_tap.lsst_dia_object`, by band.
_LSST_FLUX_BANDS = ("u", "g", "r", "i", "z", "y")


def _build_adql(oids: list[str], survey: str) -> str:
    """ADQL for the per-survey magstat query. Empty oids → "" (short-circuit;
    never emit `IN ()`)."""
    if not oids:
        return ""
    if survey == "ztf":
        # ZTF oids are name strings ('ZTF...') — single-quote each.
        in_list = ", ".join("'{}'".format(o.replace("'", "")) for o in oids)
        return (
            "SELECT oid,fid,magmin,maglast,lastmjd "
            "FROM ztf.magstat WHERE oid IN ({})".format(in_list)
        )
    if survey == "lsst":
        # LSST oids are bare 64-bit integers — keep only digit strings so the
        # ADQL stays an integer IN-list (page oids arrive as strings).
        in_list = ", ".join(o for o in oids if o.lstrip("-").isdigit())
        cols = ",".join("{}_psffluxmax".format(b) for b in _LSST_FLUX_BANDS)
        return (
            "SELECT oid,{} "
            "FROM alerce_tap.lsst_dia_object WHERE oid IN ({})".format(cols, in_list)
        )
    raise ValueError("Unknown survey: {!r}".format(survey))


async def _tap_query(adql: str) -> list[dict[str, Any]]:
    """Run one ADQL query and return rows as column-name→value dicts.

    Monkeypatch seam for the unit tests. Guards against the VOTable-XML error
    body TAP returns on failure: anything that isn't JSON with `columns`+`data`
    yields an empty list.
    """
    params = {
        "REQUEST": "doQuery",
        "LANG": "ADQL",
        "FORMAT": "json",
        "QUERY": adql,
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        resp = await client.get(TAP_SYNC_URL, params=params)
        resp.raise_for_status()
        body = resp.content
    return _parse_tap_rows(body)


def _parse_tap_rows(body: str | bytes) -> list[dict[str, Any]]:
    """Turn a TAP `/sync` JSON body into column-name→value row dicts.

    Guards against the VOTable **XML** error document TAP returns on a failed
    query even under `FORMAT=json`: a non-JSON or wrong-shape body yields [].
    """
    try:
        parsed = safe_json_loads(body)
    except Exception:
        # VOTable XML error document (QUERY_STATUS=ERROR) or malformed body.
        log.warning("TAP returned a non-JSON body (likely a query error)")
        return []
    if not isinstance(parsed, dict) or "columns" not in parsed or "data" not in parsed:
        log.warning("TAP response missing columns/data")
        return []
    names = [c.get("name") for c in parsed.get("columns") or []]
    rows: list[dict[str, Any]] = []
    for row in parsed.get("data") or []:
        rows.append(dict(zip(names, row)))
    return rows


def _reduce_ztf(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per object: peak = min `magmin` across bands (with its band); last =
    `maglast` of the band observed most recently (max `lastmjd`)."""
    by_oid: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        oid = r.get("oid")
        if oid is None:
            continue
        by_oid.setdefault(str(oid), []).append(r)

    out: dict[str, dict[str, Any]] = {}
    for oid, band_rows in by_oid.items():
        peak_mag = None
        peak_band = None
        last_mag = None
        last_band = None
        last_mjd = None
        for r in band_rows:
            band = ZTF_FID_TO_BAND.get(r.get("fid"))
            magmin = r.get("magmin")
            if magmin is not None and (peak_mag is None or magmin < peak_mag):
                peak_mag = magmin
                peak_band = band
            mjd = r.get("lastmjd")
            maglast = r.get("maglast")
            if maglast is not None and mjd is not None and (
                last_mjd is None or mjd > last_mjd
            ):
                last_mjd = mjd
                last_mag = maglast
                last_band = band
        out[oid] = {
            "peak_mag": peak_mag,
            "peak_band": peak_band,
            "last_mag": last_mag,
            "last_band": last_band,
        }
    return out


def _reduce_lsst(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per object: peak = brightest = largest positive `{b}_psffluxmax` across
    bands, converted to a magnitude. LSST has no per-band last magnitude."""
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        oid = r.get("oid")
        if oid is None:
            continue
        best_flux = None
        best_band = None
        for band in _LSST_FLUX_BANDS:
            flux = r.get("{}_psffluxmax".format(band))
            if flux is not None and flux > 0 and (best_flux is None or flux > best_flux):
                best_flux = flux
                best_band = band
        peak_mag = (
            AB_ZP_NJY - 2.5 * math.log10(best_flux) if best_flux is not None else None
        )
        out[str(oid)] = {
            "peak_mag": peak_mag,
            "peak_band": best_band,
            "last_mag": None,
            "last_band": None,
        }
    return out


async def fetch_magstats_bulk(
    oids: list[str], survey: str
) -> dict[str, dict[str, float | str | None]]:
    """{oid_str: {"peak_mag","peak_band","last_mag","last_band"}} for the given
    oids. Any TAP failure (network, timeout, query error) degrades to {} so the
    table's mag cells resolve to "—" rather than erroring."""
    adql = _build_adql(oids, survey)
    if not adql:
        return {}
    try:
        rows = await _tap_query(adql)
    except Exception:
        log.exception("magstats TAP query failed")
        return {}
    return _reduce_ztf(rows) if survey == "ztf" else _reduce_lsst(rows)
