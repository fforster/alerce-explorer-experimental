import asyncio

from src.services import object_list
from src.services.object_list import (
    build_search_params,
    get_objects_list,
    parse_oid_list,
    shape_oid_list_response,
    shape_response,
)


def test_parse_oid_list_splits_and_dedupes():
    assert parse_oid_list("ZTF21abc, ZTF21def\t  ZTF21abc\nZTF22xyz") == [
        "ZTF21abc", "ZTF21def", "ZTF22xyz",
    ]
    assert parse_oid_list(None) == []
    assert parse_oid_list("") == []
    assert parse_oid_list("   \n\t  ") == []
    assert parse_oid_list("single") == ["single"]


def test_build_search_params_drops_empty_fields():
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        oid=None, page=1, page_size=20,
    )
    assert p == {"page": 1, "page_size": 20, "count": False, "survey": "lsst"} \
        or p == {"page": 1, "page_size": 20, "count": False}


def test_build_search_params_lsst_sends_n_det_range_as_list():
    """LSST list_objects accepts `n_det` as a list `[min, max]` (FastAPI
    repeated-query-param encoding for list[int]). ZTF's `_ztf_extra_params`
    later renames the key to `ndet`; the list value passes through as-is."""
    p = build_search_params(
        survey="lsst",
        classifier="lc_classifier_top", class_name="SN",
        probability=0.5, n_det_min=5, n_det_max=50,
        oid=None, page=2, page_size=20,
    )
    assert p["n_det"] == [5, 50]
    assert "n_det_min" not in p
    assert "n_det_max" not in p
    assert p["probability"] == 0.5
    assert p["page"] == 2


def test_build_search_params_ztf_min_only_uses_singleton_list():
    """Min-only collapses to `[min]` — the API treats a single-element
    list as an open-ended minimum (verified empirically). ZTF
    `_ztf_extra_params` later renames `n_det` → `ndet`."""
    p = build_search_params(
        survey="ztf",
        classifier=None, class_name=None,
        probability=None, n_det_min=5, n_det_max=None,
        oid=None, page=1, page_size=20,
    )
    assert p.get("n_det") == [5]


def test_build_search_params_firstmjd_range_as_list():
    """Discovery-date range mirrors n_det: `firstmjd: list[float]` as per
    the production Filters model. Two-ended range → two-element list."""
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        firstmjd_min=60000.0, firstmjd_max=60100.0,
        oid=None, page=1, page_size=20,
    )
    assert p["firstmjd"] == [60000.0, 60100.0]


def test_build_search_params_firstmjd_min_only_singleton():
    p = build_search_params(
        survey="ztf",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        firstmjd_min=60000.0, firstmjd_max=None,
        oid=None, page=1, page_size=20,
    )
    assert p["firstmjd"] == [60000.0]


def test_build_search_params_lastmjd_range_as_list():
    """Last-detection-date range mirrors firstmjd: `lastmjd: list[float]`."""
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        lastmjd_min=60000.0, lastmjd_max=60100.0,
        oid=None, page=1, page_size=20,
    )
    assert p["lastmjd"] == [60000.0, 60100.0]


def test_build_search_params_lastmjd_max_only_zero_floor():
    """Max-only collapses to `[0.0, max]` so the filter stays one-ended."""
    p = build_search_params(
        survey="ztf",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        lastmjd_min=None, lastmjd_max=60100.0,
        oid=None, page=1, page_size=20,
    )
    assert p["lastmjd"] == [0.0, 60100.0]


def test_build_search_params_conesearch_attaches_radius_with_default():
    """ra+dec without explicit radius → 30" default (matches the prototype's
    UI default and the placeholder in the form input)."""
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        ra=150.0, dec=2.0,
        oid=None, page=1, page_size=20,
    )
    assert p["ra"] == 150.0
    assert p["dec"] == 2.0
    assert p["radius"] == 30.0


def test_build_search_params_conesearch_skipped_without_full_pair():
    """ra alone (no dec) → no cone search at all, since the upstream API
    requires both. Same for dec alone."""
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        ra=150.0, dec=None,
        oid=None, page=1, page_size=20,
    )
    assert "ra" not in p
    assert "dec" not in p
    assert "radius" not in p


def test_build_search_params_max_only_uses_zero_lower_bound():
    """Max-only collapses to `[0, max]` — saves us from carrying a
    "max-only" branch through the param remap and ext-params plumbing."""
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=42,
        oid=None, page=1, page_size=20,
    )
    assert p.get("n_det") == [0, 42]


def test_shape_response_normalizes_ztf_fields():
    raw = {
        "items": [
            {"oid": "ZTF00", "ndet": 42, "class": "SN", "classifier": "lc_classifier",
             "step_id_corr": "27.5.7a32.dev1"},
        ],
        "next": 2,
    }
    out = shape_response(raw, survey="ztf", page=1)
    row = out["items"][0]
    assert row["n_det"] == 42
    assert row["class_name"] == "SN"
    assert row["classifier_name"] == "lc_classifier"
    # step_id_corr is the correction / feature-extractor pipeline step ID,
    # NOT the classifier model version (the prototype conflated them). We
    # keep it as `pipeline_version` so callers can surface it when useful,
    # and we leave `classifier_version` unset on ZTF rows.
    assert row["pipeline_version"] == "27.5.7a32.dev1"
    assert "classifier_version" not in row
    assert out["has_prev"] is False
    assert out["has_next"] is True
    assert out["next"] == 2


def test_shape_response_has_prev_when_page_gt_1():
    raw = {"items": [{"oid": "X"}], "next": None}
    out = shape_response(raw, survey="lsst", page=3)
    assert out["has_prev"] is True
    assert out["prev"] == 2
    assert out["current_page"] == 3


def test_shape_response_empty_items_yields_info_message():
    raw = {"items": [], "next": None}
    out = shape_response(raw, survey="lsst", page=1)
    assert out["items"] == []
    assert "No objects" in out["info_message"]
    assert out["has_next"] is False


def test_shape_response_single_page_has_no_next():
    """Regression: a non-empty last page (upstream `next: null`) must NOT
    advertise a next page. The old `len(items) > 0` fallback ignored the
    explicit null and showed a phantom Next button → clicking it loaded an
    empty page 2."""
    raw = {"items": [{"oid": "A"}, {"oid": "B"}], "next": None}
    out = shape_response(raw, survey="lsst", page=1, page_size=20)
    assert out["has_next"] is False
    assert out["next"] is False


def test_shape_response_full_page_array_assumes_next():
    """Plain-array response carries no pagination metadata, so we fall back
    to page fullness: exactly page_size items means there may be more."""
    raw = [{"oid": str(i)} for i in range(3)]
    assert shape_response(raw, survey="lsst", page=1, page_size=3)["has_next"] is True
    assert shape_response(raw, survey="lsst", page=1, page_size=5)["has_next"] is False


def test_shape_response_full_page_overrides_negative_next_signal():
    """Regression: with count=false the ZTF API returns `next: null` /
    `has_next: false` even when more pages follow, which used to pin every
    result to a single page. A full page (page_size rows) must offer page 2
    regardless of a negative upstream signal."""
    raw = {"items": [{"oid": f"ZTF{i}"} for i in range(3)], "next": None, "has_next": False}
    out = shape_response(raw, survey="ztf", page=1, page_size=3)
    assert out["has_next"] is True
    assert out["next"] == 2


def test_shape_response_short_page_is_last_even_without_total():
    """A page that came back shorter than page_size is the last one — no next,
    no count needed."""
    raw = {"items": [{"oid": "ZTF1"}, {"oid": "ZTF2"}], "has_next": False}
    out = shape_response(raw, survey="ztf", page=2, page_size=20)
    assert out["has_next"] is False
    assert out["next"] is False


def test_shape_response_fullness_uses_raw_count_before_dedupe():
    """LSST returns one row per (object, classifier); a full page of rows
    dedupes to fewer objects. Page-fullness must be judged on the raw row
    count, or a full page would look short and hide the next page."""
    # 4 rows (2 objects × 2 classifiers) fills a page_size=4 page; dedupe
    # leaves 2 objects. has_next must still be True.
    raw = {
        "items": [
            {"oid": "A", "classifier_name": "stamp"},
            {"oid": "A", "classifier_name": "lc_classifier"},
            {"oid": "B", "classifier_name": "stamp"},
            {"oid": "B", "classifier_name": "lc_classifier"},
        ],
        "next": None,
    }
    out = shape_response(raw, survey="lsst", page=1, page_size=4)
    assert len(out["items"]) == 2  # deduped
    assert out["has_next"] is True
    assert out["next"] == 2


def test_shape_response_accepts_plain_array():
    raw = [{"oid": "X"}]
    out = shape_response(raw, survey="lsst", page=1)
    assert out["items"] == [{"oid": "X"}]


def test_shape_response_dedupes_same_oid_across_classifiers():
    """LSST list_objects emits one row per (object, classifier) so a 3-OID
    query comes back with 6 rows. shape_response keeps only the first
    occurrence per oid — preserving probability-DESC ordering — so the
    results table and the detail-view dots row aren't double-stamped."""
    raw = {
        "items": [
            {"oid": "A", "classifier_name": "stamp", "probability": 0.9},
            {"oid": "A", "classifier_name": "lc_classifier", "probability": 0.6},
            {"oid": "B", "classifier_name": "stamp", "probability": 0.8},
            {"oid": "B", "classifier_name": "lc_classifier", "probability": 0.5},
        ],
        "next": None,
    }
    out = shape_response(raw, survey="lsst", page=1)
    assert [r["oid"] for r in out["items"]] == ["A", "B"]
    # First-wins: the higher-probability classifier row survives.
    assert out["items"][0]["classifier_name"] == "stamp"
    assert out["items"][1]["classifier_name"] == "stamp"


def test_shape_oid_list_reorders_to_entered_order():
    """An explicit OID list displays in the order the user typed, not the
    upstream's probability-DESC order. User entered B, A, C; API returned
    them sorted by probability."""
    rows = [
        {"oid": "A", "probability": 0.9},
        {"oid": "C", "probability": 0.7},
        {"oid": "B", "probability": 0.5},
    ]
    out = shape_oid_list_response(rows, survey="lsst", page=1, oids=["B", "A", "C"])
    assert [r["oid"] for r in out["items"]] == ["B", "A", "C"]
    assert out["total"] == 3


def test_shape_oid_list_reorder_runs_after_dedupe():
    """Per-classifier duplicate rows collapse first, then the survivors line
    up in entered order."""
    rows = [
        {"oid": "A", "classifier_name": "stamp", "probability": 0.9},
        {"oid": "A", "classifier_name": "lc", "probability": 0.6},
        {"oid": "B", "classifier_name": "stamp", "probability": 0.8},
        {"oid": "B", "classifier_name": "lc", "probability": 0.5},
    ]
    out = shape_oid_list_response(rows, survey="lsst", page=1, oids=["B", "A"])
    assert [r["oid"] for r in out["items"]] == ["B", "A"]
    assert out["items"][0]["classifier_name"] == "stamp"


def test_shape_oid_list_paginates_locally_in_entry_order():
    """The second page holds the *next* entered OIDs, not the next
    probability bucket. Entered 5 OIDs (E,D,C,B,A) with page_size=2; the
    API returned them probability-sorted (A..E)."""
    rows = [{"oid": o, "probability": p / 10} for o, p in
            (("A", 9), ("B", 7), ("C", 5), ("D", 3), ("E", 1))]
    oids = ["E", "D", "C", "B", "A"]
    p1 = shape_oid_list_response(rows, survey="lsst", page=1, oids=oids, page_size=2)
    assert [r["oid"] for r in p1["items"]] == ["E", "D"]
    assert p1["has_next"] is True and p1["next"] == 2
    assert p1["total"] == 5
    p2 = shape_oid_list_response(rows, survey="lsst", page=2, oids=oids, page_size=2)
    assert [r["oid"] for r in p2["items"]] == ["C", "B"]
    assert p2["has_prev"] is True and p2["has_next"] is True
    p3 = shape_oid_list_response(rows, survey="lsst", page=3, oids=oids, page_size=2)
    assert [r["oid"] for r in p3["items"]] == ["A"]
    assert p3["has_next"] is False and p3["next"] is False


def test_shape_response_dedupe_handles_int_oids_and_missing_oid():
    raw = {
        "items": [
            {"oid": 123456789012345678},
            {"oid": "123456789012345678"},  # same as int when stringified
            {"classifier_name": "x"},        # no oid at all — passes through
            {"oid": 999},
        ],
        "next": None,
    }
    out = shape_response(raw, survey="lsst", page=1)
    oids = [r.get("oid") for r in out["items"]]
    assert oids == [123456789012345678, None, 999]


def test_get_objects_list_oid_search_paginates_in_entry_order(monkeypatch):
    """End-to-end: a multi-page OID search pulls the whole matched set across
    upstream pages and slices the requested page in *entry* order, even though
    upstream returns the objects sorted by probability across its own pages."""
    # 5 entered OIDs, reverse of upstream's probability order.
    oids = ["E", "D", "C", "B", "A"]
    # Upstream serves probability-DESC (A..E) over pages of 2 rows.
    upstream = [
        {"oid": "A", "probability": 0.9},
        {"oid": "B", "probability": 0.7},
        {"oid": "C", "probability": 0.5},
        {"oid": "D", "probability": 0.3},
        {"oid": "E", "probability": 0.1},
    ]
    calls = []

    async def fake_list_objects(survey, params):
        calls.append(params)
        size = params["page_size"]
        page = params["page"]
        start = (page - 1) * size
        return {"items": upstream[start : start + size]}

    monkeypatch.setattr(object_list.alerce_client, "list_objects", fake_list_objects)
    # Force the bulk fetch to page (tiny upstream page size) so we exercise
    # the multi-page walk rather than a single jumbo request.
    monkeypatch.setattr(object_list, "OID_FETCH_PAGE_SIZE", 2)

    page2 = asyncio.run(
        get_objects_list(survey="lsst", oid="E,D,C,B,A", page=2, page_size=2)
    )
    # Page 2 in entry order is C, B — not the second probability bucket.
    assert [r["oid"] for r in page2["items"]] == ["C", "B"]
    assert page2["total"] == 5
    assert page2["has_next"] is True and page2["has_prev"] is True
    # The bulk fetch walked upstream pages (more than one request).
    assert len(calls) >= 2


def test_get_objects_list_oid_fetch_stops_once_all_oids_seen(monkeypatch):
    """The bulk fetch stops paging as soon as every entered OID has appeared,
    rather than draining lower-probability strangers off later pages."""
    oids = ["A", "B"]
    # Huge upstream result, but the two wanted OIDs land on the first page.
    page1 = [{"oid": "A"}, {"oid": "B"}]
    calls = []

    async def fake_list_objects(survey, params):
        calls.append(params["page"])
        if params["page"] == 1:
            return {"items": page1}
        # Any further page would be full of unrelated objects — should never
        # be requested because both wanted OIDs already showed up.
        return {"items": [{"oid": f"X{params['page']}"}] * params["page_size"]}

    monkeypatch.setattr(object_list.alerce_client, "list_objects", fake_list_objects)
    monkeypatch.setattr(object_list, "OID_FETCH_PAGE_SIZE", 2)

    out = asyncio.run(
        get_objects_list(survey="lsst", oid="A,B", page=1, page_size=20)
    )
    assert [r["oid"] for r in out["items"]] == ["A", "B"]
    assert calls == [1]  # stopped after the first page
