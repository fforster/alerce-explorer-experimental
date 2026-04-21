"""Route-level tests: verify the htmx handlers wire service output into the
template correctly. Upstream ALeRCE calls are replaced with monkeypatched
stubs so these run offline.
"""
from __future__ import annotations

import html as html_lib

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
    # Fresh `/` keeps the empty-hint default — no deep-link hydration.
    assert "/htmx/detail" not in r.text


def test_index_deep_link_to_object(client):
    # `?oid=…` jumps straight to the detail; classifier threads through.
    r = client.get("/?survey=lsst&oid=LSST-1&classifier=lc_classifier_top")
    assert r.status_code == 200
    assert "/htmx/detail?oid=LSST-1&survey_id=lsst&classifier=lc_classifier_top" in r.text
    # Search form is pre-loaded with the classifier pre-selected server-side.
    assert "/htmx/search_objects/?survey=lsst&classifier=lc_classifier_top" in r.text
    assert "/htmx/list_objects" not in r.text


def test_index_deep_link_to_filtered_list(client):
    # `?classifier=…` without oid pre-runs the listing for that filter.
    r = client.get("/?survey=ztf&classifier=lc_classifier_top")
    assert r.status_code == 200
    assert "/htmx/list_objects?survey=ztf&classifier=lc_classifier_top" in r.text
    assert "/htmx/detail" not in r.text


def test_index_rejects_unknown_survey(client):
    r = client.get("/?survey=panstarrs")
    assert r.status_code == 400


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


def test_list_objects_emits_data_nav(client, stub_services):
    # `data-nav` carries the oids + pagination so the detail's ← / → buttons
    # and keyboard arrows can walk through the result set. The attribute is
    # HTML-escaped by Jinja's autoescape — decode before asserting JSON shape.
    r = client.get("/htmx/list_objects?survey=lsst&page=1")
    assert r.status_code == 200
    assert "data-nav=" in r.text
    decoded = html_lib.unescape(r.text)
    assert '"oids":["LSST-1"]' in decoded
    assert '"current_page":1' in decoded
    assert '"has_next":true' in decoded
    assert '"next":2' in decoded


def test_list_objects_empty_still_emits_data_nav(client):
    # Empty result: `data-nav` is still present (with no oids) so the JS
    # consistently sees fresh state after every swap.
    r = client.get("/htmx/list_objects")
    assert r.status_code == 200
    assert "data-nav=" in r.text
    decoded = html_lib.unescape(r.text)
    assert '"oids":[]' in decoded


def test_list_objects_pushes_share_url(client, stub_services):
    r = client.get("/htmx/list_objects?survey=lsst&classifier=lc_classifier_top&page=1")
    assert r.status_code == 200
    # HX-Push-Url updates the browser URL to a shareable form. page=1 is the
    # default so it's dropped to keep URLs clean.
    assert r.headers.get("HX-Push-Url") == "/?survey=lsst&classifier=lc_classifier_top"
    # Row URL carries the classifier through to the detail request.
    assert "classifier=lc_classifier_top" in r.text


def test_list_objects_pushes_full_filter_url(client, stub_services):
    """Every filter the form can set round-trips through HX-Push-Url so the
    drill-in/back cycle (or a share link) reconstructs the exact listing."""
    r = client.get(
        "/htmx/list_objects?survey=ztf&classifier=lc_classifier_top"
        "&class_name=SN&probability=0.5&n_det_min=5&n_det_max=50&oids=ZTF1,ZTF2&page=3"
    )
    assert r.status_code == 200
    assert r.headers.get("HX-Push-Url") == (
        "/?survey=ztf&classifier=lc_classifier_top&class_name=SN&probability=0.5"
        "&n_det_min=5&n_det_max=50&oids=ZTF1%2CZTF2&page=3"
    )


def test_list_objects_accepts_oids_and_forwards_as_oid(client, monkeypatch):
    """The URL uses `oids=` (plural) to not collide with detail's `oid=`, but
    the service layer still takes `oid=`. The route bridges the two names."""
    captured = {}

    async def fake_objects(**kwargs):
        captured.update(kwargs)
        return {
            "items": [], "current_page": 1,
            "has_prev": False, "prev": False,
            "has_next": False, "next": False,
            "info_message": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_list_service.get_objects_list",
        fake_objects,
    )
    r = client.get("/htmx/list_objects?survey=lsst&oids=OID1,OID2")
    assert r.status_code == 200
    assert captured.get("oid") == "OID1,OID2"


def test_list_objects_without_survey_does_not_push_url(client):
    r = client.get("/htmx/list_objects")
    assert r.status_code == 200
    # No survey → empty hint, no URL to push.
    assert r.headers.get("HX-Push-Url") in (None, "/")


def test_detail_pushes_share_url_with_classifier(client):
    r = client.get("/htmx/detail?oid=LSST-1&survey_id=lsst&classifier=lc_classifier_top")
    assert r.status_code == 200
    assert r.headers.get("HX-Push-Url") == (
        "/?survey=lsst&oid=LSST-1&classifier=lc_classifier_top"
    )


def test_detail_pushes_full_filter_url(client):
    """Detail passes through every filter param so that clicking a row in a
    filtered listing produces a URL that reconstructs the listing on back."""
    r = client.get(
        "/htmx/detail?oid=LSST-1&survey_id=lsst&classifier=lc_classifier_top"
        "&class_name=SN&probability=0.5&n_det_min=5&n_det_max=50&oids=A,B&page=2"
    )
    assert r.status_code == 200
    assert r.headers.get("HX-Push-Url") == (
        "/?survey=lsst&oid=LSST-1&classifier=lc_classifier_top&class_name=SN"
        "&probability=0.5&n_det_min=5&n_det_max=50&oids=A%2CB&page=2"
    )


def test_detail_pushes_share_url_with_identifier(client):
    # `identifier=…` selects a specific detection in the stamps/highlight panels.
    r = client.get("/htmx/detail?oid=LSST-1&survey_id=lsst&identifier=777")
    assert r.status_code == 200
    assert r.headers.get("HX-Push-Url") == (
        "/?survey=lsst&oid=LSST-1&identifier=777"
    )
    # Stamps slot carries the identifier so the initial render picks the right detection.
    assert "/htmx/stamps?oid=LSST-1&survey_id=lsst&identifier=777" in r.text


def test_index_deep_link_with_identifier(client):
    r = client.get("/?survey=lsst&oid=LSST-1&identifier=777")
    assert r.status_code == 200
    assert (
        "/htmx/detail?oid=LSST-1&survey_id=lsst&identifier=777" in r.text
    )


def test_search_form_preselects_classifier(client, stub_services):
    r = client.get("/htmx/search_objects/?survey=lsst&classifier=lc_classifier_top")
    assert r.status_code == 200
    # `selected` attribute marks the matching <option>.
    assert 'value="lc_classifier_top"' in r.text
    assert "selected" in r.text


def test_search_form_prefills_all_filters(client, stub_services):
    """Deep-link into the form with the full filter set and the inputs
    should carry those values — including the dependent class_name select,
    which is populated server-side rather than waiting on a `change` event."""
    r = client.get(
        "/htmx/search_objects/?survey=lsst&classifier=lc_classifier_top"
        "&class_name=SN&probability=0.42&n_det_min=5&n_det_max=50&oids=OID1,OID2"
    )
    assert r.status_code == 200
    # Free-text OID list is pre-populated.
    assert 'value="OID1,OID2"' in r.text
    # Probability slider shows the value (and the numeric readout span).
    assert 'value="0.42"' in r.text
    assert ">0.42<" in r.text
    # Min/max detection inputs carry the integers.
    assert 'value="5"' in r.text
    assert 'value="50"' in r.text
    # Dependent class options are rendered server-side with SN selected.
    assert '<option value="SN" selected>SN</option>' in r.text


def test_index_hydrates_list_from_any_filter(client):
    """A URL with filters but no classifier still pre-runs the listing — any
    filter param is enough to treat this as a filtered view."""
    r = client.get("/?survey=lsst&class_name=SN&probability=0.5")
    assert r.status_code == 200
    assert "/htmx/list_objects?survey=lsst" in r.text
    assert "class_name=SN" in r.text
    assert "probability=0.5" in r.text
    assert "/htmx/detail" not in r.text


def test_index_full_filter_hydration(client):
    """Every URL-level filter should ride through to the initial hx-get
    that hydrates the search form and the listing."""
    r = client.get(
        "/?survey=ztf&classifier=lc_classifier_top&class_name=SN&probability=0.3"
        "&n_det_min=5&n_det_max=50&oids=ZTF1&page=2"
    )
    assert r.status_code == 200
    # Search form hx-get carries the filter passthrough.
    assert "/htmx/search_objects/?survey=ztf" in r.text
    # Listing hx-get carries the same, including page.
    assert "/htmx/list_objects?survey=ztf" in r.text
    assert "classifier=lc_classifier_top" in r.text
    assert "class_name=SN" in r.text
    assert "probability=0.3" in r.text
    assert "n_det_min=5" in r.text
    assert "n_det_max=50" in r.text
    assert "oids=ZTF1" in r.text
    assert "page=2" in r.text


def test_row_hx_get_carries_full_filter_set(client, stub_services):
    """Each row's hx-get (the drill-in click) must echo the filters so the
    detail's HX-Push-Url can push a URL that includes the search context."""
    r = client.get(
        "/htmx/list_objects?survey=lsst&classifier=lc_classifier_top"
        "&class_name=SN&probability=0.5&n_det_min=5&n_det_max=50&oids=A,B&page=3"
    )
    assert r.status_code == 200
    assert "/htmx/detail?oid=LSST-1&survey_id=lsst" in r.text
    for frag in [
        "classifier=lc_classifier_top",
        "class_name=SN",
        "probability=0.5",
        "n_det_min=5",
        "n_det_max=50",
        "oids=A%2CB",
        "page=3",
    ]:
        assert frag in r.text


def test_detail_renders_container(client):
    r = client.get("/htmx/detail?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "Back to results" in r.text
    assert r.headers.get("HX-Push-Url") == "/?survey=ztf&oid=ZTF21abc"
    assert "/htmx/object_information?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="stamps-slot"' in r.text
    assert "/htmx/stamps?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="aladin-slot"' in r.text
    assert "/htmx/aladin?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="radar-slot"' in r.text
    assert "/htmx/probability?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="coord-residuals-slot"' in r.text
    assert "/htmx/coord_residuals?oid=ZTF21abc&survey_id=ztf" in r.text
    # data-oid on the root lets object_nav.js find the current OID (the URL
    # can lag by a tick after a client-side navigation).
    assert 'data-oid="ZTF21abc"' in r.text
    assert 'data-survey-id="ztf"' in r.text
    # Prev/next arrow buttons + the wrapper that object_nav.js reveals.
    assert 'id="object-nav"' in r.text
    assert 'id="object-nav-prev"' in r.text
    assert 'id="object-nav-next"' in r.text
    assert "navObject('prev')" in r.text
    assert "navObject('next')" in r.text
    # Position indicator (populated client-side from window._resultsNav).
    assert 'id="object-nav-position"' in r.text


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
                {"name": "g", "points": [{
                    "mjd": 60000.0, "flux": 1000.0, "e_flux": 10.0,
                    "sci_flux": 1200.0, "e_sci_flux": 12.0,
                    "identifier": "1", "has_stamp": True,
                }]},
                {"name": "r", "points": [{
                    "mjd": 60001.0, "flux": 1500.0, "e_flux": 15.0,
                    "sci_flux": 1800.0, "e_sci_flux": 18.0,
                    "identifier": "2", "has_stamp": True,
                }]},
            ],
            "forced_phot_bands": [
                {"name": "g", "points": [{
                    "mjd": 59999.0, "flux": 50.0, "e_flux": 8.0,
                    "sci_flux": None, "e_sci_flux": None,
                    "identifier": None, "has_stamp": False,
                }]},
            ],
            "n_det": 2,
            "n_fp": 1,
            "has_science_flux": True,
        }

    async def fake_info(*, survey, oid):
        return {"ra": 150.0, "dec": 30.0}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="lc-canvas-ZTF21abc"' in r.text
    assert "data-lc=" in r.text
    # JSON payload is embedded; spot-check a value.
    assert "60000" in r.text
    assert "forced_phot_bands" in r.text
    # Per-point identifier + has_stamp power the click-to-sync handler in JS.
    assert "has_stamp" in r.text
    assert "identifier" in r.text
    # Flux/Mag cycle-button markup is present when there are points to plot.
    # Each toggle is a single <button> carrying the initial (active) value;
    # click advances through the ring client-side.
    assert 'class="lc-mode-toggle' in r.text
    assert 'data-target="lc-canvas-ZTF21abc"' in r.text
    assert 'data-lc-mode="flux"' in r.text
    # Diff/Sci cycle button appears when the survey reports science flux.
    assert 'class="lc-source-toggle' in r.text
    assert 'data-lc-source="diff"' in r.text
    # Host-galaxy redshift input — populated by clicks on spec-z overlays in
    # Aladin; `data-target` pairs it with the canvas for the JS listener.
    assert 'id="lc-redshift-ZTF21abc"' in r.text
    assert 'class="lc-redshift-input' in r.text
    # App/Abs cycle button (apparent vs. distance-modulus–corrected).
    assert 'class="lc-abs-toggle' in r.text
    assert 'data-lc-abs="app"' in r.text
    # Obs/Der cycle button + E(B-V) input for Milky-Way extinction correction.
    assert 'class="lc-dered-toggle' in r.text
    assert 'data-lc-dered="obs"' in r.text
    assert 'id="lc-ebv-ZTF21abc"' in r.text
    # ra/dec propagated to the canvas for the client-side dust lookup; R_λ
    # per-band map comes from SurveyConfig (ZTF: g, r, i).
    assert 'data-ra="150.0"' in r.text
    assert 'data-dec="30.0"' in r.text
    assert "data-ext-r=" in r.text
    assert "3.237" in r.text  # R_g for ZTF/LSST


def test_lightcurve_empty_shows_message(client, monkeypatch):
    async def fake_lc(*, survey, oid):
        return {
            "survey": survey, "bands": [], "forced_phot_bands": [],
            "n_det": 0, "n_fp": 0, "has_science_flux": True,
        }

    async def fake_info(*, survey, oid):
        return {"ra": None, "dec": None}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "No detections" in r.text
    assert "data-lc=" not in r.text
    # Toggles only render alongside a chart.
    assert "lc-mode-toggle" not in r.text
    assert "lc-source-toggle" not in r.text


def test_lightcurve_hides_sci_toggle_when_survey_lacks_science_flux(client, monkeypatch):
    async def fake_lc(*, survey, oid):
        return {
            "survey": survey,
            "bands": [{"name": "g", "points": [{
                "mjd": 60000.0, "flux": 1000.0, "e_flux": 10.0,
                "sci_flux": None, "e_sci_flux": None,
                "identifier": "1", "has_stamp": False,
            }]}],
            "forced_phot_bands": [],
            "n_det": 1, "n_fp": 0,
            "has_science_flux": False,
        }

    async def fake_info(*, survey, oid):
        return {"ra": 10.0, "dec": -20.0}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=lsst")
    assert r.status_code == 200
    # Flux/Mag still present; Diff/Sci hidden.
    assert "lc-mode-toggle" in r.text
    assert "lc-source-toggle" not in r.text


def test_lightcurve_rejects_unknown_survey(client):
    r = client.get("/htmx/lightcurve?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_lightcurve_upstream_error_renders_message(client, monkeypatch):
    async def fake_lc(*, survey, oid):
        raise RuntimeError("network down")

    async def fake_info(*, survey, oid):
        return {"ra": None, "dec": None}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_lightcurve_renders_even_when_object_info_fails(client, monkeypatch):
    """If the ra/dec lookup fails the panel still renders, sans auto E(B-V)."""
    async def fake_lc(*, survey, oid):
        return {
            "survey": survey,
            "bands": [{"name": "g", "points": [{
                "mjd": 60000.0, "flux": 1000.0, "e_flux": 10.0,
                "sci_flux": None, "e_sci_flux": None,
                "identifier": "1", "has_stamp": False,
            }]}],
            "forced_phot_bands": [],
            "n_det": 1, "n_fp": 0, "has_science_flux": True,
        }

    async def fake_info(*, survey, oid):
        raise RuntimeError("object_api down")

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve",
        fake_lc,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert 'id="lc-canvas-x"' in r.text
    # Without ra/dec the canvas doesn't carry the dust-fetch hints, but the
    # E(B-V) input and R_λ map are still there so manual override works.
    assert "data-ra=" not in r.text
    assert "data-dec=" not in r.text
    assert "data-ext-r=" in r.text
    assert 'id="lc-ebv-x"' in r.text


def test_detail_container_wires_lightcurve_slot(client):
    r = client.get("/htmx/detail?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="lightcurve-slot"' in r.text


def _stub_lc_and_info(monkeypatch, *, has_science_flux=True, ra=150.0, dec=30.0):
    async def fake_lc(*, survey, oid):
        return {
            "survey": survey,
            "bands": [{"name": "g", "points": [{
                "mjd": 60000.0, "flux": 1000.0, "e_flux": 10.0,
                "sci_flux": 1200.0, "e_sci_flux": 12.0,
                "identifier": "1", "has_stamp": True,
            }]}],
            "forced_phot_bands": [],
            "n_det": 1, "n_fp": 0, "has_science_flux": has_science_flux,
        }

    async def fake_info(*, survey, oid):
        return {"ra": ra, "dec": dec}

    monkeypatch.setattr("src.routes.htmx.lightcurve_service.get_lightcurve", fake_lc)
    monkeypatch.setattr("src.routes.htmx.object_info_service.get_object_info", fake_info)


def test_lightcurve_ztf_shows_dr_button_with_coords(client, monkeypatch):
    _stub_lc_and_info(monkeypatch, ra=212.8182939, dec=-3.5206587)
    r = client.get("/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'class="lc-dr-toggle' in r.text
    assert 'data-target="lc-canvas-ZTF21abc"' in r.text
    assert 'data-lc-dr="off"' in r.text
    assert 'data-ra="212.8182939"' in r.text
    assert 'data-dec="-3.5206587"' in r.text
    # Alpha slider ships alongside the button, starts hidden, and targets
    # the same canvas so the JS binder can pair them.
    assert 'class="lc-dr-alpha tw-hidden"' in r.text
    assert 'type="range"' in r.text
    assert 'orient="vertical"' in r.text


def test_lightcurve_lsst_also_shows_dr_button(client, monkeypatch):
    """DR is a positional cone-search (ra/dec + radius), so LSST objects can
    still have a ZTF DR archival crossmatch worth showing."""
    _stub_lc_and_info(monkeypatch, has_science_flux=False, ra=10.0, dec=-20.0)
    r = client.get("/htmx/lightcurve?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert 'class="lc-dr-toggle' in r.text
    assert 'data-ra="10.0"' in r.text
    assert 'data-dec="-20.0"' in r.text


def test_lightcurve_without_coords_hides_dr_button(client, monkeypatch):
    """DR needs ra/dec to cone-search; skip the button if the object_info call
    didn't yield usable coordinates."""
    _stub_lc_and_info(monkeypatch, ra=None, dec=None)
    r = client.get("/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "lc-dr-toggle" not in r.text


def test_api_ztf_dr_proxies_service(client, monkeypatch):
    captured = {}

    async def fake_dr(*, ra, dec, radius):
        captured.update(ra=ra, dec=dec, radius=radius)
        return {
            "bands": [{"name": "g", "points": [{
                "mjd": 59000.0, "flux": None, "e_flux": None,
                "sci_flux": 1234.0, "e_sci_flux": 56.0,
                "identifier": None, "has_stamp": False,
            }]}],
            "n_pts": 1,
        }

    monkeypatch.setattr("src.routes.rest.ztf_dr_service.get_ztf_dr", fake_dr)
    r = client.get("/api/ztf_dr?ra=212.8182939&dec=-3.5206587&radius=1.5")
    assert r.status_code == 200
    body = r.json()
    assert body["n_pts"] == 1
    assert body["bands"][0]["name"] == "g"
    # Diff flux must be null so the Diff/Sci toggle filters DR out in Diff mode.
    assert body["bands"][0]["points"][0]["flux"] is None
    assert captured == {"ra": 212.8182939, "dec": -3.5206587, "radius": 1.5}


def test_api_ztf_dr_upstream_error_is_502(client, monkeypatch):
    async def fake_dr(*, ra, dec, radius):
        raise RuntimeError("alerce down")

    monkeypatch.setattr("src.routes.rest.ztf_dr_service.get_ztf_dr", fake_dr)
    r = client.get("/api/ztf_dr?ra=1.0&dec=1.0")
    assert r.status_code == 502


def test_api_ztf_dr_validates_inputs(client):
    # dec out of range
    r = client.get("/api/ztf_dr?ra=10.0&dec=100.0")
    assert r.status_code == 422
    # negative radius
    r = client.get("/api/ztf_dr?ra=10.0&dec=-5.0&radius=-1")
    assert r.status_code == 422


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
            "stamp_url_templates": {
                "science": "https://x/science?id=__IDENT__",
                "template": "https://x/template?id=__IDENT__",
                "difference": "https://x/difference?id=__IDENT__",
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
    # Client-side identifier sync: URL templates emitted as data attrs, and the
    # picker's onchange calls the global helper (no htmx roundtrip).
    assert 'data-url-template-science="https://x/science?id=__IDENT__"' in r.text
    assert 'data-url-template-template=' in r.text
    assert 'data-url-template-difference=' in r.text
    assert "updateStampsForIdentifier" in r.text
    # Zoom controls — three buttons (−, reset, +) wired to window.zoomStamps.
    assert "stamps-zoom-btn" in r.text
    assert "stamps-zoom-reset" in r.text
    assert "zoomStamps(this, 1/1.25)" in r.text
    assert "zoomStamps(this, 1.25)" in r.text
    assert "zoomStamps(this, 'reset')" in r.text


def test_stamps_empty_shows_message(client, monkeypatch):
    async def fake_stamps(*, survey, oid, identifier=None):
        return {
            "oid": oid, "survey": survey,
            "detections": [], "selected": None,
            "stamp_types": ["science", "template", "difference"],
            "stamp_urls": {},
            "stamp_url_templates": {
                "science": "https://x/science?id=__IDENT__",
                "template": "https://x/template?id=__IDENT__",
                "difference": "https://x/difference?id=__IDENT__",
            },
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


def test_aladin_renders_host_with_coordinates(client, monkeypatch):
    async def fake_info(*, survey, oid):
        return {"oid": oid, "survey": survey, "ra": 180.125, "dec": -30.25}

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/aladin?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="aladin-panel"' in r.text
    assert "aladin-host" in r.text
    assert 'data-ra="180.125"' in r.text
    assert 'data-dec="-30.25"' in r.text
    assert 'data-oid="ZTF21abc"' in r.text


def test_aladin_without_coordinates_shows_message(client, monkeypatch):
    async def fake_info(*, survey, oid):
        return {"oid": oid, "survey": survey, "ra": None, "dec": None}

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/aladin?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "No coordinates" in r.text
    assert "aladin-host" not in r.text


def test_aladin_rejects_unknown_survey(client):
    r = client.get("/htmx/aladin?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_aladin_upstream_error(client, monkeypatch):
    async def fake_info(*, survey, oid):
        raise RuntimeError("object api down")

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/aladin?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_probability_renders_canvas_and_picker(client, monkeypatch):
    async def fake_prob(*, survey, oid):
        return {
            "groups": [
                {
                    "key": "lc_classifier_top v1.0",
                    "classifier_name": "lc_classifier_top",
                    "classifier_version": "1.0",
                    "classes": [
                        {"class_name": "SN", "probability": 0.8, "is_max": True},
                        {"class_name": "AGN", "probability": 0.2, "is_max": False},
                    ],
                },
                {
                    "key": "lc_classifier_transient v2.0",
                    "classifier_name": "lc_classifier_transient",
                    "classifier_version": "2.0",
                    "classes": [
                        {"class_name": "SN", "probability": 0.5, "is_max": True},
                    ],
                },
            ],
            "default_key": "lc_classifier_top v1.0",
        }

    monkeypatch.setattr(
        "src.routes.htmx.probability_service.get_probability_context",
        fake_prob,
    )
    r = client.get("/htmx/probability?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="radar-canvas-ZTF21abc"' in r.text
    assert "data-probs=" in r.text
    assert "lc_classifier_top v1.0" in r.text
    assert "lc_classifier_transient v2.0" in r.text
    # Picker is wired to the canvas for client-side switching.
    assert 'class="radar-classifier-select' in r.text
    assert 'data-target="radar-canvas-ZTF21abc"' in r.text


def test_probability_empty_shows_message(client, monkeypatch):
    async def fake_prob(*, survey, oid):
        return {"groups": [], "default_key": None}

    monkeypatch.setattr(
        "src.routes.htmx.probability_service.get_probability_context",
        fake_prob,
    )
    r = client.get("/htmx/probability?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "No probabilities" in r.text
    assert "radar-canvas" not in r.text


def test_probability_rejects_unknown_survey(client):
    r = client.get("/htmx/probability?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_probability_upstream_error(client, monkeypatch):
    async def fake_prob(*, survey, oid):
        raise RuntimeError("probability api down")

    monkeypatch.setattr(
        "src.routes.htmx.probability_service.get_probability_context",
        fake_prob,
    )
    r = client.get("/htmx/probability?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_coord_residuals_renders_canvas_and_colorbar(client, monkeypatch):
    async def fake_coord(*, survey, oid):
        return {
            "points": [
                {"d_ra": -0.3, "d_dec": 0.1, "mjd": 60000.0, "band": "g",
                 "identifier": "111", "has_stamp": True},
                {"d_ra": 0.6, "d_dec": -0.2, "mjd": 60100.0, "band": "r",
                 "identifier": "222", "has_stamp": True},
            ],
            "n_points": 2,
            "mean_ra": 150.0, "mean_dec": 30.0,
            "mjd_min": 60000.0, "mjd_max": 60100.0,
        }

    monkeypatch.setattr(
        "src.routes.htmx.coord_residuals_service.get_coord_residuals",
        fake_coord,
    )
    r = client.get("/htmx/coord_residuals?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="coord-canvas-ZTF21abc"' in r.text
    assert "data-coords=" in r.text
    # 2 pts label appears with the count.
    assert "2 pts" in r.text
    # Colorbar gradient + MJD endpoints present.
    assert "linear-gradient" in r.text
    assert "MJD 60000.00" in r.text
    assert "MJD 60100.00" in r.text


def test_coord_residuals_empty_shows_message(client, monkeypatch):
    async def fake_coord(*, survey, oid):
        return {
            "points": [], "n_points": 0,
            "mean_ra": None, "mean_dec": None,
            "mjd_min": None, "mjd_max": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.coord_residuals_service.get_coord_residuals",
        fake_coord,
    )
    r = client.get("/htmx/coord_residuals?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "Not enough detections" in r.text
    assert "coord-residuals-canvas" not in r.text


def test_coord_residuals_rejects_unknown_survey(client):
    r = client.get("/htmx/coord_residuals?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_coord_residuals_upstream_error(client, monkeypatch):
    async def fake_coord(*, survey, oid):
        raise RuntimeError("lightcurve api down")

    monkeypatch.setattr(
        "src.routes.htmx.coord_residuals_service.get_coord_residuals",
        fake_coord,
    )
    r = client.get("/htmx/coord_residuals?oid=x&survey_id=ztf")
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
