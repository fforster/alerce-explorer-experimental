"""Bulk magnitude lookup via the ALeRCE TAP service.

The object-list and object-info endpoints carry no brightness, so the results
table's "Peak diff mag" / "Mean tot mag" columns are filled from precomputed
per-band magnitude statistics served over TAP (IVOA Table Access Protocol) at
`https://tap.alerce.online/tap/sync`. One bulk ADQL query per page
(`WHERE oid IN (...)`) covers every visible object — no per-object round trips.

Two magnitudes are shown because the relevant one depends on the object: for a
**transient** the peak of the *difference* light curve matters; for a **star /
variable** the *total* (science / apparent) brightness matters. The total is
reported as a **mean** (not a peak) so the label is honest on both surveys —
LSST stores no per-band science maximum, only a mean, so a "peak total" would
be misleading; ZTF likewise uses its mean corrected magnitude for symmetry.

Per-survey sources (field names verified against the live service):
  ZTF  → `ztf.magstat` (oid = ZTF name string, per-band key `fid` 1=g/2=r/3=i)
         diff       = `magmin`        (brightest difference magnitude)
         mean total = `magmean_corr`  (mean corrected/apparent magnitude; null
                                       when `corrected` is false)
  LSST → `alerce_tap.lsst_dia_object` (oid = 64-bit int)
         diff       = brightest per-band `{b}_psffluxmax`     (peak diff flux)
         mean total = brightest per-band `{b}_sciencefluxmean` (mean science /
                                                                total flux)
  Fluxes (nJy) → mag via the AB zero-point (31.4). Both quantities report the
  brightest band (with its letter). `alerce_tap.magstat` is NOT used for ZTF:
  it keys on an internal integer oid that doesn't match ZTF names.

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

# LSST per-band flux columns in `alerce_tap.lsst_dia_object`, by band.
_LSST_BANDS = ("u", "g", "r", "i", "z", "y")
_LSST_DIFF_SUFFIX = "psffluxmax"       # peak difference flux
_LSST_TOTAL_SUFFIX = "sciencefluxmean"  # mean science (total) flux


def _build_adql(oids: list[str], survey: str) -> str:
    """ADQL for the per-survey magstat query. Empty oids → "" (short-circuit;
    never emit `IN ()`)."""
    if not oids:
        return ""
    if survey == "ztf":
        # ZTF oids are name strings ('ZTF...') — single-quote each.
        in_list = ", ".join("'{}'".format(o.replace("'", "")) for o in oids)
        return (
            "SELECT oid,fid,magmin,magmean_corr "
            "FROM ztf.magstat WHERE oid IN ({})".format(in_list)
        )
    if survey == "lsst":
        # LSST oids are bare 64-bit integers — keep only digit strings so the
        # ADQL stays an integer IN-list (page oids arrive as strings).
        in_list = ", ".join(o for o in oids if o.lstrip("-").isdigit())
        cols = ",".join(
            "{}_{}".format(b, suffix)
            for b in _LSST_BANDS
            for suffix in (_LSST_DIFF_SUFFIX, _LSST_TOTAL_SUFFIX)
        )
        return (
            "SELECT oid,{} "
            "FROM alerce_tap.lsst_dia_object WHERE oid IN ({})".format(cols, in_list)
        )
    raise ValueError("Unknown survey: {!r}".format(survey))


async def _tap_query(adql: str) -> list[dict[str, Any]]:
    """Run one ADQL query and return rows as column-name→value dicts.

    Monkeypatch seam for the unit tests.
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


def _brightest_mag(pairs: list[tuple[float | None, str]]) -> tuple[float | None, str | None]:
    """Given (mag, band) pairs, return the brightest (smallest mag) + its band,
    skipping None mags."""
    best_mag = None
    best_band = None
    for mag, band in pairs:
        if mag is not None and (best_mag is None or mag < best_mag):
            best_mag = mag
            best_band = band
    return best_mag, best_band


def _flux_to_mag(flux: float | None) -> float | None:
    """nJy → AB magnitude; None / non-positive flux → None."""
    if flux is None or flux <= 0:
        return None
    return AB_ZP_NJY - 2.5 * math.log10(flux)


def _reduce_ztf(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per object: peak diff = min `magmin`; mean total = min `magmean_corr`
    (both brightest-across-bands, each with its band)."""
    by_oid: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        oid = r.get("oid")
        if oid is None:
            continue
        by_oid.setdefault(str(oid), []).append(r)

    out: dict[str, dict[str, Any]] = {}
    for oid, band_rows in by_oid.items():
        diff_mag, diff_band = _brightest_mag(
            [(r.get("magmin"), ZTF_FID_TO_BAND.get(r.get("fid"))) for r in band_rows]
        )
        tot_mag, tot_band = _brightest_mag(
            [(r.get("magmean_corr"), ZTF_FID_TO_BAND.get(r.get("fid"))) for r in band_rows]
        )
        out[oid] = {
            "peak_diff_mag": diff_mag,
            "peak_diff_band": diff_band,
            "mean_tot_mag": tot_mag,
            "mean_tot_band": tot_band,
        }
    return out


def _reduce_lsst(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per object: peak diff = brightest `{b}_psffluxmax`; mean total =
    brightest `{b}_sciencefluxmean` (each converted to a magnitude)."""
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        oid = r.get("oid")
        if oid is None:
            continue
        diff_mag, diff_band = _brightest_mag(
            [(_flux_to_mag(r.get("{}_{}".format(b, _LSST_DIFF_SUFFIX))), b) for b in _LSST_BANDS]
        )
        tot_mag, tot_band = _brightest_mag(
            [(_flux_to_mag(r.get("{}_{}".format(b, _LSST_TOTAL_SUFFIX))), b) for b in _LSST_BANDS]
        )
        out[str(oid)] = {
            "peak_diff_mag": diff_mag,
            "peak_diff_band": diff_band,
            "mean_tot_mag": tot_mag,
            "mean_tot_band": tot_band,
        }
    return out


async def fetch_magstats_bulk(
    oids: list[str], survey: str
) -> dict[str, dict[str, float | str | None]]:
    """{oid_str: {"peak_diff_mag","peak_diff_band","mean_tot_mag","mean_tot_band"}}
    for the given oids. Any TAP failure (network, timeout, query error) degrades
    to {} so the table's mag cells resolve to "—" rather than erroring."""
    adql = _build_adql(oids, survey)
    if not adql:
        return {}
    try:
        rows = await _tap_query(adql)
    except Exception:
        log.exception("magstats TAP query failed")
        return {}
    return _reduce_ztf(rows) if survey == "ztf" else _reduce_lsst(rows)
