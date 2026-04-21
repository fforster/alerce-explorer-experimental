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
from pathlib import Path
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from ..services import classifiers as classifiers_service
from ..services import coord_residuals as coord_residuals_service
from ..services import lightcurve as lightcurve_service
from ..services import object_info as object_info_service
from ..services import object_list as object_list_service
from ..services import probability as probability_service
from ..services import stamps as stamps_service
from ..services.survey_config import SC, known_surveys

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = BASE_DIR / "templates"

router = APIRouter()

templates = Jinja2Templates(directory=str(TEMPLATES_DIR), autoescape=True, auto_reload=True)
templates.env.globals["API_URL"] = os.getenv("API_URL", "http://localhost:8000")
# `tojson` filter produces JS-safe JSON for embedding in data-* attributes.
templates.env.filters["tojson_compact"] = lambda v: json.dumps(v, separators=(",", ":"))


def _validate_survey(survey: str) -> None:
    if survey not in known_surveys():
        raise HTTPException(status_code=400, detail=f"Unknown survey: {survey!r}")


def _share_url(
    *,
    survey: str | None,
    oid: str | None = None,
    classifier: str | None = None,
    identifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    oids: str | None = None,
    page: int | None = None,
) -> str:
    """Build the shareable `/?...` URL from the pieces that make up the view.

    Kept in one place so the HX-Push-Url header and the server-rendered initial
    markup can't drift. Empty/None pieces are dropped so the URL stays legible.

    Param naming:
      - `oid` is a single-object selector (detail view).
      - `oids` is the free-text OID-list search filter. Distinct names so the
        two can coexist in one URL (e.g. "I searched by an OID list and drilled
        into one result").
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
    if class_name:
        params.append(("class_name", class_name))
    if probability is not None and probability > 0:
        params.append(("probability", str(probability)))
    if n_det_min is not None:
        params.append(("n_det_min", str(n_det_min)))
    if n_det_max is not None:
        params.append(("n_det_max", str(n_det_max)))
    if oids:
        params.append(("oids", oids))
    if page is not None and page > 1:
        params.append(("page", str(page)))
    if identifier:
        params.append(("identifier", identifier))
    return "/" if not params else f"/?{urlencode(params)}"


@router.get("/", response_class=HTMLResponse)
async def index(
    request: Request,
    survey: str | None = None,
    oid: str | None = None,
    classifier: str | None = None,
    identifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    oids: str | None = None,
    page: int | None = None,
) -> HTMLResponse:
    # Query params hydrate the initial view: `?oid=…` jumps straight to the
    # detail, filter params (`classifier`, `class_name`, `probability`,
    # `n_det_min/max`, `oids`, `page`) pre-populate the search form and — when
    # no `oid=` is set — pre-run the listing with that filter set. `identifier`
    # pre-selects a specific detection in the stamps/highlight panels. Fresh
    # `/` keeps the empty-hint default.
    if survey:
        _validate_survey(survey)
    return templates.TemplateResponse(
        request,
        "index.html.jinja",
        {
            "initial_survey": survey or "lsst",
            "initial_oid": oid,
            "initial_classifier": classifier,
            "initial_identifier": identifier,
            "initial_class_name": class_name,
            "initial_probability": probability,
            "initial_n_det_min": n_det_min,
            "initial_n_det_max": n_det_max,
            "initial_oids": oids,
            "initial_page": page,
        },
    )


@router.get("/htmx/search_objects/", response_class=HTMLResponse)
async def search_form(
    request: Request,
    survey: str = "lsst",
    classifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    oids: str | None = None,
) -> HTMLResponse:
    _validate_survey(survey)
    try:
        tidy = await classifiers_service.get_tidy_classifiers(survey)
    except Exception as e:  # upstream API unreachable
        log.warning("classifier fetch failed for %s: %s", survey, e)
        tidy = []
    return templates.TemplateResponse(
        request,
        "search_form/form.html.jinja",
        {
            "survey": survey,
            "classifiers": tidy,
            "selected_classifier": classifier,
            "selected_class_name": class_name,
            "selected_probability": probability,
            "selected_n_det_min": n_det_min,
            "selected_n_det_max": n_det_max,
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
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
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
            class_name=class_name,
            probability=probability,
            n_det_min=n_det_min,
            n_det_max=n_det_max,
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
    resp = templates.TemplateResponse(
        request,
        "main_table_objects/objects_table.html.jinja",
        {
            "objects_list": data,
            "survey": survey,
            "classifier": classifier,
            "class_name": class_name,
            "probability": probability,
            "n_det_min": n_det_min,
            "n_det_max": n_det_max,
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
        class_name=class_name,
        probability=probability,
        n_det_min=n_det_min,
        n_det_max=n_det_max,
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
    identifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
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
        identifier=identifier,
        class_name=class_name,
        probability=probability,
        n_det_min=n_det_min,
        n_det_max=n_det_max,
        oids=oids,
        page=page,
    )
    return resp


@router.get("/htmx/lightcurve", response_class=HTMLResponse)
async def lightcurve(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    _validate_survey(survey_id)
    # object_info fetched in parallel to source ra/dec for the Milky-Way
    # dust lookup (client-side, via the IRSA proxy). Failure is non-fatal —
    # the light curve still renders, just without automatic E(B-V).
    lc_task = lightcurve_service.get_lightcurve(survey=survey_id, oid=oid)
    info_task = object_info_service.get_object_info(survey=survey_id, oid=oid)
    results = await asyncio.gather(lc_task, info_task, return_exceptions=True)
    data, info = results
    if isinstance(data, Exception):
        log.exception("lightcurve failed", exc_info=data)
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {data}</div>'
        )
    ra = info.get("ra") if isinstance(info, dict) else None
    dec = info.get("dec") if isinstance(info, dict) else None
    return templates.TemplateResponse(
        request,
        "lightcurve/lightcurvePreview.html.jinja",
        {
            "lc": data,
            "oid": oid,
            "survey_id": survey_id,
            "ra": ra,
            "dec": dec,
            "extinction_r": SC(survey_id).extinction_r,
        },
    )


@router.get("/htmx/coord_residuals", response_class=HTMLResponse)
async def coord_residuals(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    _validate_survey(survey_id)
    try:
        ctx = await coord_residuals_service.get_coord_residuals(survey=survey_id, oid=oid)
    except Exception as e:
        log.exception("coord_residuals failed")
        return HTMLResponse(
            f'<div class="tw-text-xs tw-text-red-400 tw-p-4">Upstream error: {e}</div>'
        )
    return templates.TemplateResponse(
        request,
        "coord_residuals/coordResidualsPreview.html.jinja",
        {"ctx": ctx, "oid": oid, "survey_id": survey_id},
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


@router.get("/htmx/probability", response_class=HTMLResponse)
async def probability(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    _validate_survey(survey_id)
    try:
        ctx = await probability_service.get_probability_context(survey=survey_id, oid=oid)
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
        {"oid": oid, "survey_id": survey_id, "ra": info.get("ra"), "dec": info.get("dec")},
    )


@router.get("/htmx/object_information", response_class=HTMLResponse)
async def object_information(request: Request, oid: str, survey_id: str) -> HTMLResponse:
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
        {"info": info, "survey_id": survey_id},
    )
