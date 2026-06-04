"""Search-results building: call the ALeRCE API and shape the response into
the template context used by main_table_objects/objects_table.html.jinja.
"""
from __future__ import annotations

import re
from typing import Any

from . import alerce_client

DEFAULT_PAGE_SIZE = 20


def parse_oid_list(oid_str: str | None) -> list[str]:
    """Split the free-text OID-list filter into individual OIDs.

    Mirrors the prototype's `oidRaw.split(/[\\s,]+/)` and the inline parse
    inside `build_search_params`. De-duplicates so a user typing the same
    OID twice (or whitespace-padded variants) doesn't inflate downstream
    counts. Returns [] for None / empty / whitespace-only input.
    """
    if not oid_str:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for tok in re.split(r"[\s,]+", oid_str):
        if not tok or tok in seen:
            continue
        seen.add(tok)
        out.append(tok)
    return out


def _dedupe_by_oid(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop later duplicates of the same oid while preserving order. LSST
    list_objects emits one row per (object, classifier) so any search that
    matches by oid (the `oids` free-text filter in particular) returns each
    object twice — once per classifier. The first row wins because upstream
    sorts by probability DESC."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in items:
        oid = r.get("oid")
        if oid is None:
            out.append(r)
            continue
        key = str(oid)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _normalize_ztf_row(row: dict[str, Any]) -> dict[str, Any]:
    """ZTF API uses different field names than LSST — map to the common schema.

    Mirrors the prototype's ztf normalization after searchObjects(), with one
    deliberate divergence: the prototype copied `step_id_corr` into
    `classifier_version`, but `step_id_corr` is the correction/
    feature-extractor pipeline step ID, NOT the classifier model version.
    ZTF's `/objects` response simply doesn't carry the classifier version
    per row (the classifier runs deterministically off the features), so we
    leave `classifier_version` unset on ZTF rows. We do surface the step
    under its own name (`pipeline_version`) for callers that want it.
    """
    if row.get("ndet") is not None and row.get("n_det") is None:
        row["n_det"] = row["ndet"]
    if row.get("class") is not None and row.get("class_name") is None:
        row["class_name"] = row["class"]
    if row.get("classifier") is not None and row.get("classifier_name") is None:
        row["classifier_name"] = row["classifier"]
    if row.get("step_id_corr") is not None and row.get("pipeline_version") is None:
        row["pipeline_version"] = row["step_id_corr"]
    return row


def build_search_params(
    *,
    survey: str,
    classifier: str | None,
    classifier_version: str | None = None,
    class_name: str | None,
    probability: float | None,
    n_det_min: int | None,
    n_det_max: int | None,
    firstmjd_min: float | None = None,
    firstmjd_max: float | None = None,
    lastmjd_min: float | None = None,
    lastmjd_max: float | None = None,
    ra: float | None = None,
    dec: float | None = None,
    radius: float | None = None,
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
    if classifier_version:
        # The client resolves "Latest" → concrete version before submit,
        # and "Any" → unset, so anything reaching here is a real version
        # string we can pass straight to the upstream filter.
        p["classifier_version"] = classifier_version
    if class_name:
        p["class_name"] = class_name
    if probability is not None and probability > 0:
        p["probability"] = probability
    # n_det filter: both ALeRCE list_objects endpoints take `n_det` as a
    # list `[min, max]` sent as repeated query params (FastAPI's standard
    # encoding for `list[int]` — see the production filter model at
    # alercebroker/web-services :: multisurveys-apis/src/object_api/models/filters.py).
    # ZTF's `_ztf_extra_params` later renames `n_det` → `ndet` (the param
    # name ZTF actually accepts); LSST takes `n_det` as-is. A single-value
    # list acts as min-only; we use `[0, max]` for max-only so the filter
    # is one-ended without us having to handle a third "max-only" case
    # downstream.
    if n_det_min is not None and n_det_max is not None:
        p["n_det"] = [n_det_min, n_det_max]
    elif n_det_min is not None:
        p["n_det"] = [n_det_min]
    elif n_det_max is not None:
        p["n_det"] = [0, n_det_max]
    # Discovery-date range — same list-of-floats encoding as n_det. The
    # production Filters model has `firstmjd: list[float] | None`, so we
    # pass two repeated `firstmjd=…` params. Open-ended-min collapses to a
    # single-element list (consistent with n_det behavior).
    if firstmjd_min is not None and firstmjd_max is not None:
        p["firstmjd"] = [firstmjd_min, firstmjd_max]
    elif firstmjd_min is not None:
        p["firstmjd"] = [firstmjd_min]
    elif firstmjd_max is not None:
        p["firstmjd"] = [0.0, firstmjd_max]
    # Last-detection-date range — same `lastmjd: list[float]` encoding as
    # firstmjd (the production Filters model carries both). Constrains the
    # time of the object's most recent detection.
    if lastmjd_min is not None and lastmjd_max is not None:
        p["lastmjd"] = [lastmjd_min, lastmjd_max]
    elif lastmjd_min is not None:
        p["lastmjd"] = [lastmjd_min]
    elif lastmjd_max is not None:
        p["lastmjd"] = [0.0, lastmjd_max]
    # Conesearch — only meaningful when ra+dec are both present. Radius
    # defaults to 30 arcsec to match the prototype's UI default; the
    # upstream API accepts arcsec.
    if ra is not None and dec is not None:
        p["ra"] = ra
        p["dec"] = dec
        p["radius"] = radius if radius is not None else 30.0
    if oid:
        # Split on commas/whitespace so a free-text list like
        # "ZTF26aaumzmq, ZTF22abqqckk" becomes repeated `oid=` query params
        # (the upstream filter is `oid: list[str]`). Mirrors the prototype's
        # `oidRaw.split(/[\s,]+/)` at alerce_explorer.html:2141.
        oids = parse_oid_list(oid)
        if oids:
            p["oid"] = oids if len(oids) > 1 else oids[0]
    return p


def shape_response(
    raw: Any, *, survey: str, page: int, page_size: int = DEFAULT_PAGE_SIZE
) -> dict[str, Any]:
    """Convert the upstream response to the dict the template expects."""
    # `has_next_signal` is the upstream's authoritative answer when present:
    # the paginated dict always carries a `next` pointer (a page number on
    # non-last pages, null on the last page) and often a `has_next` boolean.
    # We must trust an explicit null here — it means "no next page". Falling
    # back to an item-count heuristic in that case is the bug that made a
    # single-page result still show a "Next" button (→ empty page 2). `None`
    # below means "upstream gave no pagination metadata at all" (plain-array
    # responses), the only case where we heuristically guess.
    if isinstance(raw, dict) and "items" in raw:
        items = raw.get("items") or []
        total = raw.get("total")
        if "has_next" in raw:
            has_next_signal: bool | None = bool(raw.get("has_next"))
        elif "next" in raw:
            has_next_signal = bool(raw.get("next"))
        else:
            has_next_signal = None
    elif isinstance(raw, list):
        items = raw
        total = None
        has_next_signal = None
    else:
        items = []
        total = None
        has_next_signal = None

    if survey == "ztf":
        items = [_normalize_ztf_row(dict(r)) for r in items]

    # Upstream LSST returns one row per (object, classifier) so a 3-OID
    # search comes back with 6 rows (two classifiers). The results table
    # and the detail-view dots row both treat items as a per-object list,
    # so dedupe by oid here — keep the first occurrence which preserves
    # the upstream's probability-DESC ordering.
    items = _dedupe_by_oid(items)

    # No upstream metadata → guess from page fullness. A partial page can't
    # have a successor, so this never invents a phantom next page the way the
    # old `len(items) > 0` test did.
    has_next = has_next_signal if has_next_signal is not None else len(items) >= page_size
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
    oid: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    params = build_search_params(
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
        oid=oid,
        page=page,
        page_size=page_size,
    )
    raw = await alerce_client.list_objects(survey, params)
    return shape_response(raw, survey=survey, page=page, page_size=page_size)
