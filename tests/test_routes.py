"""Route-level tests: verify the htmx handlers wire service output into the
template correctly. Upstream ALeRCE calls are replaced with monkeypatched
stubs so these run offline.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from src.app import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def stub_services(monkeypatch):
    async def fake_classifiers(survey):
        return [{"classifier_name": "lc_classifier_top",
                 "formatted_name": "lc classifier top",
                 "classes": ["SN", "AGN"]}]

    async def fake_objects(**kwargs):
        page = kwargs.get("page", 1)
        return {
            "items": [
                {"oid": "LSST-1", "n_det": 10, "classifier_name": "lc_classifier_top",
                 "class_name": "SN", "probability": 0.9,
                 "meanra": 123.456, "meandec": -30.5,
                 "firstmjd": 60000.1, "lastmjd": 60123.4},
            ],
            "current_page": page,
            "has_prev": page > 1,
            "prev": page - 1 if page > 1 else False,
            "has_next": True,
            "next": page + 1,
            "info_message": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.classifiers_service.get_tidy_classifiers",
        fake_classifiers,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_list_service.get_objects_list",
        fake_objects,
    )


def test_index_shell(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "search-form-slot" in r.text
    assert "results-slot" in r.text
    assert "/static/htmx/htmx.min.js" in r.text


def test_search_form_renders_classifiers(client, stub_services):
    r = client.get("/htmx/search_objects/?survey=lsst")
    assert r.status_code == 200
    assert 'data-survey="lsst"' in r.text
    assert "lc_classifier_top" in r.text
    assert "data-classes=" in r.text


def test_search_form_rejects_unknown_survey(client):
    r = client.get("/htmx/search_objects/?survey=panstarrs")
    assert r.status_code == 400


def test_list_objects_renders_row(client, stub_services):
    r = client.get("/htmx/list_objects?survey=lsst&page=1")
    assert r.status_code == 200
    assert "LSST-1" in r.text
    assert "lc_classifier_top" in r.text
    # Probability is formatted to 3 decimal places.
    assert "0.900" in r.text
    # Pagination: page 1 → only Next is present.
    assert "Next →" in r.text
    assert "Prev" not in r.text


def test_list_objects_shows_prev_from_page_2(client, stub_services):
    r = client.get("/htmx/list_objects?survey=lsst&page=2")
    assert r.status_code == 200
    assert "← Prev" in r.text
    assert "Next →" in r.text


def test_list_objects_without_survey_shows_hint(client):
    r = client.get("/htmx/list_objects")
    assert r.status_code == 200
    assert "Pick a survey" in r.text


def test_row_is_clickable_with_detail_url(client, stub_services):
    r = client.get("/htmx/list_objects?survey=lsst&page=1")
    assert r.status_code == 200
    assert "/htmx/detail?oid=LSST-1&survey_id=lsst" in r.text


def test_detail_renders_container(client):
    r = client.get("/htmx/detail?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "Back to results" in r.text
    assert "/htmx/object_information?oid=ZTF21abc&survey_id=ztf" in r.text
    # Stamps slot wired in Slice 5; Aladin placeholder remains.
    assert 'id="stamps-slot"' in r.text
    assert "/htmx/stamps?oid=ZTF21abc&survey_id=ztf" in r.text
    assert "slice 6" in r.text


def test_detail_rejects_unknown_survey(client):
    r = client.get("/htmx/detail?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_object_information_renders_basic_fields(client, monkeypatch):
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey,
            "ra": 180.0, "dec": -30.0,
            "ra_hms": "12:00:00.000", "dec_dms": "-30:00:00.00",
            "firstmjd": 60000.0, "lastmjd": 60100.0, "delta_mjd": 100.0,
            "n_det": 12, "n_non_det": 38, "n_forced": None,
            "corrected": True, "stellar": False,
            "archives": [{"name": "ALeRCE Explorer", "url": "https://alerce.online/object/ZTF21abc"}],
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/object_information?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "ZTF21abc" in r.text
    assert "12:00:00.000" in r.text
    assert "-30:00:00.00" in r.text
    assert "60000.000" in r.text
    assert "ALeRCE Explorer" in r.text


def test_lightcurve_renders_canvas_with_payload(client, monkeypatch):
    async def fake_lc(*, survey, oid):
        return {
            "survey": survey,
            "bands": [
                {"name": "g", "points": [{"mjd": 60000.0, "flux": 1000.0, "e_flux": 10.0, "candid": "1"}]},
                {"name": "r", "points": [{"mjd": 60001.0, "flux": 1500.0, "e_flux": 15.0, "candid": "2"}]},
            ],
            "n_det": 2,
        }

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    r = client.get("/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="lc-canvas-ZTF21abc"' in r.text
    assert "data-lc=" in r.text
    # JSON payload is embedded; spot-check a value.
    assert "60000" in r.text
    assert "2 detections" in r.text


def test_lightcurve_empty_shows_message(client, monkeypatch):
    async def fake_lc(*, survey, oid):
        return {"survey": survey, "bands": [], "n_det": 0}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "No detections" in r.text
    assert "data-lc=" not in r.text


def test_lightcurve_rejects_unknown_survey(client):
    r = client.get("/htmx/lightcurve?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_lightcurve_upstream_error_renders_message(client, monkeypatch):
    async def fake_lc(*, survey, oid):
        raise RuntimeError("network down")

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_detail_container_wires_lightcurve_slot(client):
    r = client.get("/htmx/detail?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="lightcurve-slot"' in r.text


def test_object_information_upstream_error_renders_message(client, monkeypatch):
    async def fake_info(*, survey, oid):
        raise RuntimeError("timeout")

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/object_information?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_stamps_renders_picker_and_canvases(client, monkeypatch):
    async def fake_stamps(*, survey, oid, identifier=None):
        sel = {"identifier": "111", "mjd": 60000.5, "band": "r"}
        return {
            "oid": oid, "survey": survey,
            "detections": [sel, {"identifier": "222", "mjd": 59999.5, "band": "g"}],
            "selected": sel,
            "stamp_types": ["science", "template", "difference"],
            "stamp_urls": {
                "science": "https://x/science",
                "template": "https://x/template",
                "difference": "https://x/difference",
            },
        }

    monkeypatch.setattr(
        "src.routes.htmx.stamps_service.get_stamps_context",
        fake_stamps,
    )
    r = client.get("/htmx/stamps?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="stamps-panel"' in r.text
    assert "stamp-canvas" in r.text
    assert "https://x/science" in r.text
    assert "https://x/template" in r.text
    assert "https://x/difference" in r.text
    # Picker options reference both identifiers.
    assert 'value="111"' in r.text
    assert 'value="222"' in r.text


def test_stamps_empty_shows_message(client, monkeypatch):
    async def fake_stamps(*, survey, oid, identifier=None):
        return {
            "oid": oid, "survey": survey,
            "detections": [], "selected": None,
            "stamp_types": ["science", "template", "difference"],
            "stamp_urls": {},
        }

    monkeypatch.setattr(
        "src.routes.htmx.stamps_service.get_stamps_context",
        fake_stamps,
    )
    r = client.get("/htmx/stamps?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "No detections with stamps" in r.text
    assert "stamp-canvas" not in r.text


def test_stamps_rejects_unknown_survey(client):
    r = client.get("/htmx/stamps?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_stamps_upstream_error(client, monkeypatch):
    async def fake_stamps(*, survey, oid, identifier=None):
        raise RuntimeError("stamps api down")

    monkeypatch.setattr(
        "src.routes.htmx.stamps_service.get_stamps_context",
        fake_stamps,
    )
    r = client.get("/htmx/stamps?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_classes_select_renders_options(client):
    r = client.get(
        "/htmx/classes_select",
        params=[("classifier_classes", "SN"), ("classifier_classes", "AGN")],
    )
    assert r.status_code == 200
    assert '<option value="SN">SN</option>' in r.text
    assert '<option value="AGN">AGN</option>' in r.text
