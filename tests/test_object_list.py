from src.services.object_list import build_search_params, shape_response


def test_build_search_params_drops_empty_fields():
    p = build_search_params(
        survey="lsst",
        classifier=None, class_name=None,
        probability=None, n_det_min=None, n_det_max=None,
        oid=None, page=1, page_size=20,
    )
    assert p == {"page": 1, "page_size": 20, "count": False, "survey": "lsst"} \
        or p == {"page": 1, "page_size": 20, "count": False}


def test_build_search_params_lsst_uses_range_fields():
    p = build_search_params(
        survey="lsst",
        classifier="lc_classifier_top", class_name="SN",
        probability=0.5, n_det_min=5, n_det_max=50,
        oid=None, page=2, page_size=20,
    )
    assert p["n_det_min"] == 5
    assert p["n_det_max"] == 50
    assert "n_det" not in p
    assert p["probability"] == 0.5
    assert p["page"] == 2


def test_build_search_params_ztf_keeps_n_det():
    p = build_search_params(
        survey="ztf",
        classifier=None, class_name=None,
        probability=None, n_det_min=5, n_det_max=None,
        oid=None, page=1, page_size=20,
    )
    # ZTF extra_params rewrites n_det → ndet later; here we still carry n_det.
    assert p.get("n_det") == 5


def test_shape_response_normalizes_ztf_fields():
    raw = {
        "items": [
            {"oid": "ZTF00", "ndet": 42, "class": "SN", "classifier": "lc_classifier"},
        ],
        "next": 2,
    }
    out = shape_response(raw, survey="ztf", page=1)
    row = out["items"][0]
    assert row["n_det"] == 42
    assert row["class_name"] == "SN"
    assert row["classifier_name"] == "lc_classifier"
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


def test_shape_response_accepts_plain_array():
    raw = [{"oid": "X"}]
    out = shape_response(raw, survey="lsst", page=1)
    assert out["items"] == [{"oid": "X"}]
