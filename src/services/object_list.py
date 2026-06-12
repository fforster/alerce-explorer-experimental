"""Search-results building: call the ALeRCE API and shape the response into
the template context used by main_table_objects/objects_table.html.jinja.
"""
from __future__ import annotations

import re
from typing import Any

from . import alerce_client

DEFAULT_PAGE_SIZE = 20

# When the search is an explicit OID list we paginate locally in entry order
# (upstream paginates by probability, so its page N isn't our page N). To do
# that we must pull the whole matched set first. These bound that bulk fetch:
# rows per upstream request, and a hard page ceiling so a misbehaving upstream
# can't spin us forever. The matched set is bounded by the entered OID count
# (times classifier multiplicity for LSST), so this ceiling — 50 × 200 = 10k
# rows — is far above any hand-entered list.
OID_FETCH_PAGE_SIZE = 200
OID_FETCH_MAX_PAGES = 50


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


def _reorder_by_oid_list(
    items: list[dict[str, Any]], oids: list[str]
) -> list[dict[str, Any]]:
    """Reorder rows to match the user's entered OID order.

    When the search is an explicit OID list, the user expects the results in
    the order they typed, but the upstream API returns them sorted by
    probability DESC (see `_ztf_extra_params` / `_lsst_extra_params`). Sort
    the matched rows back into entry order; any row whose oid isn't in the
    list (shouldn't happen for an oid-filtered query, but be defensive) keeps
    its upstream position at the end.
    """
    if not oids:
        return items
    rank = {oid: i for i, oid in enumerate(oids)}
    fallback = len(rank)
    return sorted(
        items,
        key=lambda r: rank.get(str(r.get("oid")), fallback),
    )


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


def _extract_items(raw: Any) -> list[dict[str, Any]]:
    """Pull the row list out of an upstream response (dict-with-items or a
    bare array), independent of pagination metadata."""
    if isinstance(raw, dict) and "items" in raw:
        return list(raw.get("items") or [])
    if isinstance(raw, list):
        return list(raw)
    return []


def shape_response(
    raw: Any, *, survey: str, page: int, page_size: int = DEFAULT_PAGE_SIZE
) -> dict[str, Any]:
    """Convert the upstream response to the dict the template expects."""
    # We deliberately query with `count=false` (no total) — counting is the
    # API's expensive path and we only need to know whether a *next* page
    # exists, not how many. Without a total, ZTF's `has_next`/`next` is
    # unreliable (it returns "no next" even when more pages follow), so we
    # can't simply trust a negative signal. Instead:
    #   * trust a *positive* upstream signal when present (it means "yes, more"), and
    #   * otherwise infer from page fullness — a page that came back full
    #     (page_size rows) probably has a successor; a short page is the last.
    # `has_next_positive` is only ever set when upstream explicitly says yes.
    if isinstance(raw, dict) and "items" in raw:
        items = raw.get("items") or []
        total = raw.get("total")
        if "has_next" in raw:
            has_next_positive = bool(raw.get("has_next"))
        elif "next" in raw:
            has_next_positive = bool(raw.get("next"))
        else:
            has_next_positive = False
    elif isinstance(raw, list):
        items = raw
        total = None
        has_next_positive = False
    else:
        items = []
        total = None
        has_next_positive = False

    # Page-fullness uses the RAW upstream row count, captured before dedupe:
    # LSST returns one row per (object, classifier), so a full page of rows
    # dedupes to fewer objects — checking len(items) after dedupe would hide
    # real next pages.
    raw_count = len(items)

    if survey == "ztf":
        items = [_normalize_ztf_row(dict(r)) for r in items]

    # Upstream LSST returns one row per (object, classifier) so a 3-OID
    # search comes back with 6 rows (two classifiers). The results table
    # and the detail-view dots row both treat items as a per-object list,
    # so dedupe by oid here — keep the first occurrence which preserves
    # the upstream's probability-DESC ordering.
    items = _dedupe_by_oid(items)

    # A full page implies a possible next page (count-free pagination). The
    # only cost is that a last page whose size is an exact multiple of
    # page_size shows one extra Next that lands on an empty page — an accepted
    # trade for not paying the count.
    has_next = has_next_positive or raw_count >= page_size
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


async def _fetch_all_oid_matches(
    survey: str, base_params: dict[str, Any], wanted: list[str]
) -> list[dict[str, Any]]:
    """Pull every upstream row matching an OID list, across upstream pages.

    Upstream sorts by probability and paginates, so a single request can split
    an object's per-classifier rows (LSST) or drop later-entered OIDs onto a
    page we never asked for. Walk upstream pages until it's exhausted (a short
    page) or we've seen every entered OID — whichever comes first — so local
    entry-order pagination has the complete set to work from.
    """
    wanted_set = {str(o) for o in wanted}
    seen: set[str] = set()
    collected: list[dict[str, Any]] = []
    page = 1
    while page <= OID_FETCH_MAX_PAGES:
        params = {**base_params, "page": page, "page_size": OID_FETCH_PAGE_SIZE}
        raw = await alerce_client.list_objects(survey, params)
        items = _extract_items(raw)
        collected.extend(items)
        for r in items:
            o = r.get("oid")
            if o is not None:
                seen.add(str(o))
        # Stop on an exhausted upstream (short page) or once every entered OID
        # has surfaced — no point paging through lower-probability strangers.
        if len(items) < OID_FETCH_PAGE_SIZE or wanted_set <= seen:
            break
        page += 1
    return collected


def shape_oid_list_response(
    rows: list[dict[str, Any]],
    *,
    survey: str,
    page: int,
    oids: list[str],
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    """Shape the full matched OID set into one locally-paginated page.

    Unlike `shape_response` (count-free, probability-ordered), here we hold the
    complete matched set, so we can order it by the user's entry order and
    slice the requested page out of it — and report an exact total.
    """
    items = rows
    if survey == "ztf":
        items = [_normalize_ztf_row(dict(r)) for r in items]
    items = _dedupe_by_oid(items)
    items = _reorder_by_oid_list(items, oids)

    total_objects = len(items)
    start = (page - 1) * page_size
    page_items = items[start : start + page_size]
    has_prev = page > 1
    has_next = start + page_size < total_objects
    return {
        "items": page_items,
        "total": total_objects,
        "current_page": page,
        "has_prev": has_prev,
        "prev": page - 1 if has_prev else False,
        "has_next": has_next,
        "next": page + 1 if has_next else False,
        "info_message": None if page_items else "No objects matched these filters.",
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
    oids = parse_oid_list(oid)
    if oids:
        # Explicit OID list: fetch the whole matched set and paginate it
        # locally in entry order, since upstream paginates by probability and
        # would otherwise scatter the entered OIDs across the wrong pages.
        base_params = {
            k: v for k, v in params.items() if k not in ("page", "page_size")
        }
        rows = await _fetch_all_oid_matches(survey, base_params, oids)
        return shape_oid_list_response(
            rows, survey=survey, page=page, oids=oids, page_size=page_size
        )
    raw = await alerce_client.list_objects(survey, params)
    return shape_response(raw, survey=survey, page=page, page_size=page_size)
