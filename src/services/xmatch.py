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
import os
import re
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
# Use-case catalogs: stellar + AGN counterparts are point sources expected AT the
# transient position (the transient *is* the star/AGN), so a tight radius avoids
# unrelated neighbours; host galaxies are extended and the transient is offset.
RADIUS_STELLAR = 3.0
RADIUS_AGN = 3.0
RADIUS_HOST_EXT = 60.0

# Crossmatch use-case categories. Every match is tagged with one so the panel
# can group Stellar / Host-galaxy / AGN and derive a classification hint.
CATEGORIES = ("stellar", "host", "agn")

# Fixed category for existing catalogs by display name (default → host). New
# use-case catalogs declare their own category in USECASE_CATALOGS; Simbad is
# routed per-match from its object type (see _simbad_category).
CATEGORY: dict[str, str] = {
    "SDSS DR16 QSO": "agn",   # recategorized from host z-cat
}


def _simbad_category(otype: str | None) -> str:
    """Route a Simbad match into a use-case category from its main_type/otype."""
    s = (otype or "").lower()
    if any(k in s for k in ("qso", "quasar", "seyfert", "agn", "blazar", "bl_lac", "bllac", "liner")):
        return "agn"
    if any(k in s for k in ("star", "rrlyr", "cepheid", "variable", "eclbin", "white",
                            "dwarf", "nova", "cataclys", "pulsat", "yso", "carbon", "wd")):
        return "stellar"
    if "galax" in s or s in ("g", "gig", "gic", "gpair", "ggroup"):
        return "host"
    return "host"   # ambiguous → host (extragalactic-leaning)


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


# --- Use-case catalogs (stellar / host-morphology / AGN; bulk CDS) ----------
#
# Generalized beyond redshift: each catalog declares its category, the display
# fields for the panel, and a `signals` extractor feeding the classification
# hint. Column names are the verified CDS XMatch outputs.

def _f(label: str, col: str, unit: str | None = None):
    return (label, col, unit)


def _sig_gaia(raw: dict) -> dict:
    plx, e_plx, rplx = _num(raw.get("Plx")), _num(raw.get("e_Plx")), _num(raw.get("RPlx"))
    plx_snr = rplx if rplx is not None else (plx / e_plx if plx and e_plx else None)
    pm = _num(raw.get("PM"))
    e_pmra, e_pmde = _num(raw.get("e_pmRA")), _num(raw.get("e_pmDE"))
    e_pm = math.hypot(e_pmra, e_pmde) if (e_pmra and e_pmde) else None
    pm_snr = pm / e_pm if (pm and e_pm) else None
    dist_pc = 1000.0 / plx if (plx and plx > 0) else None
    is_var = str(raw.get("VarFlag") or "").upper() == "VARIABLE"
    return {"parallax": plx, "parallax_snr": plx_snr, "pm": pm, "pm_snr": pm_snr,
            "dist_pc": dist_pc, "gaia_variable": is_var,
            "type_label": "variable star" if is_var else "star"}


def _sig_vsx(raw: dict) -> dict:
    return {"vartype": raw.get("Type"), "period": _num(raw.get("Period")),
            "is_variable": True, "type_label": raw.get("Type")}


def _sig_hyperleda(raw: dict) -> dict:
    return {"type_label": raw.get("OType") or "G"}


_MQ_CLASS = {"Q": "QSO", "A": "AGN", "B": "BL Lac", "K": "radio QSO",
             "N": "narrow AGN", "L": "lensed QSO"}


def _sig_milliquas(raw: dict) -> dict:
    t = str(raw.get("Type") or "")
    cls = _MQ_CLASS.get(t[:1], t[:1] or "AGN") if t else "AGN"
    return {"agn_class": cls, "radio": ("R" in t), "xray": ("X" in t),
            "z": _num(raw.get("z")), "type_label": cls}


_VV_CLASS = {"Q": "QSO", "A": "AGN", "B": "BL Lac"}


def _sig_veron(raw: dict) -> dict:
    cls = _VV_CLASS.get(str(raw.get("Cl") or "")[:1], "AGN")
    return {"agn_class": cls, "z": _num(raw.get("z")), "type_label": cls}


USECASE_CATALOGS: dict[str, dict] = {
    "Gaia DR3": {
        "category": "stellar", "table": "vizier:I/355/gaiadr3", "radius": RADIUS_STELLAR,
        "ra": "RAdeg", "dec": "DEdeg", "name_col": "DR3Name",
        "fields": [_f("Plx", "Plx", "mas"), _f("PM", "PM", "mas/yr"),
                   _f("Gmag", "Gmag", "mag"), _f("BP-RP", "BP-RP", "mag")],
        "signals": _sig_gaia, "filter": lambda r: _has(r, "RAdeg"),
    },
    "VSX": {
        "category": "stellar", "table": "vizier:B/vsx/vsx", "radius": RADIUS_STELLAR,
        "ra": "RAJ2000", "dec": "DEJ2000", "name_col": "Name",
        "fields": [_f("Type", "Type"), _f("Period", "Period", "d"),
                   _f("max", "max", "mag"), _f("min", "min", "mag")],
        "signals": _sig_vsx, "filter": lambda r: _has(r, "Type"),
    },
    "HyperLEDA": {
        "category": "host", "table": "vizier:VII/237/pgc", "radius": RADIUS_HOST_EXT,
        "ra": "_RAJ2000", "dec": "_DEJ2000", "name_col": "ANames",
        "fields": [_f("type", "OType"), _f("morph", "MType"),
                   _f("logD25", "logD25"), _f("PA", "PA", "deg")],
        "signals": _sig_hyperleda, "filter": lambda r: True,
    },
    "Milliquas": {
        "category": "agn", "table": "vizier:VII/294/catalog", "radius": RADIUS_AGN,
        "ra": "RAJ2000", "dec": "DEJ2000", "name_col": "Name",
        "fields": [_f("class", "Type"), _f("z", "z"), _f("Rmag", "Rmag", "mag")],
        "signals": _sig_milliquas, "filter": lambda r: True,
    },
    "Veron-Cetty": {
        "category": "agn", "table": "vizier:VII/258/vv10", "radius": RADIUS_AGN,
        "ra": "_RAJ2000", "dec": "_DEJ2000", "name_col": "Name",
        "fields": [_f("class", "Cl"), _f("z", "z"), _f("Vmag", "Vmag", "mag")],
        "signals": _sig_veron, "filter": lambda r: True,
    },
}


def _norm_generic(raw: dict, cfg: dict) -> dict | None:
    try:
        if cfg.get("filter") and not cfg["filter"](raw):
            return None
    except Exception:
        return None
    ra = _num(raw.get(cfg["ra"])) or _num(raw.get("_RAJ2000"))
    dec = _num(raw.get(cfg["dec"])) or _num(raw.get("_DEJ2000"))
    if ra is None or dec is None:
        return None
    try:
        sig = cfg["signals"](raw) if cfg.get("signals") else {}
    except Exception:
        sig = {}
    fields = []
    for label, col, unit in cfg.get("fields", []):
        v = _cell(raw.get(col))
        if v is not None and str(v).strip() not in ("", "--", "nan"):
            fields.append({"label": label, "value": v, "unit": unit})
    return {
        "cat_name": cfg["display"], "category": cfg["category"],
        "ra": ra, "dec": dec, "sep": _num(raw.get("angDist")),
        "name": _cell(raw.get(cfg.get("name_col"))) if cfg.get("name_col") else None,
        "type": sig.get("type_label"),
        "z": sig.get("z"), "z_err": sig.get("z_err"), "photoz": None,
        "fields": fields, "signals": sig,
    }


def _bulk_generic_sync(cat_key: str, positions: list[tuple[str, float, float]]) -> dict[str, list[dict]]:
    if not positions:
        return {}
    cfg = dict(USECASE_CATALOGS[cat_key], display=cat_key)
    res = _xmatch_query(_positions_table(positions), cfg["table"], cfg["radius"])
    grouped: dict[str, list[dict]] = {}
    if res is None or len(res) == 0:
        return grouped
    for i in range(len(res)):
        raw = _row_to_dict(res, i)
        norm = _norm_generic(raw, cfg)
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


# --- overlay + panel display ------------------------------------------------

# Category colours (Aladin markers + panel tags): stellar = blue, AGN = red,
# host = the per-catalog redshift palette (NED recoloured off red so host
# markers don't clash with the AGN red).
CATEGORY_COLOR = {"stellar": "#42a5f5", "agn": "#ef5350"}
DEFAULT_HOST_COLOR = "#9ccc65"
HOST_COLOR: dict[str, str] = {
    "DESI": "#ff7f0e", "SDSS": "#4fc3f7", "6dFGS": "#81c784", "GAMA DR4": "#ef9a9a",
    "2MRS": "#80cbc4", "WiggleZ": "#fff176", "zCOSMOS": "#f48fb1", "VIPERS PDR2": "#ffcc80",
    "OzDES DR1": "#b0bec5", "2dFGRS": "#a5d6a7", "HECATE": "#90caf9", "GLADE v2": "#bcaaa4",
    "NED": "#4db6ac", "HyperLEDA": "#aed581", "Simbad": "#ba68c8",
}
# Single-column ordering: tight-radius star/AGN counterparts are the strongest
# classifiers, so they lead; host galaxies follow. (stars → AGN → host).
CAT_ORDER = {"stellar": 0, "agn": 1, "host": 2}


def _cat_id(cat_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", cat_name.lower()).strip("_")


def _match_color(m: dict) -> str:
    cat = m.get("category", "host")
    if cat in CATEGORY_COLOR:
        return CATEGORY_COLOR[cat]
    return HOST_COLOR.get(m["cat_name"], DEFAULT_HOST_COLOR)


def _attach_meta(m: dict) -> dict:
    """Ensure every match carries category / fields / signals. Use-case catalogs
    set these in _norm_generic; the older z-cat / Simbad / SDSS / DESI / NED
    normalizers get them filled here."""
    cat = m["cat_name"]
    if "category" not in m:
        m["category"] = _simbad_category(m.get("type")) if cat == "Simbad" else CATEGORY.get(cat, "host")
    sig = m.setdefault("signals", {})
    if m.get("z") is not None and "z" not in sig:
        sig["z"] = m["z"]
        sig["z_err"] = m.get("z_err")
    if m["category"] == "agn" and "agn_class" not in sig:
        sig["agn_class"] = m.get("type") or "AGN"
    if "fields" not in m:
        f = []
        if m.get("z") is not None:
            f.append({"label": "z", "value": m["z"], "unit": None})
        if m.get("photoz") is not None:
            f.append({"label": "photo-z", "value": m["photoz"], "unit": None})
        if m.get("type"):
            f.append({"label": "type", "value": m["type"], "unit": None})
        m["fields"] = f
    return m


def _overlay_label(m: dict) -> str:
    """One-line Aladin marker popup text, per category."""
    s = m.get("signals", {})
    if m["category"] == "stellar":
        bits = []
        if s.get("parallax") is not None:
            d = f", d≈{s['dist_pc']:.0f} pc" if s.get("dist_pc") else ""
            bits.append(f"π={s['parallax']:.2f} mas{d}")
        if s.get("vartype"):
            p = f", P={s['period']:.4g} d" if s.get("period") else ""
            bits.append(f"{s['vartype']}{p}")
        return " · ".join(bits) or (m.get("type") or "star")
    if m["category"] == "agn":
        z = f" z={s['z']:.4g}" if s.get("z") is not None else ""
        flags = ("" + (" radio" if s.get("radio") else "") + (" X-ray" if s.get("xray") else ""))
        return f"{s.get('agn_class', m.get('type') or 'AGN')}{z}{flags}".strip()
    z = m.get("z")
    return f"z={z:.5g}" if z is not None else (m.get("type") or m["cat_name"])


def _classification_hints(matches: list[dict], best_z: dict | None) -> dict:
    """Per-category one-liners surfacing what kind of object this likely is."""
    hints: dict[str, str | None] = {"stellar": None, "agn": None, "host": None}

    # "Galactic candidate" requires an ASTROMETRIC signature (significant
    # parallax or proper motion) — variability alone is not enough, since QSOs
    # and the transients themselves are variable too (a QSO appears as a Gaia
    # "variable" point source and can be in VSX). Variability is appended only
    # as supporting detail once the astrometric gate is passed.
    plx_best = None
    vsx = None
    gaia_var = False
    for m in matches:
        if m["category"] != "stellar":
            continue
        s = m["signals"]
        if (s.get("parallax_snr") or 0) >= 5 or (s.get("pm_snr") or 0) >= 5:
            if plx_best is None or (s.get("parallax_snr") or 0) > (plx_best.get("parallax_snr") or 0):
                plx_best = s
        if s.get("vartype") and vsx is None:
            vsx = (m["cat_name"], s["vartype"], s.get("period"))
        if s.get("gaia_variable"):
            gaia_var = True
    if plx_best:
        tail = []
        if plx_best.get("parallax_snr"):
            d = f", d≈{plx_best['dist_pc']:.0f} pc" if plx_best.get("dist_pc") else ""
            tail.append(f"parallax {plx_best['parallax_snr']:.0f}σ{d}")
        elif plx_best.get("pm_snr"):
            tail.append(f"proper motion {plx_best['pm_snr']:.0f}σ")
        if vsx:
            p = f", P={vsx[2]:.4g} d" if vsx[2] else ""
            tail.append(f"{vsx[0]}: {vsx[1]}{p}")
        elif gaia_var:
            tail.append("Gaia: variable")
        hints["stellar"] = "Galactic candidate" + (" — " + "; ".join(tail) if tail else "")

    # AGN hint from the nearest match, preferring a dedicated AGN catalog
    # (Milliquas/Véron) over a Simbad classification on ties.
    agns = sorted(
        (m for m in matches if m["category"] == "agn"),
        key=lambda m: (m["sep"] if m.get("sep") is not None else 1e9, m["cat_name"] == "Simbad"),
    )
    if agns:
        s = agns[0]["signals"]
        z = f" z={s['z']:.4g}" if s.get("z") is not None else ""
        flags = ("" + (", radio" if s.get("radio") else "") + (", X-ray" if s.get("xray") else ""))
        hints["agn"] = f"AGN/QSO — {agns[0]['cat_name']}: {s.get('agn_class', 'AGN')}{z}{flags}"

    if best_z:
        sep = f", {best_z['sep']:.1f}\"" if best_z.get("sep") is not None else ""
        hints["host"] = f"Extragalactic — host z={best_z['z']:.5g} ({best_z['source']}{sep})"
    return hints


def _build_object_record(by_catalog: dict[str, list[dict]]) -> dict:
    """Collapse one object's per-catalog matches into the cached record: an
    ordered match list (stellar → AGN → host, nearest first), classification
    hints, best host redshift, per-catalog counts, and the category-coloured
    sky overlay."""
    all_matches: list[dict] = []
    for rows in by_catalog.values():
        for m in rows:
            all_matches.append(_attach_meta(m))

    counts = {cat: len(rows) for cat, rows in by_catalog.items() if rows}

    # Best HOST redshift (nearest) → host hint + the redshift overlay markers.
    best = None
    for m in all_matches:
        if m["category"] != "host" or m.get("z") is None:
            continue
        sep = m.get("sep")
        if best is None or (sep is not None and (best["sep"] is None or sep < best["sep"])):
            best = {"z": m["z"], "z_err": m.get("z_err"), "source": m["cat_name"], "sep": sep}

    simbad_type = next((m["type"] for m in by_catalog.get("Simbad", []) if m.get("type")), None)

    # One ordered column: stars first, then AGN, then host; nearest first within.
    matches = sorted(
        all_matches,
        key=lambda m: (CAT_ORDER.get(m["category"], 9), m["sep"] if m.get("sep") is not None else 1e9),
    )
    for m in matches:
        m["color"] = _match_color(m)

    hints = _classification_hints(all_matches, best)

    # Sky overlay: host markers need a redshift (as before); stellar/AGN markers
    # need only a position (point source at the transient).
    overlay: list[dict] = []
    for m in matches:
        if m.get("ra") is None or m.get("dec") is None:
            continue
        if m["category"] == "host" and m.get("z") is None:
            continue
        overlay.append({
            "cat_id": _cat_id(m["cat_name"]), "cat_name": m["cat_name"],
            "category": m["category"], "name": m.get("name") or m["cat_name"],
            "ra": m["ra"], "dec": m["dec"], "z": m.get("z"), "z_err": m.get("z_err"),
            "type": m.get("type"), "sep": m.get("sep"),
            "label": _overlay_label(m), "color": _match_color(m),
            "size": 14 if m["cat_name"] == "DESI" else 12,
        })

    return {"by_catalog": by_catalog, "matches": matches, "hints": hints,
            "best_z": best, "simbad_type": simbad_type, "counts": counts, "overlay": overlay}


async def bulk_all(positions: list[tuple[str, float, float]]) -> dict[str, dict]:
    """Crossmatch every position against all catalogs concurrently.

    Returns ``{oid: object_record}`` for matched oids only (see
    ``_build_object_record``). Each catalog is independently fault-tolerant — a
    failed/unreachable catalog contributes nothing and never breaks the batch.
    """
    if not positions:
        return {}
    # Offline test / e2e mode: astroquery + pyvo use their own HTTP clients,
    # which bypass the httpx replay transport (services/replay.py) — so they
    # would hit the real CDS/NED services on every page render under the
    # otherwise-hermetic Playwright suite. Skip live catalog calls when the
    # replay harness is active so tests stay offline and deterministic.
    if os.getenv("EXPLORER_REPLAY_DIR"):
        log.info("bulk_all skipped (EXPLORER_REPLAY_DIR set — offline mode)")
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
    tasks += [run(_bulk_generic_sync, k, positions) for k in USECASE_CATALOGS]
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
