"""htmx endpoints — return HTML fragments via Jinja2.

Slice 2: search_objects/, classes_select, and list_objects now call the
public ALeRCE API via the service layer. Errors are rendered into the same
fragment so htmx can swap them into the results slot.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates

from ..services import analytics as analytics_service
from ..services import avro as avro_service
from ..services import classifiers as classifiers_service
from ..services import coord_residuals as coord_residuals_service
from ..services import crossmatch as crossmatch_service
from ..services import features as features_service
from ..services import lightcurve as lightcurve_service
from ..services import object_info as object_info_service
from ..services import object_list as object_list_service
from ..services import probability as probability_service
from ..services import stamps as stamps_service
from ..services import tns as tns_service
from ..services import xmatch_cache as xmatch_cache_service
from ..services.survey_config import SC, TAI_MINUS_UTC_SECONDS, known_surveys

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = BASE_DIR / "templates"

router = APIRouter()

templates = Jinja2Templates(directory=str(TEMPLATES_DIR), autoescape=True, auto_reload=True)
templates.env.globals["API_URL"] = os.getenv("API_URL", "http://localhost:8000")
# `tojson` filter produces JS-safe JSON for embedding in data-* attributes.
templates.env.filters["tojson_compact"] = lambda v: json.dumps(v, separators=(",", ":"))


def _xmatch_positions(items: list[dict]) -> list[dict]:
    """Map listing rows → [{oid, ra, dec}] for the bulk-crossmatch prefetch,
    dropping rows without coordinates. Coords are the same meanra/meandec the
    results table renders."""
    out = []
    for r in items or []:
        ra, dec = r.get("meanra"), r.get("meandec")
        if ra is not None and dec is not None and r.get("oid") is not None:
            out.append({"oid": str(r.get("oid")), "ra": ra, "dec": dec})
    return out


templates.env.filters["xmatch_positions"] = _xmatch_positions

STATIC_DIR = BASE_DIR / "static"


def _asset_version() -> str:
    """Cache-busting token = latest mtime across the JS/CSS we ship.

    Appended as `?v=…` to local `<script>`/`<link>` includes in base.html so
    the browser refetches our static assets the moment a file changes —
    otherwise an edited helpers.js/object_nav.js keeps running from the
    browser's disk cache and bug fixes appear not to take (the exact symptom
    that made "Back to results" look broken after it was fixed server-side).
    Cheap: a handful of files, and base.html only renders on full page loads.
    """
    latest = 0.0
    for sub in ("js", "css"):
        directory = STATIC_DIR / sub
        if directory.is_dir():
            for path in directory.glob("*"):
                try:
                    latest = max(latest, path.stat().st_mtime)
                except OSError:
                    pass
    return str(int(latest))


templates.env.globals["asset_v"] = _asset_version
# Callable (not a snapshot) so the env flag is read per-render — keeps tests
# that toggle ANALYTICS_ENABLED honest, and lets the operator flip it without
# a process restart.
templates.env.globals["analytics_enabled"] = analytics_service.is_enabled


def _validate_survey(survey: str) -> None:
    if survey not in known_surveys():
        raise HTTPException(status_code=400, detail=f"Unknown survey: {survey!r}")


# OID → survey detection for the legacy `/object/{oid}` redirect.
# ZTF OIDs follow `ZTF<2-digit year><lowercase letters>` (e.g.
# ZTF18adqimwe). LSST OIDs are 18-digit pure-numeric measurement-table
# IDs (~313888627082919999). Anything else is rejected — better to 400
# than guess and serve a wrong-survey detail view.
_ZTF_OID_RE = re.compile(r"^ZTF\d{2}[a-z]+$")


def _detect_survey_from_oid(oid: str) -> str | None:
    if _ZTF_OID_RE.match(oid):
        return "ztf"
    if oid.isdigit():
        return "lsst"
    return None


def _share_url(
    *,
    survey: str | None,
    oid: str | None = None,
    classifier: str | None = None,
    classifier_version: str | None = None,
    identifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    firstmjd_min: float | None = None,
    firstmjd_max: float | None = None,
    lastmjd_min: float | None = None,
    lastmjd_max: float | None = None,
    ra: float | None = None,
    dec: float | None = None,
    radius: float | None = None,
    oids: str | None = None,
    page: int | None = None,
) -> str:
    """Build the shareable `/?...` URL from the pieces that make up the view.

    Kept in one place so the HX-Push-Url header and the server-rendered initial
    markup can't drift. Empty/None pieces are dropped so the URL stays legible.

    Param naming (follows the production explorer):
      - `oid` carries a single object (detail view) OR a comma-separated set
        (multi-object list search), e.g. `?survey=lsst&oid=123,456,789`.
      - `oids` only appears in the drill-in case — a single-object `oid` plus
        the back-context list — where the list can't share the `oid` key
        without colliding with the detail selector.
      - `page` only appears when > 1.
      - `probability` only appears when > 0.
    """
    params: list[tuple[str, str]] = []
    if survey:
        params.append(("survey", survey))
    if oid:
        params.append(("oid", oid))
    if classifier:
        params.append(("classifier", classifier))
    if classifier_version:
        params.append(("classifier_version", classifier_version))
    if class_name:
        params.append(("class_name", class_name))
    if probability is not None and probability > 0:
        params.append(("probability", str(probability)))
    if n_det_min is not None:
        params.append(("n_det_min", str(n_det_min)))
    if n_det_max is not None:
        params.append(("n_det_max", str(n_det_max)))
    # Discovery-date range (MJD): persisted as plain floats so the form
    # input round-trips cleanly. The client parses any input format into
    # MJD before submitting, so the URL form is always numeric.
    if firstmjd_min is not None:
        params.append(("firstmjd_min", str(firstmjd_min)))
    if firstmjd_max is not None:
        params.append(("firstmjd_max", str(firstmjd_max)))
    # Last-detection-date range (MJD): same numeric round-trip as firstmjd.
    if lastmjd_min is not None:
        params.append(("lastmjd_min", str(lastmjd_min)))
    if lastmjd_max is not None:
        params.append(("lastmjd_max", str(lastmjd_max)))
    # Conesearch — only meaningful when ra+dec are both present; radius
    # rides along but defaults upstream when omitted.
    if ra is not None and dec is not None:
        params.append(("ra", str(ra)))
        params.append(("dec", str(dec)))
        if radius is not None:
            params.append(("radius", str(radius)))
    if oids:
        # Original-explorer convention: a multi-object selection lives under
        # `oid` as a comma-separated list (e.g. `?survey=lsst&oid=123,456,789`).
        # Emit the list there. The only time a single-object `oid` is also set
        # is a drill-in from a list (detail view): keep the back-context list
        # under `oids` then, so it doesn't collide with the detail selector.
        params.append(("oids" if oid else "oid", oids))
    if page is not None and page > 1:
        params.append(("page", str(page)))
    if identifier:
        params.append(("identifier", identifier))
    # safe="," keeps the OID-list separators literal (`oid=123,456,789`) instead
    # of percent-encoding them to `%2C`, matching the production explorer's URL.
    return "/" if not params else f"/?{urlencode(params, safe=',')}"


@router.get("/object/{oid}")
async def object_redirect(oid: str, request: Request):
    """Legacy-URL compatibility for `https://alerce.online/object/<oid>`.

    The production ALeRCE frontend exposes object detail pages at
    `/object/<oid>` without a survey qualifier, so links shared in
    papers, slack, or browser history land here. Auto-detects the
    survey from the OID shape — `ZTF<digits><letters>` ⇒ ZTF, all-
    digits ⇒ LSST, anything else ⇒ 400 — and 302s to the explorer's
    canonical deep-link form `/?survey=…&oid=…`. Any extra query
    params on the original URL (e.g. `?identifier=…` for a specific
    detection) ride along.
    """
    survey = _detect_survey_from_oid(oid)
    if survey is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Could not infer survey from oid {oid!r}. Expected a ZTF OID "
                "(e.g. ZTF18adqimwe) or an LSST measurement_id (all-digit)."
            ),
        )
    params: list[tuple[str, str]] = [("survey", survey), ("oid", oid)]
    # Preserve any query string on the legacy URL (most useful: identifier=
    # for a deep-link to a specific detection's stamps).
    for key, val in request.query_params.multi_items():
        if key in ("survey", "oid"):
            continue  # let the inferred values win
        params.append((key, val))
    return RedirectResponse(url=f"/?{urlencode(params)}", status_code=302)


@router.get("/", response_class=HTMLResponse)
async def index(
    request: Request,
    survey: str | None = None,
    oid: str | None = None,
    classifier: str | None = None,
    classifier_version: str | None = None,
    identifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    firstmjd_min: float | None = None,
    firstmjd_max: float | None = None,
    lastmjd_min: float | None = None,
    lastmjd_max: float | None = None,
    ra: float | None = None,
    dec: float | None = None,
    radius: float | None = None,
    oids: str | None = None,
    page: int | None = None,
) -> HTMLResponse:
    # Query params hydrate the initial view: `?oid=…` jumps straight to the
    # detail, filter params (`classifier`, `class_name`, `probability`,
    # `n_det_min/max`, `firstmjd_min/max`, `ra`/`dec`/`radius`, `oids`,
    # `page`) pre-populate the search form and — when no `oid=` is set —
    # pre-run the listing with that filter set. `identifier` pre-selects a
    # specific detection in the stamps/highlight panels. Fresh `/` keeps
    # the empty-hint default.
    if survey:
        _validate_survey(survey)
    elif oid or oids:
        # No survey pinned but we have OID(s): guess it from the OID shape
        # (ZTF<2-digit year><letters> ⇒ ztf, all-digit ⇒ lsst), same rule the
        # legacy /object/{oid} redirect uses. Lets a bare `?oid=…` link resolve
        # to the right survey instead of always falling back to the default.
        # Mixed-survey lists are unusual, so the first OID decides.
        candidates = object_list_service.parse_oid_list(oid or oids)
        if candidates:
            survey = _detect_survey_from_oid(candidates[0]) or survey
    # Original-explorer convention: `oid` carries either a single object (→
    # detail view) or a comma-separated set (→ multi-object list). A
    # multi-valued `oid` is the list-search filter, so route it through the
    # same path as the legacy `oids` param and clear the single-object
    # selector. A single `oid` keeps opening the detail view.
    if oid and len(object_list_service.parse_oid_list(oid)) > 1:
        oids = oids or oid
        oid = None
    return templates.TemplateResponse(
        request,
        "index.html.jinja",
        {
            "initial_survey": survey or "lsst",
            "initial_oid": oid,
            "initial_classifier": classifier,
            "initial_classifier_version": classifier_version,
            "initial_identifier": identifier,
            "initial_class_name": class_name,
            "initial_probability": probability,
            "initial_n_det_min": n_det_min,
            "initial_n_det_max": n_det_max,
            "initial_firstmjd_min": firstmjd_min,
            "initial_firstmjd_max": firstmjd_max,
            "initial_lastmjd_min": lastmjd_min,
            "initial_lastmjd_max": lastmjd_max,
            "initial_ra": ra,
            "initial_dec": dec,
            "initial_radius": radius,
            "initial_oids": oids,
            "initial_page": page,
        },
    )


@router.get("/htmx/search_objects/", response_class=HTMLResponse)
async def search_form(
    request: Request,
    survey: str = "lsst",
    classifier: str | None = None,
    classifier_version: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    firstmjd_min: float | None = None,
    firstmjd_max: float | None = None,
    lastmjd_min: float | None = None,
    lastmjd_max: float | None = None,
    ra: float | None = None,
    dec: float | None = None,
    radius: float | None = None,
    oids: str | None = None,
) -> HTMLResponse:
    _validate_survey(survey)
    try:
        tidy = await classifiers_service.get_tidy_classifiers(survey)
    except Exception as e:  # upstream API unreachable
        log.warning("classifier fetch failed for %s: %s", survey, e)
        tidy = []
    # Pre-select the survey's default classifier when the URL doesn't pin
    # one. Resolving here (instead of inside the template) means the same
    # value flows through `selected_classifier` to the dependent class
    # list and version dropdown — no separate "default" code paths.
    if classifier is None:
        default = SC(survey).default_classifier
        if default and any(c["classifier_name"] == default for c in tidy):
            classifier = default
    return templates.TemplateResponse(
        request,
        "search_form/form.html.jinja",
        {
            "survey": survey,
            "classifiers": tidy,
            "selected_classifier": classifier,
            "selected_classifier_version": classifier_version,
            "selected_class_name": class_name,
            "selected_probability": probability,
            "selected_n_det_min": n_det_min,
            "selected_n_det_max": n_det_max,
            "selected_firstmjd_min": firstmjd_min,
            "selected_firstmjd_max": firstmjd_max,
            "selected_lastmjd_min": lastmjd_min,
            "selected_lastmjd_max": lastmjd_max,
            "selected_ra": ra,
            "selected_dec": dec,
            "selected_radius": radius,
            "selected_oids": oids,
        },
    )


@router.get("/htmx/classes_select", response_class=HTMLResponse)
async def classes_select(
    request: Request,
    classifier_classes: Annotated[list[str] | None, Query()] = None,
) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "search_form/dependent_select.html.jinja",
        {"classes": classifier_classes or []},
    )


@router.get("/htmx/list_objects", response_class=HTMLResponse)
async def list_objects(
    request: Request,
    survey: str | None = None,
    classifier: str | None = None,
    classifier_version: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    firstmjd_min: float | None = None,
    firstmjd_max: float | None = None,
    lastmjd_min: float | None = None,
    lastmjd_max: float | None = None,
    ra: float | None = None,
    dec: float | None = None,
    radius: float | None = None,
    oids: str | None = None,
    page: int = 1,
    page_size: int = object_list_service.DEFAULT_PAGE_SIZE,
) -> HTMLResponse:
    if not survey:
        empty = {
            "items": [], "current_page": 1,
            "has_prev": False, "prev": False,
            "has_next": False, "next": False,
            "info_message": "Pick a survey and hit Search.",
        }
        return templates.TemplateResponse(
            request,
            "main_table_objects/objects_table.html.jinja",
            {"objects_list": empty, "survey": None},
        )
    _validate_survey(survey)
    try:
        data = await object_list_service.get_objects_list(
            survey=survey,
            classifier=classifier,
            classifier_version=classifier_version,
            class_name=class_name,
            probability=probability,
            n_det_min=n_det_min,
            n_det_max=n_det_max,
            firstmjd_min=firstmjd_min,
            firstmjd_max=firstmjd_max,
            lastmjd_min=lastmjd_min,
            lastmjd_max=lastmjd_max,
            ra=ra,
            dec=dec,
            radius=radius,
            oid=oids,  # service still uses `oid=` internally for the OID-list filter
            page=max(page, 1),
            page_size=page_size,
        )
    except Exception as e:
        log.exception("list_objects failed")
        data = {
            "items": [], "current_page": page,
            "has_prev": False, "prev": False,
            "has_next": False, "next": False,
            "info_message": f"Upstream error: {e}",
        }
    # Known-total optimisation: when the user filtered by an OID list, the
    # service paginates locally and returns an exact `total` (matched objects),
    # so the dropdown can render the full 1..N range up-front instead of the
    # "…" unknown-total marker. Prefer the real matched count — some entered
    # OIDs may not exist upstream — and fall back to the entered count if a
    # transient error skipped the service total.
    parsed_oids = object_list_service.parse_oid_list(oids)
    if parsed_oids:
        total_objects = data.get("total")
        if total_objects is None:
            total_objects = len(parsed_oids)
        data["total_pages"] = max(1, (total_objects + page_size - 1) // page_size)
    resp = templates.TemplateResponse(
        request,
        "main_table_objects/objects_table.html.jinja",
        {
            "objects_list": data,
            "survey": survey,
            "classifier": classifier,
            "classifier_version": classifier_version,
            "class_name": class_name,
            "probability": probability,
            "n_det_min": n_det_min,
            "n_det_max": n_det_max,
            "firstmjd_min": firstmjd_min,
            "firstmjd_max": firstmjd_max,
            "lastmjd_min": lastmjd_min,
            "lastmjd_max": lastmjd_max,
            "ra": ra,
            "dec": dec,
            "radius": radius,
            "oids": oids,
            # `page` is the *current* page for echoing in row-click URLs; the
            # table template reads `objects_list.current_page` for pagination,
            # so there's no collision.
            "page": page,
        },
    )
    # HX-Push-Url updates the browser address bar to a shareable `/?…` form
    # without reloading; htmx only honors it for requests it made itself.
    resp.headers["HX-Push-Url"] = _share_url(
        survey=survey,
        classifier=classifier,
        classifier_version=classifier_version,
        class_name=class_name,
        probability=probability,
        n_det_min=n_det_min,
        n_det_max=n_det_max,
        firstmjd_min=firstmjd_min,
        firstmjd_max=firstmjd_max,
        lastmjd_min=lastmjd_min,
        lastmjd_max=lastmjd_max,
        ra=ra,
        dec=dec,
        radius=radius,
        oids=oids,
        page=page,
    )
    return resp


@router.get("/htmx/detail", response_class=HTMLResponse)
async def detail(
    request: Request,
    oid: str,
    survey_id: str,
    classifier: str | None = None,
    classifier_version: str | None = None,
    identifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    firstmjd_min: float | None = None,
    firstmjd_max: float | None = None,
    lastmjd_min: float | None = None,
    lastmjd_max: float | None = None,
    ra: float | None = None,
    dec: float | None = None,
    radius: float | None = None,
    oids: str | None = None,
    page: int | None = None,
) -> HTMLResponse:
    _validate_survey(survey_id)
    # Filter params are passthrough: the detail route doesn't use them, but
    # it echoes them back into HX-Push-Url so "share" and "back" preserve the
    # search context that led here.
    resp = templates.TemplateResponse(
        request,
        "object_detail/container.html.jinja",
        {
            "oid": oid,
            "survey_id": survey_id,
            "classifier": classifier,
            "identifier": identifier,
        },
    )
    resp.headers["HX-Push-Url"] = _share_url(
        survey=survey_id,
        oid=oid,
        classifier=classifier,
        classifier_version=classifier_version,
        identifier=identifier,
        class_name=class_name,
        probability=probability,
        n_det_min=n_det_min,
        n_det_max=n_det_max,
        firstmjd_min=firstmjd_min,
        firstmjd_max=firstmjd_max,
        lastmjd_min=lastmjd_min,
        lastmjd_max=lastmjd_max,
        ra=ra,
        dec=dec,
        radius=radius,
        oids=oids,
        page=page,
    )
    return resp


@router.get("/htmx/lightcurve", response_class=HTMLResponse)
async def lightcurve(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Synchronous LC render — *detections only*.

    Forced photometry, features (Multiband_period + parametric fits) and
    object coordinates (ra/dec for the dust proxy + ZTF DR overlay) are
    fetched by deferred /htmx/lc_* endpoints below and update the chart
    when they arrive. TNS redshift rides the basic-info panel's deferred
    /htmx/tns_lookup, which OOB-populates `#lc-redshift-{oid}` if it's in
    the DOM. Cuts the LC panel's perceived render time from ~15s (TNS
    timeout dominated) to ~2-3s (just the LC fetch).
    """
    _validate_survey(survey_id)
    try:
        data = await lightcurve_service.get_lightcurve(survey=survey_id, oid=oid)
    except Exception as e:
        log.exception("lightcurve failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "lightcurve/lightcurvePreview.html.jinja",
        {
            "lc": data,
            "oid": oid,
            "survey_id": survey_id,
            # ra / dec start unknown — the deferred /htmx/lc_info fetch fills
            # them in once object_info responds. Templates that gate on coords
            # render the controls hidden (tw-hidden) and the JS reveals them.
            "ra": None,
            "dec": None,
            "extinction_r": SC(survey_id).extinction_r,
        },
    )


@router.get("/htmx/lc_fp", response_class=HTMLResponse)
async def lc_fp(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Deferred FP fetch — re-shapes the LC payload with FP merged in and
    returns an inline-script fragment that hands the new bundle to
    `window.lcSetBundle(canvasId, bundle)`. Replaces the `<span>` in the
    LC panel's loading strip via `outerHTML` so the indicator disappears
    on success."""
    _validate_survey(survey_id)
    try:
        bundle = await lightcurve_service.get_lc_fp_bundle(
            survey=survey_id, oid=oid
        )
    except Exception:
        log.exception("lc_fp failed")
        bundle = None
    return templates.TemplateResponse(
        request,
        "lightcurve/lcFpFragment.html.jinja",
        {"oid": oid, "bundle": bundle},
    )


@router.get("/htmx/lc_features", response_class=HTMLResponse)
async def lc_features(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Deferred features fetch — drives the Fold button (`Multiband_period`)
    and the parametric-fit overlay picker. Returns an inline-script
    fragment that calls `window.lcSetFeatures(canvasId, features)`."""
    _validate_survey(survey_id)
    try:
        features = await lightcurve_service.get_lc_features_bundle(
            survey=survey_id, oid=oid
        )
    except Exception:
        log.exception("lc_features failed")
        features = {"multiband_period": None, "parametric_fits": {}}
    return templates.TemplateResponse(
        request,
        "lightcurve/lcFeaturesFragment.html.jinja",
        {"oid": oid, "features": features},
    )


@router.get("/htmx/lc_info", response_class=HTMLResponse)
async def lc_info(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Deferred object_info fetch — supplies ra/dec to the LC panel for
    the dust-proxy lookup and the ZTF DR archival-photometry overlay.
    Returns an inline-script fragment that calls
    `window.lcSetCoords(canvasId, ra, dec)`."""
    _validate_survey(survey_id)
    ra: float | None = None
    dec: float | None = None
    try:
        info = await object_info_service.get_object_info(
            survey=survey_id, oid=oid
        )
    except Exception:
        log.exception("lc_info failed")
        info = None
    if isinstance(info, dict):
        ra = info.get("ra")
        dec = info.get("dec")
    return templates.TemplateResponse(
        request,
        "lightcurve/lcInfoFragment.html.jinja",
        {"oid": oid, "ra": ra, "dec": dec},
    )


@router.get("/htmx/lc_xsurvey", response_class=HTMLResponse)
async def lc_xsurvey(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Deferred cross-survey LC fetch — looks up the same source on the
    *other* survey via cone-search and hands its detections+FP bundle to
    `window.lcSetCrossSurvey(canvasId, bundle)` so the chart can overlay
    LSST + ZTF photometry side-by-side. Returns a script-only fragment
    that always also calls `lcMaybeHideLoadingStrip` so the placeholder
    spinner stops whether or not a match was found."""
    _validate_survey(survey_id)
    try:
        bundle = await lightcurve_service.get_lc_xsurvey_bundle(
            survey=survey_id, oid=oid
        )
    except Exception:
        log.exception("lc_xsurvey failed")
        bundle = None
    return templates.TemplateResponse(
        request,
        "lightcurve/lcXSurveyFragment.html.jinja",
        {"oid": oid, "bundle": bundle},
    )


@router.get("/htmx/lc_gp", response_class=HTMLResponse)
async def lc_gp(
    request: Request, oid: str, survey_id: str,
    fold_period: float | None = None, science: bool = False,
) -> HTMLResponse:
    """Deferred multi-band Gaussian-Process overlay fetch — fired lazily when
    the user picks "GP" in the LC overlay <select> (not on load: a GP fit is
    the most expensive overlay). Assembles detections from this object + its
    cross-survey counterpart, fits one joint GP over (time, wavelength), and
    hands the per-band flux grid to `window.lcSetGp(canvasId, bundle)`. The fit
    follows the client's display mode: `science` selects science vs difference
    flux, and `fold_period` (always science) fits the folded phase curve. On
    any failure returns an `available=false` bundle so the client clears the
    spinner and reverts the picker."""
    _validate_survey(survey_id)
    try:
        bundle = await lightcurve_service.get_lc_gp_bundle(
            survey=survey_id, oid=oid, fold_period=fold_period, science=science,
        )
    except Exception:
        log.exception("lc_gp failed")
        bundle = {"available": False, "grid": [], "cov_offdiag": {},
                  "hyperparams": {},
                  "message": "Gaussian process fit failed.", "oid": oid}
    return templates.TemplateResponse(
        request,
        "lightcurve/lcGpFragment.html.jinja",
        {"oid": oid, "bundle": bundle},
    )


@router.get("/htmx/tns_lookup", response_class=HTMLResponse)
async def tns_lookup(
    request: Request, oid: str, ra: float | None = None, dec: float | None = None
) -> HTMLResponse:
    """Deferred TNS lookup — fired by the basic-info panel's TNS placeholder
    once it has ra/dec. Returns the TNS row HTML for the basic-info row
    *plus* a tiny inline script that auto-populates `#lc-redshift-{oid}`
    (LC z input) when the TNS report carries a redshift. The script is
    a no-op when the LC panel hasn't rendered yet — TNS is strictly
    additive."""
    tns = await tns_service.get_tns_info(ra=ra, dec=dec)
    return templates.TemplateResponse(
        request,
        "tns/tnsLookupFragment.html.jinja",
        {"oid": oid, "tns": tns},
    )


@router.get("/htmx/coord_residuals", response_class=HTMLResponse)
async def coord_residuals(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Position-residuals panel — now a static shell.

    The actual residuals derive client-side from the live LC chart
    (`coord_residuals.js` walks `chart.$lcRaw` + `chart.$lcXRaw`, applies
    the LC legend's visibility, and re-renders on `lc:visibilityChanged`).
    No upstream LC fetch happens here, so the panel paints instantly and
    inherits cross-survey + band-toggle state for free. The
    `shape_coord_residuals` service is preserved for programmatic use.
    """
    _validate_survey(survey_id)
    return templates.TemplateResponse(
        request,
        "coord_residuals/coordResidualsPreview.html.jinja",
        {"oid": oid, "survey_id": survey_id},
    )


@router.get("/htmx/stamps", response_class=HTMLResponse)
async def stamps(
    request: Request,
    oid: str,
    survey_id: str,
    identifier: str | None = None,
) -> HTMLResponse:
    _validate_survey(survey_id)
    try:
        ctx = await stamps_service.get_stamps_context(
            survey=survey_id, oid=oid, identifier=identifier
        )
    except Exception as e:
        log.exception("stamps failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "stamps/stampsPreview.html.jinja",
        {"ctx": ctx, "oid": oid, "survey_id": survey_id},
    )


@router.get("/htmx/avro", response_class=HTMLResponse)
async def avro(
    request: Request,
    oid: str,
    candid: str,
    survey_id: str,
) -> HTMLResponse:
    """AVRO record metadata viewer — renders the per-detection candidate
    fields as a table inside a modal overlay (same `#avro-modal` slot
    pattern as `#features-modal`). LSST measurement_ids land an
    "AVRO is ZTF-only" message instead of a table, so the button can
    stay visible regardless of the click survey."""
    _validate_survey(survey_id)
    try:
        ctx = await avro_service.get_avro_info(
            oid=oid, candid=candid, survey=survey_id
        )
    except Exception as e:
        log.exception("avro failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "avro/avroTable.html.jinja",
        {"ctx": ctx, "oid": oid, "candid": candid, "survey_id": survey_id},
    )


@router.get("/htmx/probability", response_class=HTMLResponse)
async def probability(
    request: Request,
    oid: str,
    survey_id: str,
    classifier: str | None = None,
) -> HTMLResponse:
    _validate_survey(survey_id)
    try:
        ctx = await probability_service.get_probability_context(
            survey=survey_id, oid=oid, classifier=classifier
        )
    except Exception as e:
        log.exception("probability failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "radar/radarPreview.html.jinja",
        {"ctx": ctx, "oid": oid, "survey_id": survey_id},
    )


@router.get("/htmx/aladin", response_class=HTMLResponse)
async def aladin(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    _validate_survey(survey_id)
    try:
        info = await object_info_service.get_object_info(survey=survey_id, oid=oid)
    except Exception as e:
        log.exception("aladin failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "aladin/aladinPreview.html.jinja",
        {
            "oid": oid,
            "survey_id": survey_id,
            "ra": info.get("ra"),
            "dec": info.get("dec"),
            "lastmjd": info.get("lastmjd"),
        },
    )


@router.get("/htmx/object_information", response_class=HTMLResponse)
async def object_information(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Synchronous basic-info render. TNS rides the deferred /htmx/tns_lookup
    endpoint (the bridge can take 10-12s, often timing out — it used to
    block this render and the LC handler too). The placeholder div in the
    template fires hx-get="/htmx/tns_lookup" on load, so the panel paints
    without TNS and the row populates when (or if) TNS responds."""
    _validate_survey(survey_id)
    try:
        info = await object_info_service.get_object_info(survey=survey_id, oid=oid)
    except Exception as e:
        log.exception("object_information failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "basic_information/basicInformationPreview.html.jinja",
        {
            "info": info,
            "survey_id": survey_id,
            "has_features": SC(survey_id).features_url_template is not None,
            "tai_minus_utc_seconds": TAI_MINUS_UTC_SECONDS,
        },
    )


@router.get("/htmx/crossmatch", response_class=HTMLResponse)
async def crossmatch(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    """Lazy-loaded catsHTM crossmatch panel — fired by the bottom-of-page
    `<details>` slot the first time the user expands it. The route resolves
    the object's ra/dec via `object_info` (so the container template doesn't
    need to know coordinates) and then defers to the crossmatch service for
    the catsHTM call + shaping. catsHTM is not on the critical path: any
    upstream failure is rendered into the same panel as an error string,
    not propagated as a 500."""
    _validate_survey(survey_id)
    try:
        info = await object_info_service.get_object_info(survey=survey_id, oid=oid)
    except Exception as e:
        log.exception("crossmatch object_info failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    ctx = await crossmatch_service.get_crossmatch(
        ra=info.get("ra"), dec=info.get("dec"),
    )
    # Fold the bulk CDS/NED crossmatch in beside catsHTM. Cache-first: the
    # results page prefetch usually has this object warm already, so opening the
    # panel is instant; a cold open computes it on demand (and caches it).
    try:
        xm = await xmatch_cache_service.get_or_compute(
            oid, info.get("ra"), info.get("dec"),
        )
    except Exception:
        log.exception("crossmatch xmatch lookup failed")
        xm = xmatch_cache_service.EMPTY_RECORD
    return templates.TemplateResponse(
        request,
        "crossmatch/crossmatchPanel.html.jinja",
        {"ctx": ctx, "xm": xm, "oid": oid, "survey_id": survey_id},
    )


@router.post("/htmx/xmatch_prefetch")
async def xmatch_prefetch(request: Request) -> Response:
    """Warm the bulk-crossmatch cache for a page (or whole OID list) of objects.

    Fired once per results-table render with a JSON body
    ``{"positions": [{"oid":, "ra":, "dec":}, ...]}``. Off the critical path —
    always 204s, even on a bad body or upstream failure, so it never blocks or
    errors the listing. The cache de-dups, so paging back re-queries nothing.
    """
    try:
        body = await request.json()
        raw = body.get("positions") or []
        positions = [
            (str(p["oid"]), float(p["ra"]), float(p["dec"]))
            for p in raw
            if p.get("oid") and p.get("ra") is not None and p.get("dec") is not None
        ]
    except Exception:
        return Response(status_code=204)
    try:
        await xmatch_cache_service.prefetch(positions)
    except Exception:
        log.exception("xmatch prefetch failed")
    return Response(status_code=204)


@router.get("/htmx/features", response_class=HTMLResponse)
async def features(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    _validate_survey(survey_id)
    try:
        ctx = await features_service.get_features(survey=survey_id, oid=oid)
    except Exception as e:
        log.exception("features failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "features/featuresTable.html.jinja",
        {"ctx": ctx, "oid": oid, "survey_id": survey_id},
    )
