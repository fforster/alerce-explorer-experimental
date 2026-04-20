"""Search-results building: call the ALeRCE API and shape the response into
the template context used by main_table_objects/objects_table.html.jinja.
"""
from __future__ import annotations

from typing import Any

from . import alerce_client

DEFAULT_PAGE_SIZE = 20


def _normalize_ztf_row(row: dict[str, Any]) -> dict[str, Any]:
    """ZTF API uses different field names than LSST — map to the common schema.

    Mirrors the prototype's ztf normalization after searchObjects().
    """
    if row.get("ndet") is not None and row.get("n_det") is None:
        row["n_det"] = row["ndet"]
    if row.get("class") is not None and row.get("class_name") is None:
        row["class_name"] = row["class"]
    if row.get("classifier") is not None and row.get("classifier_name") is None:
        row["classifier_name"] = row["classifier"]
    if row.get("step_id_corr") is not None and row.get("classifier_version") is None:
        row["classifier_version"] = row["step_id_corr"]
    return row


def build_search_params(
    *,
    survey: str,
    classifier: str | None,
    class_name: str | None,
    probability: float | None,
    n_det_min: int | None,
    n_det_max: int | None,
    oid: str | None,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    p: dict[str, Any] = {
        "page": page,
        "page_size": page_size,
        "count": False,
    }
    if classifier:
        p["classifier"] = classifier
    if class_name:
        p["class_name"] = class_name
    if probability is not None and probability > 0:
        p["probability"] = probability
    if n_det_min is not None:
        p["n_det"] = n_det_min  # ZTF uses ndet; extra_params remaps.
    # LSST list_objects uses a two-ended range via n_det_min/n_det_max.
    if survey == "lsst":
        if n_det_min is not None:
            p["n_det_min"] = n_det_min
            p.pop("n_det", None)
        if n_det_max is not None:
            p["n_det_max"] = n_det_max
    if oid:
        p["oid"] = oid
    return p


def shape_response(
    raw: Any, *, survey: str, page: int
) -> dict[str, Any]:
    """Convert the upstream response to the dict the template expects."""
    if isinstance(raw, dict) and "items" in raw:
        items = raw.get("items") or []
        total = raw.get("total")
        has_next_raw = raw.get("next")
    elif isinstance(raw, list):
        items = raw
        total = None
        has_next_raw = None
    else:
        items = []
        total = None
        has_next_raw = None

    if survey == "ztf":
        items = [_normalize_ztf_row(dict(r)) for r in items]

    has_next = bool(has_next_raw) if has_next_raw is not None else len(items) > 0
    has_prev = page > 1
    return {
        "items": items,
        "total": total,
        "current_page": page,
        "has_prev": has_prev,
        "prev": page - 1 if has_prev else False,
        "has_next": has_next,
        "next": page + 1 if has_next else False,
        "info_message": None if items else "No objects matched these filters.",
    }


async def get_objects_list(
    *,
    survey: str,
    classifier: str | None = None,
    class_name: str | None = None,
    probability: float | None = None,
    n_det_min: int | None = None,
    n_det_max: int | None = None,
    oid: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    params = build_search_params(
        survey=survey,
        classifier=classifier,
        class_name=class_name,
        probability=probability,
        n_det_min=n_det_min,
        n_det_max=n_det_max,
        oid=oid,
        page=page,
        page_size=page_size,
    )
    raw = await alerce_client.list_objects(survey, params)
    return shape_response(raw, survey=survey, page=page)
