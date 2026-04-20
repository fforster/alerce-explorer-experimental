"""htmx endpoints — return HTML fragments via Jinja2.

Slice 2: search_objects/, classes_select, and list_objects now call the
public ALeRCE API via the service layer. Errors are rendered into the same
fragment so htmx can swap them into the results slot.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from ..services import classifiers as classifiers_service
from ..services import lightcurve as lightcurve_service
from ..services import object_info as object_info_service
from ..services import object_list as object_list_service
from ..services import stamps as stamps_service
from ..services.survey_config import known_surveys

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


@router.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html.jinja")


@router.get("/htmx/search_objects/", response_class=HTMLResponse)
async def search_form(request: Request, survey: str = "lsst") -> HTMLResponse:
    _validate_survey(survey)
    try:
        tidy = await classifiers_service.get_tidy_classifiers(survey)
    except Exception as e:  # upstream API unreachable
        log.warning("classifier fetch failed for %s: %s", survey, e)
        tidy = []
    return templates.TemplateResponse(
        request,
        "search_form/form.html.jinja",
        {"survey": survey, "classifiers": tidy},
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
    oid: str | None = None,
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
            oid=oid,
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
    return templates.TemplateResponse(
        request,
        "main_table_objects/objects_table.html.jinja",
        {"objects_list": data, "survey": survey},
    )


@router.get("/htmx/detail", response_class=HTMLResponse)
async def detail(request: Request, oid: str, survey_id: str) -> HTMLResponse:
    _validate_survey(survey_id)
    return templates.TemplateResponse(
        request,
        "object_detail/container.html.jinja",
        {"oid": oid, "survey_id": survey_id},
    )


@router.get("/htmx/lightcurve", response_class=HTMLResponse)
async def lightcurve(request: Request, oid: str, survey_id: str) -> HTMLResponse:
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
        {"lc": data, "oid": oid, "survey_id": survey_id},
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
