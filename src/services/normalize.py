"""Detection normalization — converts raw ALeRCE detections to a common shape.

All visualization code consumes normalized data. Keep this the only place where
survey-specific field names and unit conversions live.

ZTF arrives in AB magnitudes; we convert to nanojansky using AB zero-point 31.4
(mag_AB = -2.5·log10(F_nJy) + 31.4  ⇒  F_nJy = 10^((31.4 - mag)/2.5)).
LSST arrives in nJy already.
"""
from __future__ import annotations

import math
from typing import Any

AB_ZP_NJY = 31.4

ZTF_FID_TO_BAND: dict[int, str] = {1: "g", 2: "r", 3: "i"}

# e_mag_corr sentinel meaning "unreliable" — any value >= this is rejected.
ZTF_ECORR_BAD_THRESHOLD = 1.0

# ZTF uses mag == 100 as "no usable measurement" in forced photometry (the
# forced-flux integration failed or was consistent with zero). Converting
# naively gives ~1e-27 nJy, which would splatter a carpet of useless points
# along the X-axis in flux mode, so reject the exact sentinel at normalization.
ZTF_MAG_SENTINEL = 100.0


def ztf_mag_to_njy(mag: float) -> float:
    return 10.0 ** ((AB_ZP_NJY - mag) / 2.5)


def ztf_magerr_to_njyerr(mag: float, mag_err: float) -> float:
    # sigma_F / F = (ln 10 / 2.5) * sigma_mag
    return ztf_mag_to_njy(mag) * math.log(10.0) / 2.5 * mag_err


def _coerce_isdiffpos(value: Any) -> int | None:
    """ZTF's isdiffpos can be 1, -1, '1', '-1', True, False, 't', 'f'."""
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else -1
    if isinstance(value, (int, float)):
        return 1 if value > 0 else -1
    s = str(value).strip().lower()
    if s in ("1", "t", "true"):
        return 1
    if s in ("-1", "f", "false"):
        return -1
    return None


def normalize_ztf(d: dict[str, Any]) -> dict[str, Any]:
    fid = d.get("fid")
    band = ZTF_FID_TO_BAND.get(fid) if fid is not None else None
    mag = d.get("magpsf", d.get("mag"))
    mag_err = d.get("sigmapsf", d.get("e_mag"))
    if mag is not None and mag >= ZTF_MAG_SENTINEL:
        # mag=100 sentinel ⇒ drop everything flux-derived. Keep the MJD/band
        # bucketing upstream: _bucket_by_band filters out points with a null
        # psf_flux, so a null here cleanly removes the row from the plot.
        mag = None
        mag_err = None

    psf_flux = ztf_mag_to_njy(mag) if mag is not None else None
    e_psf_flux = (
        ztf_magerr_to_njyerr(mag, mag_err)
        if mag is not None and mag_err is not None
        else None
    )

    e_mag_corr = d.get("sigmapsf_corr", d.get("e_mag_corr"))
    if e_mag_corr is not None and e_mag_corr >= ZTF_ECORR_BAD_THRESHOLD:
        e_mag_corr = None
    mag_corr = d.get("magpsf_corr", d.get("mag_corr"))
    if mag_corr is not None and mag_corr >= ZTF_MAG_SENTINEL:
        mag_corr = None
    science_flux = ztf_mag_to_njy(mag_corr) if mag_corr is not None else None
    e_science_flux = (
        ztf_magerr_to_njyerr(mag_corr, e_mag_corr)
        if mag_corr is not None and e_mag_corr is not None
        else None
    )

    candid = d.get("candid")
    # `identifier` is the survey-agnostic key used by the stamps endpoint —
    # candid for ZTF, measurement_id for LSST. Keep it as a string so 64-bit
    # LSST ids survive JSON round-trips.
    ident = str(candid) if candid is not None else None
    return {
        "mjd": d.get("mjd"),
        "band": band,
        "psf_flux": psf_flux,
        "e_psf_flux": e_psf_flux,
        "science_flux": science_flux,
        "e_science_flux": e_science_flux,
        "mag": mag,
        "e_mag": mag_err,
        "mag_corr": mag_corr,
        "e_mag_corr": e_mag_corr,
        "isdiffpos": _coerce_isdiffpos(d.get("isdiffpos")),
        "candid": ident,
        "identifier": ident,
        "has_stamp": bool(d.get("has_stamp")),
    }


def normalize_lsst(d: dict[str, Any]) -> dict[str, Any]:
    flux = d.get("psfFlux")
    flux_err = d.get("psfFluxErr")
    mag = None
    e_mag = None
    if flux is not None and flux > 0:
        mag = AB_ZP_NJY - 2.5 * math.log10(flux)
        if flux_err is not None:
            e_mag = (2.5 / math.log(10.0)) * (flux_err / flux)
    band_raw = d.get("band")
    band_map = d.get("band_map") or {}
    band_letter = band_map.get(str(band_raw)) if band_raw is not None else None
    mid = d.get("measurement_id")
    ident = str(mid) if mid is not None else None
    return {
        "mjd": d.get("mjd"),
        "band": band_letter if band_letter is not None else band_raw,
        "psf_flux": flux,
        "e_psf_flux": flux_err,
        "science_flux": d.get("scienceFlux"),
        "e_science_flux": d.get("scienceFluxErr"),
        "mag": mag,
        "e_mag": e_mag,
        "mag_corr": None,
        "e_mag_corr": None,
        "isdiffpos": None,
        "candid": str(d["candid"]) if d.get("candid") is not None else None,
        "identifier": ident,
        "has_stamp": bool(d.get("has_stamp")),
    }


def normalize_det(d: dict[str, Any], survey: str) -> dict[str, Any]:
    if survey == "ztf":
        return normalize_ztf(d)
    if survey == "lsst":
        return normalize_lsst(d)
    raise ValueError(f"Unknown survey: {survey!r}")


def normalize_dets(dets: list[dict[str, Any]], survey: str) -> list[dict[str, Any]]:
    return [normalize_det(d, survey) for d in dets]
