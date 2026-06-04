from src.services.object_list import build_search_params, parse_oid_list, shape_response


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
