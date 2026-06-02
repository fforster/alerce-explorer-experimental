"""Lightcurve fetch + normalization.

Returns difference-flux detections plus (where available) forced photometry.
Non-detections and the ZTF v2 mag_corr merge still land in a later slice.

Raw ALeRCE response shapes:
  LSST /lightcurve_api/lightcurve        → {"detections": [...]}
  LSST /lightcurve_api/forced-photometry → [...]
  ZTF  v1 objects/{oid}/lightcurve       → {"detections": [...], "non_detections": [...]}
  ZTF  v2 lightcurve/{oid}               → {"detections": [...], "forced_photometry": [...]}

FP records share the same per-survey field layout as detections, so we reuse
`normalize_det` rather than writing a parallel normalizer.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from . import alerce_client
from . import gp as gp_service
from .features import extract_parametric_fits, pick_default_version
from .normalize import normalize_dets
from .survey_config import SC

log = logging.getLogger(__name__)

# Cone radius (arcsec) for the cross-survey OID match. Both surveys publish
# astrometry good to ~0.1″ for bright objects; 3″ comfortably absorbs the
# worst-case mismatch (faint asteroids etc.) without pulling in unrelated
# neighbors at high galactic latitudes. Same default as the prototype.
XSURVEY_RADIUS_ARCSEC = 3.0


def _bucket_by_band(normalized: list[dict[str, Any]], cfg) -> list[dict[str, Any]]:
    """Group normalized rows by band, drop rows missing mjd/flux, and order
    bands by the survey's canonical ordering so legend entries stay stable
    across objects."""
    bands: dict[str, list[dict[str, Any]]] = {}
    for d in normalized:
        if d.get("mjd") is None or d.get("psf_flux") is None:
            continue
        band = d.get("band") or "unknown"
        bands.setdefault(band, []).append(
            {
                "mjd": d["mjd"],
                # `flux` carries difference-flux (psf_flux on diff image);
                # `sci_flux` is the absolute science-image flux when the survey
                # exposes it. The client picks which to plot via the Diff/Sci
                # toggle; null sci_flux means "no science photometry for this
                # point" and the client skips it in Sci mode.
                "flux": d["psf_flux"],
                "e_flux": d.get("e_psf_flux"),
                "sci_flux": d.get("science_flux"),
                "e_sci_flux": d.get("e_science_flux"),
                # `identifier` + `has_stamp` let the client drive the stamps
                # panel from a chart click without another round trip.
                "identifier": d.get("identifier"),
                "has_stamp": d.get("has_stamp", False),
                # ZTF only: ±1 for brightening/dimming relative to the
                # reference. `flux` above is |diff flux| (converted from a
                # positive magnitude), so consumers that need the *signed*
                # diff flux (e.g. the FLEET overlay's anchor search, which
                # must match the extractor's `brightness > 1 µJy` signed
                # filter) multiply flux by this sign. None on LSST.
                "isdiffpos": d.get("isdiffpos"),
                # Per-detection astrometry — used by the position-residuals
                # panel, which now derives client-side from $lcRaw / $lcXRaw
                # so it inherits the LC's band/survey visibility toggles.
                # Pure pass-through; missing values stay null and the
                # consumer skips the row.
                "ra": d.get("ra"),
                "dec": d.get("dec"),
            }
        )
    ordered = [
        {"name": b, "points": sorted(bands[b], key=lambda p: p["mjd"])}
        for b in cfg.bands
        if b in bands
    ]
    for b, pts in bands.items():
        if b not in cfg.bands:
            ordered.append({"name": b, "points": sorted(pts, key=lambda p: p["mjd"])})
    return ordered


def shape_lightcurve(
    raw: dict[str, Any],
    *,
    survey: str,
    fp_raw: list[dict[str, Any]] | None = None,
    multiband_period: float | None = None,
    parametric_fits: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = SC(survey)
    det_bands = _bucket_by_band(normalize_dets(raw.get("detections") or [], survey), cfg)
    fp_bands = _bucket_by_band(normalize_dets(fp_raw or [], survey), cfg)

    return {
        "survey": survey,
        "bands": det_bands,
        "forced_phot_bands": fp_bands,
        "n_det": sum(len(b["points"]) for b in det_bands),
        "n_fp": sum(len(b["points"]) for b in fp_bands),
        # Gates the client-side Diff/Sci toggle; LSST doesn't publish absolute
        # science flux so the toggle is hidden entirely there.
        "has_science_flux": cfg.has_science_flux,
        # `Multiband_period` from the ALeRCE feature table. When present + >0
        # the Fold button renders in the LC toolbar and the client folds all
        # detections by this period. None ⇒ button hidden (LSST or ZTF object
        # without a period-finding score yet).
        "multiband_period": multiband_period,
        # Parametric-fit params (SPM / FLEET / TDE tail) from the same feature
        # version the Fold button came from. Empty dict ⇒ no overlay picker is
        # rendered; per-overlay dict keyed by band lets the client hide
        # options that have no data.
        "parametric_fits": parametric_fits or {},
    }


def _extract_fp(fp_resp: Any, survey: str) -> list[dict[str, Any]]:
    """Different FP endpoints ship FP records in different shapes."""
    if fp_resp is None:
        return []
    if isinstance(fp_resp, list):
        return fp_resp  # LSST forced-photometry endpoint returns a plain list
    if isinstance(fp_resp, dict):
        # ZTF v2 lightcurve response has forced_photometry as a sub-key.
        fps = fp_resp.get("forced_photometry") or fp_resp.get("forcedPhotometry") or []
        return fps if isinstance(fps, list) else []
    return []


def _merge_ztf_v2_corr(
    v1_dets: list[dict[str, Any]], fp_resp: Any
) -> list[dict[str, Any]]:
    """Overlay v2 mag_corr/e_mag_corr onto v1 detections, joined by candid.

    ZTF's v1 lightcurve almost always emits sigmapsf_corr = 100.0 (the
    "unreliable" sentinel), which normalize_ztf rejects — resulting in empty
    sci-mode error bars. The v2 endpoint (already fetched for FP) carries the
    reference-subtracted, flux-calibrated correction we actually want, so we
    join by candid (string compare for LSST safety even though ZTF candids
    fit in 64 bits) and patch v1's magpsf_corr/sigmapsf_corr before
    normalization. Silently no-ops when the v2 response is missing or not
    the expected shape — the panel still renders, just without sci errors.
    """
    if not isinstance(fp_resp, dict):
        return v1_dets
    v2_dets = fp_resp.get("detections") or []
    if not isinstance(v2_dets, list):
        return v1_dets
    v2_by_candid: dict[str, dict[str, Any]] = {}
    for d in v2_dets:
        if not isinstance(d, dict):
            continue
        cid = d.get("candid")
        if cid is not None:
            v2_by_candid[str(cid)] = d
    if not v2_by_candid:
        return v1_dets
    for d in v1_dets:
        cid = d.get("candid")
        if cid is None:
            continue
        v2 = v2_by_candid.get(str(cid))
        if v2 is None:
            continue
        # Only override when v2 actually supplies a value, so we don't wipe
        # a (rare) reliable v1 field with a None from v2.
        if v2.get("mag_corr") is not None:
            d["magpsf_corr"] = v2["mag_corr"]
        # Prefer e_mag_corr_ext (reference-flux-inclusive error): in practice
        # `e_mag_corr` itself is often also the 100.0 sentinel on ALeRCE
        # ZTF v2, while `e_mag_corr_ext` carries the usable value. Fall back
        # to e_mag_corr when _ext isn't present.
        e_corr = v2.get("e_mag_corr_ext")
        if e_corr is None:
            e_corr = v2.get("e_mag_corr")
        if e_corr is not None:
            d["sigmapsf_corr"] = e_corr
    return v1_dets


async def _fetch_fp(url: str | None) -> Any:
    if url is None:
        return None
    try:
        return await alerce_client._get(url)
    except Exception as e:
        # FP is optional: don't fail the whole light-curve panel if FP is down.
        log.warning("forced-photometry fetch failed (%s): %s", url, e)
        return None


def _extract_multiband_period(features: Any) -> float | None:
    """Pull `Multiband_period` out of the ZTF feature list.

    The endpoint bundles *every* extractor version ever run on the object
    (~5 versions per object), each with its own Multiband_period. We must
    pick the same version the features-table modal defaults to, or the user
    sees one period in the table and a different one under the folded light
    curve (the ZTF20acuwouz bug).

    Strategy: collect versions in first-seen order, delegate version
    selection to `pick_default_version` (shared with the modal), and return
    that version's Multiband_period. Non-positive / non-finite / missing
    values return None so the client hides the Fold button — matching what
    the modal would display as "—" for that same version.
    """
    if not isinstance(features, list):
        return None
    versions_seen: list[str] = []
    versions_set: set[str] = set()
    values: dict[str, float] = {}
    for row in features:
        if not isinstance(row, dict):
            continue
        version = row.get("version") or "—"
        if version not in versions_set:
            versions_set.add(version)
            versions_seen.append(version)
        if row.get("name") != "Multiband_period":
            continue
        v = row.get("value")
        try:
            p = float(v)
        except (TypeError, ValueError):
            continue
        if p > 0 and p == p:  # reject NaN / non-positive
            values[version] = p
    chosen = pick_default_version(versions_seen)
    if chosen is None:
        return None
    return values.get(chosen)


async def _fetch_features_bundle(
    url: str | None, *, survey: str
) -> tuple[float | None, dict[str, Any]]:
    """One features fetch, two outputs: the fold-period and the parametric
    fits overlay bundle. Both derive from the same "latest version" selected
    by `pick_default_version`, so they can't drift apart.

    Mirrors `_fetch_fp`'s error discipline: the light-curve panel must still
    render if the features endpoint is 404/down/slow. A failed fetch just
    means the Fold button and overlay picker stay hidden — not fatal.
    """
    if url is None:
        return None, {}
    try:
        raw = await alerce_client._get(url)
    except Exception as e:
        log.warning("features fetch failed (%s): %s", url, e)
        return None, {}
    period = _extract_multiband_period(raw)
    fits = extract_parametric_fits(raw, survey=survey)
    return period, fits


async def get_lightcurve(*, survey: str, oid: str) -> dict[str, Any]:
    """Detections-only LC fetch. The synchronous render path of the LC
    panel: just enough data to draw the diff-mode chart immediately. FP,
    features (Fold + parametric overlays), and object_info ride deferred
    /htmx/lc_* endpoints and update the chart in place when they arrive.
    """
    cfg = SC(survey)
    raw = await alerce_client._get(cfg.lightcurve_url(oid))
    if not isinstance(raw, dict):
        raise ValueError(f"Unexpected lightcurve response shape: {type(raw).__name__}")
    return shape_lightcurve(raw, survey=survey)


async def get_lc_fp_bundle(*, survey: str, oid: str) -> dict[str, Any] | None:
    """Deferred FP fetch — returns a fresh `shape_lightcurve` payload that
    *also* re-merges v2 mag_corr into v1 detections (ZTF sci-mode error
    bars need this; the synchronous render skips it). The client replaces
    `bands` AND `fpBands` together so detections + FP stay self-consistent.

    Costs an extra LC fetch on top of FP, but they run in parallel so
    wall-clock is `max(LC, FP)` — same as the old all-in-one. None when
    the survey has no FP endpoint (LSST today still does, ZTF too).
    """
    cfg = SC(survey)
    fp_url = cfg.fp_url(oid) if cfg.has_forced_phot else None
    if fp_url is None:
        return None
    raw, fp_resp = await asyncio.gather(
        alerce_client._get(cfg.lightcurve_url(oid)),
        _fetch_fp(fp_url),
        return_exceptions=True,
    )
    if isinstance(raw, Exception):
        raise raw
    if isinstance(fp_resp, Exception):
        fp_resp = None
    if not isinstance(raw, dict):
        raise ValueError(f"Unexpected lightcurve response shape: {type(raw).__name__}")
    if survey == "ztf" and isinstance(raw.get("detections"), list):
        raw["detections"] = _merge_ztf_v2_corr(raw["detections"], fp_resp)
    fp_raw = _extract_fp(fp_resp, survey)
    return shape_lightcurve(raw, survey=survey, fp_raw=fp_raw)


async def get_lc_xsurvey_bundle(
    *, survey: str, oid: str
) -> dict[str, Any] | None:
    """Cross-survey LC bundle: find the same source on the *other* survey via
    cone-search on this object's RA/Dec, then fetch its detections + FP and
    return a `shape_lightcurve`-style payload (with the matched cross-survey
    `oid` stamped on so the client can label / link to it).

    Pipeline:
      1. `object_info` on the original survey → (ra, dec). No coords ⇒ None.
      2. Cone-search the other survey at that position (XSURVEY_RADIUS_ARCSEC).
         No hit ⇒ None.
      3. `get_lc_fp_bundle` on the matched OID — re-uses the existing LC + FP
         + ZTF v2 mag_corr merge so the cross-survey overlay has the same
         data quality as if the user had searched that survey directly.

    Tolerant: any exception in the chain logs + returns None — the LC panel
    must keep working even if the cross-survey lookup fails or times out.
    """
    # Imported lazily to avoid a circular dependency: object_info imports
    # `other_archives`, which doesn't pull lightcurve, but keeping the import
    # local is cheaper than restructuring just to satisfy module-load order.
    from . import object_info as object_info_service
    from . import object_list as object_list_service

    if survey == "lsst":
        other = "ztf"
    elif survey == "ztf":
        other = "lsst"
    else:
        return None
    try:
        info = await object_info_service.get_object_info(survey=survey, oid=oid)
    except Exception as e:
        log.warning("xsurvey: object_info failed (%s/%s): %s", survey, oid, e)
        return None
    if not isinstance(info, dict):
        return None
    ra = info.get("ra")
    dec = info.get("dec")
    if ra is None or dec is None:
        return None
    try:
        listing = await object_list_service.get_objects_list(
            survey=other,
            ra=float(ra),
            dec=float(dec),
            radius=XSURVEY_RADIUS_ARCSEC,
            page=1,
            page_size=1,
        )
    except Exception as e:
        log.warning(
            "xsurvey: %s conesearch failed (ra=%s, dec=%s): %s",
            other, ra, dec, e,
        )
        return None
    items = (listing or {}).get("items") or []
    if not items:
        return None
    other_oid = items[0].get("oid")
    if not other_oid:
        return None
    other_oid = str(other_oid)
    try:
        bundle = await get_lc_fp_bundle(survey=other, oid=other_oid)
    except Exception as e:
        log.warning(
            "xsurvey: get_lc_fp_bundle failed (%s/%s): %s",
            other, other_oid, e,
        )
        return None
    if not isinstance(bundle, dict):
        return None
    # Suppress empty matches: a hit with zero detections + zero FP isn't worth
    # adding a legend group for — keeps the LC clean when the conesearch
    # picks up a stub object on the other survey.
    if not bundle.get("bands") and not bundle.get("forced_phot_bands"):
        return None
    bundle = dict(bundle)
    bundle["oid"] = other_oid
    return bundle


async def get_lc_features_bundle(
    *, survey: str, oid: str
) -> dict[str, Any]:
    """Deferred features fetch — `Multiband_period` (drives the Fold button
    + the periodogram pipeline-period reference line) and the parametric-
    fit bundle (drives the overlay picker). Both pull from `pick_default_
    version` so they can't drift apart from the features-table modal.

    Returns `{multiband_period, parametric_fits}` with both empty when the
    features endpoint isn't configured (LSST) or the upstream call fails.
    """
    cfg = SC(survey)
    url = cfg.features_url(oid)
    if url is None:
        return {"multiband_period": None, "parametric_fits": {}}
    period, fits = await _fetch_features_bundle(url, survey=survey)
    return {"multiband_period": period, "parametric_fits": fits}


# Forced photometry is included in the GP fit only within this many days
# either side of the detection span. Detections pin where the source is real;
# the FP margins give the GP pre-explosion baseline and post-peak decay
# context, while the window keeps the O(N³) solve bounded (a transient's full
# FP history can run to thousands of epochs that would swamp the fit).
GP_FP_WINDOW_DAYS = 30.0


def _iter_band_points(
    bundle: dict[str, Any], survey: str, key: str, flux_key: str, eflux_key: str
):
    """Yield (band_name, lambda_eff, mjd, flux, eflux) for every usable row
    under `bundle[key]` (`"bands"` = detections, `"forced_phot_bands"` = FP),
    reading `flux_key` (`"flux"` for difference flux, `"sci_flux"` for science
    flux). Rows missing the chosen flux are skipped — so a science-flux fit
    naturally drops difference-only epochs. Bands without a configured central
    wavelength (an `unknown` bucket) are skipped too."""
    wl = SC(survey).band_wavelengths
    for band in bundle.get(key) or []:
        lam = wl.get(band.get("name"))
        if lam is None:
            continue
        for p in band.get("points") or []:
            mjd = p.get("mjd")
            flux = p.get(flux_key)
            if mjd is None or flux is None:
                continue
            yield band.get("name"), lam, mjd, flux, p.get(eflux_key)


def _assemble_gp_series(
    sources: list[tuple[str, dict[str, Any]]], *, science: bool = False
) -> list[dict[str, Any]]:
    """Build the per-band {band, surveys, lambda_eff, mjd[], flux[], eflux[]}
    groups the GP consumes from one or more `shape_lightcurve` payloads.

    `science=True` fits the science flux (used for the folded fit, which only
    makes sense on the science light curve); otherwise the difference flux.

    The same band from different telescopes is pooled — ZTF g and LSST g trace
    the same part of the SED, so they become a single `g` group rather than two
    near-identical wavelength channels. This gives the GP more points per band
    directly; distinct band letters (g vs r vs i …) stay coupled through the
    kernel's wavelength axis. The group's `lambda_eff` is the mean of the
    contributing surveys' central wavelengths, and `surveys` records which
    telescopes fed it so the client can keep the curve tied to the legend.

    Detections are always kept; forced photometry only within
    GP_FP_WINDOW_DAYS of the global detection span."""
    flux_key, eflux_key = ("sci_flux", "e_sci_flux") if science else ("flux", "e_flux")

    # Detection MJD envelope across every source, both surveys.
    det_mjds = [
        mjd
        for survey, bundle in sources
        for _n, _l, mjd, _f, _e in _iter_band_points(bundle, survey, "bands", flux_key, eflux_key)
    ]
    if det_mjds:
        lo, hi = min(det_mjds) - GP_FP_WINDOW_DAYS, max(det_mjds) + GP_FP_WINDOW_DAYS
    else:
        # No detections to anchor the window — fall back to FP as-is (the GP's
        # own guards will bail if there still aren't enough points).
        lo, hi = float("-inf"), float("inf")

    groups: dict[str, dict[str, Any]] = {}

    def add(survey: str, name: str, lam: float, mjd: float, flux: float, eflux) -> None:
        g = groups.get(name)
        if g is None:
            g = groups[name] = {
                "band": name, "_wl": {}, "mjd": [], "flux": [], "eflux": [],
            }
        g["_wl"][survey] = lam  # one central wavelength per contributing survey
        g["mjd"].append(mjd)
        g["flux"].append(flux)
        g["eflux"].append(eflux)

    for survey, bundle in sources:
        for name, lam, mjd, flux, eflux in _iter_band_points(
            bundle, survey, "bands", flux_key, eflux_key
        ):
            add(survey, name, lam, mjd, flux, eflux)
        for name, lam, mjd, flux, eflux in _iter_band_points(
            bundle, survey, "forced_phot_bands", flux_key, eflux_key
        ):
            if lo <= mjd <= hi:
                add(survey, name, lam, mjd, flux, eflux)

    series: list[dict[str, Any]] = []
    for g in groups.values():
        wl = g.pop("_wl")
        g["surveys"] = sorted(wl)
        g["lambda_eff"] = sum(wl.values()) / len(wl)
        series.append(g)
    return series


async def get_lc_gp_bundle(
    *, survey: str, oid: str, fold_period: float | None = None, science: bool = False
) -> dict[str, Any]:
    """Deferred multi-band Gaussian-Process overlay fetch.

    Assembles detections + forced photometry (the latter capped to
    GP_FP_WINDOW_DAYS around the detection span) from this object *and*
    (best-effort) its cross-survey counterpart, maps each band to its central
    wavelength, and fits one joint GP over (time, wavelength) — see
    `services/gp.py`. The flux fitted follows the client's display mode:
    difference flux by default, science flux when `science` is set (and always
    when folded — folding only makes sense on the science light curve). When
    `fold_period` is given the fit is done in phase space. The cross-survey
    lookup is wrapped so a failure there still yields a single-survey fit.
    Returns `{oid, available, grid, hyperparams, folded, period, science, ...}`;
    on any fatal error the caller renders an `available=false` fragment.
    """
    # get_lightcurve is detections-only; get_lc_fp_bundle returns the same
    # payload *with* forced_phot_bands populated (and the ZTF v2 mag_corr
    # merge). Fall back to detections-only if the survey has no FP endpoint.
    primary = await get_lc_fp_bundle(survey=survey, oid=oid)
    if primary is None:
        primary = await get_lightcurve(survey=survey, oid=oid)
    sources: list[tuple[str, dict[str, Any]]] = [(survey, primary)]

    try:
        xbundle = await get_lc_xsurvey_bundle(survey=survey, oid=oid)
    except Exception as e:  # pragma: no cover - network/lookup tolerance
        log.warning("lc_gp: xsurvey lookup failed (%s/%s): %s", survey, oid, e)
        xbundle = None
    if isinstance(xbundle, dict) and xbundle.get("survey"):
        sources.append((xbundle["survey"], xbundle))

    # Fit science flux when the client is in Sci mode, and always when folded
    # (folding only makes sense on the science light curve); else difference
    # flux, the alert-native value.
    folding = fold_period is not None and fold_period > 0
    use_science = bool(science) or folding
    result = gp_service.fit_multiband_gp(
        _assemble_gp_series(sources, science=use_science), fold_period=fold_period
    )
    result["oid"] = oid
    result["science"] = use_science
    return result
