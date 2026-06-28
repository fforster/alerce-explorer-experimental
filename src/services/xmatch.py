"""Bulk crossmatch against CDS XMatch (Simbad / SDSS / DESI + VizieR spec-z
catalogs) and NED TAP.

One request cross-matches ALL positions against a catalog instead of a cone
search per object. Ported from the ALeRCE TNS pipeline
(``alerce_tns/clients/catalogs.py``: ``bulk_xmatch`` / ``bulk_xmatch_vizier`` /
``bulk_ned_tap`` + their registries and normalizers), with two changes for the
explorer:

* every catalog normalizes to ONE uniform row shape
  ``{cat_name, ra, dec, z, z_err, photoz, type, name, sep}`` (we don't need the
  pipeline's per-catalog host-selection dicts), and
* the blocking astroquery / pyvo calls are wrapped in ``asyncio.to_thread`` and
  fanned out concurrently (``bulk_all``), gated by a semaphore — keeping the
  explorer's all-async service layer.

The VizieR registry mirrors ``static/js/specz.js``'s ``SPEC_Z_CATALOGS``; the
column maps / quality filters / cz→z conversions are the debugged TNS versions.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any, Callable

import astropy.units as u
import numpy as np
from astropy import coordinates
from astropy.table import Table
from astroquery.xmatch import XMatch

log = logging.getLogger(__name__)

_C_KMS = 299792.458          # speed of light, km/s (cz → z)
_CONCURRENCY = 8             # polite cap on parallel CDS/NED requests
_RETRIES = 2
_XMATCH_TIMEOUT = 60

# Per-catalog cone radii (arcsec) — the TNS defaults.
RADIUS_SIMBAD = 36.0
RADIUS_SDSS = 30.0
RADIUS_DESI = 30.0
RADIUS_EXTRA_Z = 36.0
RADIUS_NED = 36.0


class CatalogQueryError(RuntimeError):
    """Raised when a catalog service is unreachable after all internal retries."""


# --- cell / value helpers (ported) -----------------------------------------

def _cell(value: Any) -> Any:
    """astropy/numpy table cell → JSON-safe Python scalar; masked → None."""
    if value is None or value is np.ma.masked:
        return None
    try:
        if np.ma.is_masked(value):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:
            value = str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def _row_to_dict(table: Table, idx: int) -> dict:
    return {col: _cell(table[col][idx]) for col in table.colnames}


def _num(value: Any) -> float | None:
    """Float or None for masked/sentinel cells."""
    if value is None:
        return None
    s = str(value).strip()
    if s in ("", "nan", "--", "-99", "-999.0", "-9999.0"):
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _has(row: dict, col: str | None) -> bool:
    v = row.get(col) if col else None
    return v is not None and str(v).strip() not in ("", "nan", "--")


def _vznum(row: dict, col: str | None) -> float | None:
    return _num(row.get(col)) if col else None


# --- CDS XMatch direct catalogs (Simbad / SDSS / DESI) ----------------------

XMATCH_CAT2 = {
    "Simbad": "simbad",
    "SDSS":   "vizier:V/154/sdss16",
    "DESI":   "vizier:V/161/zcatdr1",
}
_XMATCH_RADIUS = {"Simbad": RADIUS_SIMBAD, "SDSS": RADIUS_SDSS, "DESI": RADIUS_DESI}


def _norm_simbad(raw: dict) -> dict | None:
    """Uses the MATCHED object's coords (ra2/dec2), not the echoed input."""
    return {
        "cat_name": "Simbad",
        "ra": _num(raw.get("ra2")), "dec": _num(raw.get("dec2")),
        "z": _num(raw.get("redshift")), "z_err": _num(raw.get("redshift_err")),
        "photoz": None,
        "type": raw.get("main_type") or raw.get("otype"),
        "name": raw.get("main_id"),
        "sep": _num(raw.get("angDist")),
    }


def _norm_sdss(raw: dict) -> dict | None:
    """Keep galaxies only (class==3); zsp is spectroscopic, zph photometric."""
    try:
        if int(raw.get("class")) != 3:
            return None
    except (TypeError, ValueError):
        return None
    return {
        "cat_name": "SDSS",
        "ra": _num(raw.get("RA_ICRS")), "dec": _num(raw.get("DE_ICRS")),
        "z": _num(raw.get("zsp")), "z_err": _num(raw.get("e_zsp")),
        "photoz": _num(raw.get("zph")),
        "type": "GALAXY",
        "name": str(raw.get("objID") or raw.get("SDSS16") or ""),
        "sep": _num(raw.get("angDist")),
    }


def _norm_desi(raw: dict) -> dict | None:
    """Keep ZWARN==0, drop stars."""
    try:
        if int(raw.get("ZWARN")) != 0:
            return None
    except (TypeError, ValueError):
        return None
    otype = raw.get("OType")
    if otype is not None and str(otype).strip().upper() == "STAR":
        return None
    return {
        "cat_name": "DESI",
        "ra": _num(raw.get("RA_ICRS")), "dec": _num(raw.get("DE_ICRS")),
        "z": _num(raw.get("z")), "z_err": _num(raw.get("e_z")),
        "photoz": None,
        "type": otype,
        "name": raw.get("Name") or str(raw.get("TargetID") or ""),
        "sep": _num(raw.get("angDist")),
    }


_XMATCH_NORM = {"Simbad": _norm_simbad, "SDSS": _norm_sdss, "DESI": _norm_desi}


# --- VizieR spec-z catalogs (mirror specz.js SPEC_Z_CATALOGS) ----------------

VIZIER_Z_CATALOGS = {
    "SDSS_QSO": {
        "name": "SDSS DR16 QSO", "tables": ["vizier:VII/289/dr16q"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": ["Class"], "filter": lambda r: _has(r, "z"),
    },
    "6dFGS": {
        "name": "6dFGS", "tables": ["vizier:VII/259/6dfgs"],
        "ra": "_RAJ2000", "dec": "_DEJ2000", "z": "cz", "ez": "e_cz", "czConvert": True,
        "type": [], "filter": lambda r: (_vznum(r, "q_cz") or 0) >= 3,
    },
    "GAMA": {
        "name": "GAMA DR4", "tables": ["vizier:J/MNRAS/513/439/gamadr4"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": ["Survey"],
        "filter": lambda r: (_vznum(r, "q_z") or 0) >= 3 and str(r.get("IsBest")).strip() == "1",
    },
    "2MRS": {
        "name": "2MRS", "tables": ["vizier:J/ApJS/199/26/table3"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "cz", "ez": None, "czConvert": True,
        "type": ["type"], "filter": lambda r: _has(r, "cz"),
    },
    "WiggleZ": {
        "name": "WiggleZ", "tables": ["vizier:J/MNRAS/474/4151/wigglez"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": ["Class"], "filter": lambda r: (_vznum(r, "q_z") or 0) >= 3,
    },
    "zCOSMOS": {
        "name": "zCOSMOS", "tables": ["vizier:J/ApJS/184/218/table3"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": [], "filter": lambda r: (_vznum(r, "CClass") or 0) >= 2.5,
    },
    "VIPERS": {
        "name": "VIPERS PDR2",
        "tables": ["vizier:J/A+A/609/A84/vipersw1", "vizier:J/A+A/609/A84/vipersw4"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "zsp", "ez": None, "czConvert": False,
        "type": ["classFlag"], "filter": lambda r: (_vznum(r, "zflg") or 0) >= 2.0,
    },
    "OzDES": {
        "name": "OzDES DR1", "tables": ["vizier:J/MNRAS/472/273/ozdesdr1"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": ["types"], "filter": lambda r: (_vznum(r, "Flag") or 0) in (3, 4),
    },
    "2dFGRS": {
        "name": "2dFGRS", "tables": ["vizier:VII/250/2dfgrs"],
        "ra": "_RAJ2000", "dec": "_DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": [], "filter": lambda r: (_vznum(r, "q_z") or 0) >= 3,
    },
    "HECATE": {
        "name": "HECATE", "tables": ["vizier:J/MNRAS/506/1896/hecate"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "HRV", "ez": None, "czConvert": True,
        "type": [], "filter": lambda r: (_vznum(r, "RFlag") or 0) >= 1,
    },
    "GLADE": {
        "name": "GLADE v2", "tables": ["vizier:VII/281/glade2"],
        "ra": "RAJ2000", "dec": "DEJ2000", "z": "z", "ez": None, "czConvert": False,
        "type": ["Flag1"],
        "filter": lambda r: str(r.get("Flag2")).strip() == "2" and str(r.get("Flag1")).strip() in ("G", "Q"),
    },
}


def _zcat_designation(cat_name: str, ra: float, dec: float) -> str:
    try:
        c = coordinates.SkyCoord(ra * u.deg, dec * u.deg, frame="icrs")
        return f"{cat_name} J" + c.to_string("hmsdms", sep="", precision=1).replace(" ", "")
    except Exception:
        return f"{cat_name} ({ra:.5f} {dec:.5f})"


def _norm_vizier(raw: dict, cfg: dict) -> dict | None:
    try:
        if not cfg["filter"](raw):
            return None
    except Exception:
        return None
    ra = _vznum(raw, cfg["ra"]) or _vznum(raw, "_RAJ2000")
    dec = _vznum(raw, cfg["dec"]) or _vznum(raw, "_DEJ2000")
    z = _vznum(raw, cfg["z"])
    if z is None or ra is None or dec is None:
        return None
    ez = _vznum(raw, cfg["ez"])
    if cfg["czConvert"]:
        z = z / _C_KMS
        if ez is not None:
            ez = ez / _C_KMS
    type_label = " / ".join(str(raw.get(c)).strip() for c in cfg["type"] if _has(raw, c))
    return {
        "cat_name": cfg["name"],
        "ra": ra, "dec": dec, "z": z, "z_err": ez, "photoz": None,
        "type": type_label or None,
        "name": _zcat_designation(cfg["name"], ra, dec),
        "sep": _num(raw.get("angDist")),
    }


# --- blocking cores (run via asyncio.to_thread) -----------------------------

def _xmatch_query(cat1: Table, cat2: str, radius_arcsec: float) -> Table | None:
    last_exc: Exception | None = None
    for attempt in range(_RETRIES):
        try:
            XMatch.TIMEOUT = _XMATCH_TIMEOUT
            return XMatch.query(cat1=cat1, cat2=cat2,
                                max_distance=radius_arcsec * u.arcsec,
                                colRA1="ra", colDec1="dec")
        except Exception as exc:           # noqa: BLE001 — retry any transport error
            last_exc = exc
            log.warning("XMatch %s attempt %d failed: %s", cat2, attempt + 1, exc)
            if attempt < _RETRIES - 1:
                time.sleep(3)
    raise CatalogQueryError(f"XMatch {cat2} unreachable: {last_exc}")


def _positions_table(positions: list[tuple[str, float, float]]) -> Table:
    return Table({
        "oid": [str(o) for o, _, _ in positions],
        "ra":  [float(r) for _, r, _ in positions],
        "dec": [float(d) for _, _, d in positions],
    })


def _bulk_xmatch_sync(catalog: str, positions: list[tuple[str, float, float]]) -> dict[str, list[dict]]:
    if not positions:
        return {}
    res = _xmatch_query(_positions_table(positions), XMATCH_CAT2[catalog], _XMATCH_RADIUS[catalog])
    grouped: dict[str, list[dict]] = {}
    if res is None or len(res) == 0:
        return grouped
    normalize = _XMATCH_NORM[catalog]
    for i in range(len(res)):
        raw = _row_to_dict(res, i)
        norm = normalize(raw)
        if norm is not None:
            grouped.setdefault(str(raw.get("oid")), []).append(norm)
    return grouped


def _bulk_xmatch_vizier_sync(cat_id: str, positions: list[tuple[str, float, float]]) -> dict[str, list[dict]]:
    if not positions:
        return {}
    cfg = VIZIER_Z_CATALOGS[cat_id]
    cat1 = _positions_table(positions)
    grouped: dict[str, list[dict]] = {}
    for table_id in cfg["tables"]:        # VIPERS spans two tables
        res = _xmatch_query(cat1, table_id, RADIUS_EXTRA_Z)
        if res is None or len(res) == 0:
            continue
        for i in range(len(res)):
            raw = _row_to_dict(res, i)
            norm = _norm_vizier(raw, cfg)
            if norm is not None:
                grouped.setdefault(str(raw.get("oid")), []).append(norm)
    return grouped


# --- NED via TAP (not on CDS xmatch) ----------------------------------------

NED_TAP_URL = "https://ned.ipac.caltech.edu/tap/"
_ned_tap = None


def _get_ned_tap():
    global _ned_tap
    if _ned_tap is None:
        import pyvo
        _ned_tap = pyvo.dal.TAPService(NED_TAP_URL)
    return _ned_tap


def _angsep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    dra = (ra1 - ra2) * math.cos(math.radians((dec1 + dec2) / 2.0))
    ddec = dec1 - dec2
    return math.hypot(dra, ddec) * 3600.0


def _bulk_ned_tap_sync(positions: list[tuple[str, float, float]],
                       batch_size: int = 100, maxrec: int = 100000) -> dict[str, list[dict]]:
    if not positions:
        return {}
    radius_deg = RADIUS_NED / 3600.0
    grouped: dict[str, list[dict]] = {}
    for start in range(0, len(positions), batch_size):
        batch = positions[start:start + batch_size]
        clauses = " OR ".join(
            f"CONTAINS(POINT('J2000', ra, dec), CIRCLE('J2000', {ra}, {dec}, {radius_deg}))=1"
            for _, ra, dec in batch)
        adql = ("SELECT prefname, ra, dec, z, zunc, zflag, prefphytype "
                f"FROM NEDTAP.objdir WHERE {clauses}")
        last_exc: Exception | None = None
        table = None
        for attempt in range(_RETRIES):
            try:
                table = _get_ned_tap().search(adql, maxrec=maxrec).to_table()
                break
            except Exception as exc:       # noqa: BLE001
                last_exc = exc
                log.warning("NED TAP attempt %d failed: %s", attempt + 1, exc)
                if attempt < _RETRIES - 1:
                    time.sleep(3)
        else:
            raise CatalogQueryError(f"NED TAP unreachable: {last_exc}")

        for i in range(len(table)):
            rra, rdec = _cell(table["ra"][i]), _cell(table["dec"][i])
            if rra is None or rdec is None:
                continue
            raw = None
            for oid, cra, cdec in batch:
                sep = _angsep_arcsec(cra, cdec, float(rra), float(rdec))
                if sep <= RADIUS_NED:
                    if raw is None:
                        raw = _row_to_dict(table, i)
                    grouped.setdefault(str(oid), []).append({
                        "cat_name": "NED",
                        "ra": _num(raw.get("ra")), "dec": _num(raw.get("dec")),
                        "z": _num(raw.get("z")), "z_err": _num(raw.get("zunc")),
                        "photoz": None,
                        "type": raw.get("prefphytype"),
                        "name": raw.get("prefname"),
                        "sep": sep,
                    })
    return grouped


# --- overlay display registry (spec-z catalogs only) ------------------------

# cat_name → (cat_id, color, size) for the Aladin spec-z overlay. Colours mirror
# the old static/js/specz.js so the overlay looks the same; the 3 large all-sky
# catalogs (2dFGRS/HECATE/GLADE) are new and get their own colours.
OVERLAY_DISPLAY: dict[str, tuple[str, str, int]] = {
    "DESI": ("desi", "#ff7f0e", 14),
    "SDSS": ("sdss", "#4fc3f7", 12),
    "SDSS DR16 QSO": ("sdss_qso", "#ce93d8", 12),
    "6dFGS": ("6dfgs", "#81c784", 12),
    "GAMA DR4": ("gama", "#ef9a9a", 12),
    "2MRS": ("2mrs", "#80cbc4", 12),
    "WiggleZ": ("wigglez", "#fff176", 12),
    "zCOSMOS": ("zcosmos", "#f48fb1", 12),
    "VIPERS PDR2": ("vipers", "#ffcc80", 12),
    "OzDES DR1": ("ozdes", "#b0bec5", 12),
    "2dFGRS": ("2dfgrs", "#a5d6a7", 12),
    "HECATE": ("hecate", "#90caf9", 12),
    "GLADE v2": ("glade", "#bcaaa4", 12),
}


def _build_object_record(by_catalog: dict[str, list[dict]]) -> dict:
    """Collapse one object's per-catalog matches into the cached record:
    best spec-z, SIMBAD type, per-catalog counts, and the spec-z sky overlay."""
    counts = {cat: len(rows) for cat, rows in by_catalog.items() if rows}

    # Nearest reliable spectroscopic z across all catalogs (z present).
    best = None
    for cat, rows in by_catalog.items():
        for r in rows:
            if r.get("z") is None:
                continue
            sep = r.get("sep")
            if best is None or (sep is not None and (best["sep"] is None or sep < best["sep"])):
                best = {"z": r["z"], "z_err": r.get("z_err"), "source": cat, "sep": sep}

    simbad_type = None
    for r in by_catalog.get("Simbad", []):
        if r.get("type"):
            simbad_type = r["type"]
            break

    overlay: list[dict] = []
    for cat, rows in by_catalog.items():
        disp = OVERLAY_DISPLAY.get(cat)
        if not disp:                       # Simbad / NED don't get sky markers
            continue
        cat_id, color, size = disp
        for r in rows:
            if r.get("z") is None or r.get("ra") is None or r.get("dec") is None:
                continue
            overlay.append({
                "cat_id": cat_id, "cat_name": cat, "name": r.get("name") or cat,
                "ra": r["ra"], "dec": r["dec"],
                "z": r["z"], "z_err": r.get("z_err"),
                "type": r.get("type"), "sep": r.get("sep"),
                "color": color, "size": size,
            })

    return {"by_catalog": by_catalog, "best_z": best,
            "simbad_type": simbad_type, "counts": counts, "overlay": overlay}


async def bulk_all(positions: list[tuple[str, float, float]]) -> dict[str, dict]:
    """Crossmatch every position against all catalogs concurrently.

    Returns ``{oid: object_record}`` for matched oids only (see
    ``_build_object_record``). Each catalog is independently fault-tolerant — a
    failed/unreachable catalog contributes nothing and never breaks the batch.
    """
    if not positions:
        return {}
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def run(fn: Callable, *args) -> dict[str, list[dict]]:
        async with sem:
            try:
                return await asyncio.to_thread(fn, *args)
            except Exception as exc:       # noqa: BLE001 — one catalog never sinks the batch
                log.warning("xmatch catalog failed (%s): %s", getattr(fn, "__name__", fn), exc)
                return {}

    tasks = [run(_bulk_xmatch_sync, cat, positions) for cat in XMATCH_CAT2]
    tasks += [run(_bulk_xmatch_vizier_sync, cid, positions) for cid in VIZIER_Z_CATALOGS]
    tasks.append(run(_bulk_ned_tap_sync, positions))
    per_catalog_results = await asyncio.gather(*tasks)

    merged: dict[str, dict[str, list[dict]]] = {}
    for result in per_catalog_results:
        for oid, rows in result.items():
            bycat = merged.setdefault(oid, {})
            for r in rows:
                bycat.setdefault(r["cat_name"], []).append(r)

    # Sort each catalog's matches by separation, then build the cached record.
    out: dict[str, dict] = {}
    for oid, by_catalog in merged.items():
        for rows in by_catalog.values():
            rows.sort(key=lambda r: r["sep"] if r.get("sep") is not None else 1e9)
        out[oid] = _build_object_record(by_catalog)
    log.info("bulk_all: %d/%d positions matched.", len(out), len(positions))
    return out
