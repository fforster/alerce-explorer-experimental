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


def test_classes_select_renders_options(client):
    r = client.get(
        "/htmx/classes_select",
        params=[("classifier_classes", "SN"), ("classifier_classes", "AGN")],
    )
    assert r.status_code == 200
    assert '<option value="SN">SN</option>' in r.text
    assert '<option value="AGN">AGN</option>' in r.text
