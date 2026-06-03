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


@pytest.fixture(autouse=True)
def _stub_tns(monkeypatch):
    """TNS is additive in the basic-info route; default every test to "no
    TNS match" so nobody accidentally hits api.alerce.online. The one test
    that exercises the positive path overrides this monkeypatch locally."""
    async def no_match(*, ra, dec):
        return None
    monkeypatch.setattr("src.routes.htmx.tns_service.get_tns_info", no_match)


@pytest.fixture
def stub_services(monkeypatch):
    async def fake_classifiers(survey):
        return [{"classifier_name": "lc_classifier_top",
                 "formatted_name": "lc classifier top",
                 "classes": ["SN", "AGN"],
                 "versions": ["1.0.0", "2.0.1"],
                 "latest_version": "2.0.1"}]

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
    # Detail nav row lives in the global header now (not the detail
    # container) so the panels reclaim that vertical space. It's hidden by
    # default; object_nav.js reveals it when an #object-detail is on screen.
    # Brand logo links to "/" — full page reload that resets filters and
    # results-slot to the empty-hint default. SVG lives under /static/img/.
    assert 'href="/"' in r.text
    assert "/static/img/alerce-logo.svg" in r.text
    assert 'id="detail-nav-bar"' in r.text
    assert "Back to results" in r.text
    assert 'id="object-nav-list"' in r.text
    assert 'id="object-nav"' in r.text
    assert 'id="object-nav-prev"' in r.text
    assert 'id="object-nav-next"' in r.text
    assert 'id="object-nav-position"' in r.text
    assert "navObject('prev')" in r.text
    assert "navObject('next')" in r.text


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


def test_object_redirect_ztf(client):
    """Legacy `/object/<oid>` URLs (mirroring alerce.online) auto-detect
    ZTF from the `ZTF<yy><letters>` shape and 302 to the deep-link
    form."""
    r = client.get("/object/ZTF18adqimwe", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("/?")
    assert "survey=ztf" in loc
    assert "oid=ZTF18adqimwe" in loc


def test_object_redirect_lsst(client):
    """All-digit OIDs are routed to LSST."""
    r = client.get("/object/313888627082919999", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert "survey=lsst" in loc
    assert "oid=313888627082919999" in loc


def test_object_redirect_preserves_extra_query_params(client):
    """A legacy URL with `?identifier=…` (e.g. a detection deep-link)
    keeps the param on the redirected target, but inferred survey/oid
    win over any passed in the query string."""
    r = client.get(
        "/object/ZTF17aabhbva?identifier=cand-1&survey=panstarrs",
        follow_redirects=False,
    )
    assert r.status_code == 302
    loc = r.headers["location"]
    assert "survey=ztf" in loc
    assert loc.count("survey=") == 1  # passed survey was dropped
    assert "identifier=cand-1" in loc


def test_object_redirect_rejects_unrecognized_oid(client):
    r = client.get("/object/banana", follow_redirects=False)
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
        "&classifier_version=2.1.0&class_name=SN&probability=0.5"
        "&n_det_min=5&n_det_max=50"
        "&firstmjd_min=60000.0&firstmjd_max=60100.0"
        "&lastmjd_min=60050.0&lastmjd_max=60200.0"
        "&ra=150.0&dec=2.0&radius=30.0"
        "&oids=ZTF1,ZTF2&page=3"
    )
    assert r.status_code == 200
    assert r.headers.get("HX-Push-Url") == (
        "/?survey=ztf&classifier=lc_classifier_top&classifier_version=2.1.0"
        "&class_name=SN&probability=0.5"
        "&n_det_min=5&n_det_max=50&firstmjd_min=60000.0&firstmjd_max=60100.0"
        "&lastmjd_min=60050.0&lastmjd_max=60200.0"
        "&ra=150.0&dec=2.0&radius=30.0&oids=ZTF1%2CZTF2&page=3"
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


def test_list_objects_emits_total_pages_for_oid_list(client, monkeypatch):
    """When the search uses an OID list, total page count is exact:
    ceil(len(parsed oids) / page_size). The dots-row dropdown reads this
    from data-nav so it can list 1..N up-front instead of the "…" marker."""
    async def fake_objects(**kwargs):
        return {
            "items": [{"oid": f"OID{i}"} for i in range(20)],
            "current_page": 1, "has_prev": False, "prev": False,
            "has_next": True, "next": 2, "info_message": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_list_service.get_objects_list",
        fake_objects,
    )
    # 25 distinct oids with page_size=20 → 2 pages exactly.
    oids = ",".join(f"OID{i}" for i in range(25))
    r = client.get(f"/htmx/list_objects?survey=lsst&oids={oids}")
    assert r.status_code == 200
    # data-nav is HTML-encoded by Jinja autoescape (&#34; for ").
    assert "&#34;total_pages&#34;:2" in r.text


def test_list_objects_omits_total_pages_for_generic_search(client, monkeypatch):
    """Without an OID list we have no way to know the total — data-nav
    must say `total_pages: null` so the dropdown falls back to the "…"
    open-ended marker."""
    async def fake_objects(**kwargs):
        return {
            "items": [{"oid": "X"}], "current_page": 1,
            "has_prev": False, "prev": False,
            "has_next": True, "next": 2, "info_message": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_list_service.get_objects_list",
        fake_objects,
    )
    r = client.get("/htmx/list_objects?survey=lsst&classifier=lc_top&class_name=SN")
    assert r.status_code == 200
    assert "&#34;total_pages&#34;:null" in r.text


def test_list_objects_dedupes_repeated_oids_for_total_pages(client, monkeypatch):
    """A user pasting the same OID twice shouldn't inflate the total
    page count. parse_oid_list dedupes before the ceil()."""
    async def fake_objects(**kwargs):
        return {
            "items": [], "current_page": 1, "has_prev": False, "prev": False,
            "has_next": False, "next": False, "info_message": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_list_service.get_objects_list",
        fake_objects,
    )
    # 21 distinct OIDs but duplicated → still 2 pages.
    base = [f"OID{i}" for i in range(21)]
    oids = ",".join(base + base)
    r = client.get(f"/htmx/list_objects?survey=lsst&oids={oids}")
    assert r.status_code == 200
    assert "&#34;total_pages&#34;:2" in r.text


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
        "&firstmjd_min=60000.5&firstmjd_max=60100.5&ra=150.0&dec=2.0&radius=45"
    )
    assert r.status_code == 200
    # Free-text OID list is pre-populated.
    assert 'value="OID1,OID2"' in r.text
    # Min-probability input carries the value (replaces the old slider; the
    # readout span the slider used is gone).
    assert 'value="0.42"' in r.text
    # Min/max detection inputs carry the integers.
    assert 'value="5"' in r.text
    assert 'value="50"' in r.text
    # Discovery-date and conesearch fields are pre-filled too.
    assert 'value="60000.5"' in r.text
    assert 'value="60100.5"' in r.text
    assert 'value="150.000000 2.000000"' in r.text
    # radius is parsed as float by FastAPI; Jinja renders 45.0 → "45.0"
    assert 'value="45.0"' in r.text
    # Dependent class options are rendered server-side with SN selected.
    assert '<option value="SN" selected>SN</option>' in r.text


def test_search_form_renders_classifier_version_dropdown(client, stub_services):
    """The version select carries the static Latest/Any options plus a
    `data-versions` JSON list on each classifier option so the inline JS
    can repopulate the per-version options on classifier change."""
    r = client.get("/htmx/search_objects/?survey=lsst&classifier=lc_classifier_top")
    assert r.status_code == 200
    # Static modes always present.
    assert 'id="classifier_version"' in r.text
    assert '<option value="latest"' in r.text
    assert '<option value="any"' in r.text
    # Per-version options pre-rendered for the deep-linked classifier so the
    # form is fully hydrated without waiting on a JS event.
    assert '<option value="1.0.0"' in r.text
    assert '<option value="2.0.1"' in r.text
    # Each classifier option carries its versions + latest as data attrs so
    # client-side JS can resolve "Latest" and rebuild the dropdown without
    # a server round trip.
    assert 'data-versions=' in r.text
    assert 'data-latest-version="2.0.1"' in r.text


def test_search_form_preselects_classifier_version(client, stub_services):
    """Deep-link with `classifier_version=1.0.0` → that option lands as
    `selected` so the form mirrors what the URL is asking for."""
    r = client.get(
        "/htmx/search_objects/?survey=lsst&classifier=lc_classifier_top"
        "&classifier_version=1.0.0"
    )
    assert r.status_code == 200
    assert '<option value="1.0.0" selected>1.0.0</option>' in r.text


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
    # can lag by a tick after a client-side navigation) and toggle the
    # global header's #detail-nav-bar visibility.
    assert 'data-oid="ZTF21abc"' in r.text
    assert 'data-survey-id="ztf"' in r.text
    # Periodogram panel ships inline (hidden) inside the same grid cell as
    # the position-residuals panel; the LC toolbar's button toggles them.
    assert 'id="periodogram-slot"' in r.text
    assert 'data-pg-panel' in r.text
    assert 'data-lc-target="lc-canvas-ZTF21abc"' in r.text
    # Airmass panel shares the same cell as periodogram + position-residuals;
    # its toggle is fired from the basic-info "Airmass" button.
    assert 'id="airmass-slot"' in r.text
    assert "data-airmass-panel" in r.text
    assert "airmass-canvas" in r.text
    # Crossmatch slot — collapsed <details> at the bottom of the page; the
    # body fetches /htmx/crossmatch on `load` so the data is in the DOM
    # before the user expands the panel.
    assert 'id="crossmatch-slot"' in r.text
    assert 'id="crossmatch-details"' in r.text
    assert 'id="crossmatch-body"' in r.text
    assert "/htmx/crossmatch?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'hx-trigger="load"' in r.text
    # The Back button + prev/next arrows used to live in this fragment but
    # were promoted to the global header (#detail-nav-bar in index.html.jinja)
    # so the detail panels reclaim that row of vertical space.
    assert "Back to results" not in r.text
    assert 'id="object-nav"' not in r.text


def test_detail_rejects_unknown_survey(client):
    r = client.get("/htmx/detail?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_object_information_renders_basic_fields(client, monkeypatch):
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey,
            "ra": 180.0, "dec": -30.0,
            "ra_hms": "12:00:00.000", "dec_dms": "-30:00:00.00",
            "l_gal": 298.88, "b_gal": 31.98,
            "lambda_ecl": 201.76, "beta_ecl": -21.88,
            "firstmjd": 60000.0, "lastmjd": 60100.0, "delta_mjd": 100.0,
            "n_det": 12, "n_non_det": 38, "n_forced": None,
            "corrected": True, "stellar": False,
            "archives": [{"name": "SIMBAD", "url": "https://simbad.u-strasbg.fr/simbad/sim-coo?Coord=180.0%20-30.0&Radius.unit=arcsec&Radius=10"}],
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/object_information?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "ZTF21abc" in r.text
    # Both coord formats land in the markup (the sexagesimal form is stashed
    # on data-sex so the toggle can swap it in without a round-trip).
    assert "12:00:00.000" in r.text
    assert "-30:00:00.00" in r.text
    assert 'data-sex="12:00:00.000"' in r.text
    assert 'data-sex="-30:00:00.00"' in r.text
    # Coord controls: HMS/Deg format toggle, copy button, ⇄ system toggle
    # (next to RA), and the two .coord-label spans it swaps labels on.
    # Pre-computed galactic/ecliptic values are stashed on the value cells so
    # JS never has to do the rotation on click.
    assert "coord-format-toggle" in r.text
    assert "coord-system-toggle" in r.text
    assert "coord-copy-btn" in r.text
    assert "coord-label" in r.text
    assert 'data-gal="298.88000"' in r.text
    assert 'data-gal="31.98000"' in r.text
    assert 'data-ecl="201.76000"' in r.text
    assert 'data-ecl="-21.88000"' in r.text
    assert "60000.000" in r.text
    assert "SIMBAD" in r.text
    # ZTF has a features endpoint, so the "Show features" button should render.
    assert "Show features" in r.text
    assert "/htmx/features?oid=ZTF21abc&survey_id=ztf" in r.text
    # Airmass button — rendered when ra/dec are known; calls the toggle with
    # oid + numeric coords so the panel can compute without re-fetching.
    assert "basic-info-airmass-btn" in r.text
    assert "toggleAirmassPanel" in r.text
    assert "'ZTF21abc', 180.0, -30.0" in r.text


def test_object_information_hides_airmass_button_without_coords(client, monkeypatch):
    """Airmass needs an object position; an LSST row missing meanra/meandec
    must not render the button (clicking would compute Moon-only, which is
    misleading)."""
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey, "ra": None, "dec": None,
            "ra_hms": None, "dec_dms": None,
            "l_gal": None, "b_gal": None,
            "lambda_ecl": None, "beta_ecl": None,
            "firstmjd": 60000.0, "lastmjd": 60001.0, "delta_mjd": 1.0,
            "n_det": 1, "n_non_det": 0, "n_forced": None,
            "corrected": None, "stellar": None, "archives": [],
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    r = client.get("/htmx/object_information?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "basic-info-airmass-btn" not in r.text
    assert "toggleAirmassPanel" not in r.text


def test_object_information_hides_features_button_for_lsst(client, monkeypatch):
    """LSST has no features_url_template — the button must not render."""
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey, "ra": 1.0, "dec": 2.0,
            "ra_hms": "00:04:00.000", "dec_dms": "+02:00:00.00",
            "l_gal": 109.8, "b_gal": -60.0,
            "lambda_ecl": 1.8, "beta_ecl": 1.5,
            "firstmjd": 60000.0, "lastmjd": 60001.0, "delta_mjd": 1.0,
            "n_det": 1, "n_non_det": 0, "n_forced": 1,
            "corrected": None, "stellar": None, "archives": [],
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/object_information?oid=9123456789012345&survey_id=lsst")
    assert r.status_code == 200
    # The Show-features button is identifiable by its hx-target attribute —
    # plain "Show features" text also appears in the hover help, so we key on
    # the button's htmx wiring to assert "button not rendered" cleanly.
    assert 'hx-target="#features-modal"' not in r.text


def test_object_information_renders_tns_placeholder(client, monkeypatch):
    """The basic-info template no longer renders the TNS strip inline
    (the bridge is too slow — used to block this whole panel for ~12 s).
    It now renders a placeholder div that hx-gets /htmx/tns_lookup on
    load; the deferred response fills it in via innerHTML when (and if)
    the cone-search returns a match."""
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey,
            "ra": 353.977, "dec": 47.076,
            "ra_hms": "23:35:54.528", "dec_dms": "+47:04:33.49",
            "l_gal": 108.1, "b_gal": -13.1,
            "lambda_ecl": 10.0, "beta_ecl": 45.0,
            "firstmjd": 60000.0, "lastmjd": 60100.0, "delta_mjd": 100.0,
            "n_det": 5, "n_non_det": 0, "n_forced": None,
            "corrected": True, "stellar": False,
            "archives": [],
        }

    monkeypatch.setattr("src.routes.htmx.object_info_service.get_object_info", fake_info)
    r = client.get("/htmx/object_information?oid=ZTF25twl&survey_id=ztf")
    assert r.status_code == 200
    # Placeholder is wired with hx-get to the deferred TNS endpoint and
    # carries the ra/dec the cone-search needs.
    assert 'id="basic-info-tns"' in r.text
    assert "/htmx/tns_lookup" in r.text
    assert "oid=ZTF25twl" in r.text
    assert "ra=353.977" in r.text
    assert "dec=47.076" in r.text
    # Inline TNS strip is no longer rendered in the synchronous response.
    assert "tns-block" not in r.text


def test_tns_lookup_renders_strip_on_match(client, monkeypatch):
    """The deferred /htmx/tns_lookup endpoint returns the styled TNS strip
    when the ALeRCE bridge finds a match, plus an inline script that
    auto-populates `#lc-redshift-{oid}` if the report carries a redshift."""
    async def fake_tns(*, ra, dec):
        return {
            "type": "SN Ia",
            "name": "2025twl",
            "redshift": 0.043,
            "url": "https://www.wis-tns.org/object/2025twl",
        }

    monkeypatch.setattr("src.routes.htmx.tns_service.get_tns_info", fake_tns)
    r = client.get("/htmx/tns_lookup?oid=ZTF25twl&ra=353.977&dec=47.076")
    assert r.status_code == 200
    assert "tns-block" in r.text
    assert "SN Ia" in r.text
    assert "2025twl" in r.text
    assert "0.0430" in r.text
    assert "https://www.wis-tns.org/object/2025twl" in r.text
    # Inline script for LC redshift autopop — keys off the per-oid input id.
    assert 'getElementById("lc-redshift-ZTF25twl")' in r.text


def test_tns_lookup_returns_empty_on_no_match(client, monkeypatch):
    """No match → empty body, so the basic-info placeholder stays empty
    (no border, no header, no "no TNS match" noise)."""
    async def fake_tns(*, ra, dec):
        return None

    monkeypatch.setattr("src.routes.htmx.tns_service.get_tns_info", fake_tns)
    r = client.get("/htmx/tns_lookup?oid=ZTF25twl&ra=10.0&dec=20.0")
    assert r.status_code == 200
    assert "tns-block" not in r.text
    assert 'getElementById("lc-redshift' not in r.text


def test_object_information_skips_tns_placeholder_without_coords(client, monkeypatch):
    """LSST objects sometimes lack ra/dec; the deferred TNS placeholder
    shouldn't render in that case — the TNS bridge needs coords for its
    cone-search, and an unwired placeholder would just spin forever."""
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey, "ra": None, "dec": None,
            "ra_hms": None, "dec_dms": None,
            "l_gal": None, "b_gal": None,
            "lambda_ecl": None, "beta_ecl": None,
            "firstmjd": 60000.0, "lastmjd": 60001.0, "delta_mjd": 1.0,
            "n_det": 1, "n_non_det": 0, "n_forced": None,
            "corrected": None, "stellar": None, "archives": [],
        }

    monkeypatch.setattr("src.routes.htmx.object_info_service.get_object_info", fake_info)
    r = client.get("/htmx/object_information?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert 'id="basic-info-tns"' not in r.text
    assert "tns-block" not in r.text


def test_features_route_renders_table_with_version_picker(client, monkeypatch):
    async def fake_features(*, survey, oid):
        return {
            "available": True,
            "rows": [
                {"name": "Amplitude", "band": "g", "value_display": "0.5",
                 "version": "v_old"},
                {"name": "Multiband_period", "band": "multi",
                 "value_display": "1.234", "version": "v_new"},
            ],
            "versions": ["v_old", "v_new"],
            "default_version": "v_new",
            "n_by_version": {"v_old": 1, "v_new": 1},
            "n": 2,
        }

    monkeypatch.setattr(
        "src.routes.htmx.features_service.get_features",
        fake_features,
    )
    r = client.get("/htmx/features?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "Amplitude" in r.text
    assert "Multiband_period" in r.text
    # Version select renders both options with their counts.
    assert "features-version-select" in r.text
    assert "v_old (1)" in r.text
    assert "v_new (1)" in r.text
    # The default version's count drives the banner.
    assert "features-visible-count" in r.text
    # Filter input still present.
    assert "features-filter-input" in r.text
    # Download button renders so users can export the active version.
    assert "features-download-btn" in r.text
    assert 'data-oid="ZTF21abc"' in r.text


def test_features_route_shows_unavailable_for_lsst(client, monkeypatch):
    async def fake_features(*, survey, oid):
        return {
            "available": False, "rows": [], "n": 0,
            "versions": [], "n_by_version": {}, "default_version": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.features_service.get_features",
        fake_features,
    )
    r = client.get("/htmx/features?oid=1&survey_id=lsst")
    assert r.status_code == 200
    assert "doesn't publish a feature table" in r.text


def test_features_route_renders_upstream_error(client, monkeypatch):
    async def boom(*, survey, oid):
        raise RuntimeError("nope")

    monkeypatch.setattr(
        "src.routes.htmx.features_service.get_features",
        boom,
    )
    r = client.get("/htmx/features?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_crossmatch_route_renders_catalog_tables(client, monkeypatch):
    """Happy path: object_info supplies coords, crossmatch service returns
    a couple of catalogs, the panel renders one card per catalog with the
    field key/value cells stamped in."""
    async def fake_info(*, survey, oid):
        return {"ra": 180.0, "dec": 0.5}

    async def fake_xmatch(*, ra, dec, radius=30.0):
        assert (ra, dec) == (180.0, 0.5)
        return {
            "available": True, "ra": ra, "dec": dec, "radius": radius,
            "catalogs": [
                {"name": "DECaLS", "fields": [
                    {"key": "RA", "value": "180.000180", "unit": "deg"},
                    {"key": "distance", "value": "2.525669", "unit": "arcsec"},
                ]},
                {"name": "GAIA/DR2", "fields": [
                    {"key": "Mag_G", "value": "19.715656", "unit": "mag"},
                ]},
            ],
            "n_catalogs": 2, "error": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    monkeypatch.setattr(
        "src.routes.htmx.crossmatch_service.get_crossmatch", fake_xmatch,
    )
    r = client.get("/htmx/crossmatch?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "DECaLS" in r.text
    assert "GAIA/DR2" in r.text
    assert "180.000180" in r.text
    assert "2.525669" in r.text
    assert "Mag_G" in r.text
    assert "[deg]" in r.text
    assert "[arcsec]" in r.text
    # Banner shows the catalog count + the radius the user is seeing.
    assert "2 catalogs matched" in r.text


def test_crossmatch_route_no_coords_renders_hint(client, monkeypatch):
    """LSST objects sometimes lack ra/dec — render the "no coords" hint
    instead of trying to call catsHTM with NaNs."""
    async def fake_info(*, survey, oid):
        return {"ra": None, "dec": None}

    async def fake_xmatch(*, ra, dec, radius=30.0):
        return {
            "available": False, "ra": None, "dec": None, "radius": radius,
            "catalogs": [], "n_catalogs": 0, "error": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    monkeypatch.setattr(
        "src.routes.htmx.crossmatch_service.get_crossmatch", fake_xmatch,
    )
    r = client.get("/htmx/crossmatch?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert "No coordinates" in r.text


def test_crossmatch_route_renders_no_match_message(client, monkeypatch):
    """Empty catsHTM result → friendly message instead of a bare panel."""
    async def fake_info(*, survey, oid):
        return {"ra": 0.0, "dec": 0.0}

    async def fake_xmatch(*, ra, dec, radius=30.0):
        return {
            "available": True, "ra": ra, "dec": dec, "radius": radius,
            "catalogs": [], "n_catalogs": 0, "error": None,
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    monkeypatch.setattr(
        "src.routes.htmx.crossmatch_service.get_crossmatch", fake_xmatch,
    )
    r = client.get("/htmx/crossmatch?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "No crossmatch results" in r.text


def test_crossmatch_route_renders_upstream_error(client, monkeypatch):
    """catsHTM down → render the error string so the user sees we tried
    rather than seeing "No crossmatch results" (which would imply we got
    a real empty response)."""
    async def fake_info(*, survey, oid):
        return {"ra": 1.0, "dec": 2.0}

    async def fake_xmatch(*, ra, dec, radius=30.0):
        return {
            "available": True, "ra": ra, "dec": dec, "radius": radius,
            "catalogs": [], "n_catalogs": 0, "error": "boom",
        }

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    monkeypatch.setattr(
        "src.routes.htmx.crossmatch_service.get_crossmatch", fake_xmatch,
    )
    r = client.get("/htmx/crossmatch?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "catsHTM error" in r.text
    assert "boom" in r.text


def test_crossmatch_route_rejects_unknown_survey(client):
    r = client.get("/htmx/crossmatch?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


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
    # ra/dec are NOT server-rendered anymore — they arrive via deferred
    # /htmx/lc_info and `lcSetCoords` stamps them onto the canvas at runtime.
    # R_λ per-band map still comes from SurveyConfig.
    assert "data-ra=" not in r.text
    assert "data-dec=" not in r.text
    assert "data-ext-r=" in r.text
    assert "3.237" in r.text  # R_g for ZTF/LSST
    # CSV download button + per-chart data-oid it uses for the filename.
    assert 'class="lc-download-btn' in r.text
    assert 'data-oid="ZTF21abc"' in r.text
    # Periodogram toggle in the LC toolbar wires to togglePeriodogramPanel.
    assert 'class="lc-periodogram-btn' in r.text
    assert "togglePeriodogramPanel('lc-canvas-ZTF21abc')" in r.text
    # The z input is NEVER pre-filled server-side now — TNS redshift arrives
    # via the deferred /htmx/tns_lookup fragment and is set in DOM by the
    # inline script there.
    assert 'id="lc-redshift-ZTF21abc"' in r.text
    assert "value=" not in (
        r.text.split('id="lc-redshift-ZTF21abc"')[1].split(">", 1)[0]
    )
    # Loading status strip reveals the four deferred fetches the panel
    # depends on (FP, features, coords, cross-survey lookup).
    assert "/htmx/lc_fp?oid=ZTF21abc" in r.text
    assert "/htmx/lc_features?oid=ZTF21abc" in r.text
    assert "/htmx/lc_info?oid=ZTF21abc" in r.text
    assert "/htmx/lc_xsurvey?oid=ZTF21abc" in r.text


def test_lc_fp_endpoint_returns_inline_setBundle(client, monkeypatch):
    """Deferred FP endpoint hands the freshly re-shaped bundle to
    `lcSetBundle` so the chart picks up FP + the v2 mag_corr-merged
    detections in place."""
    async def fake_bundle(*, survey, oid):
        return {
            "survey": survey,
            "bands": [{"name": "g", "points": []}],
            "forced_phot_bands": [{"name": "g", "points": [{
                "mjd": 59999.0, "flux": 50.0, "e_flux": 8.0,
                "sci_flux": None, "e_sci_flux": None,
                "identifier": None, "has_stamp": False,
            }]}],
            "n_det": 0, "n_fp": 1, "has_science_flux": True,
        }

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_fp_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_fp?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetBundle" in r.text
    assert '"lc-canvas-ZTF21abc"' in r.text
    assert "forced_phot_bands" in r.text


def test_lc_features_endpoint_returns_inline_setFeatures(client, monkeypatch):
    """Deferred features endpoint hands `multiband_period` + parametric_fits
    to `lcSetFeatures` so the Fold button and overlay picker can reveal
    themselves with the right data."""
    async def fake_bundle(*, survey, oid):
        return {
            "multiband_period": 3.14159,
            "parametric_fits": {
                "spm": {"g": {"A": 0.5, "beta": 0.3, "t0": 5.0,
                              "gamma": 2.0, "tau_rise": 1.0, "tau_fall": 10.0}},
            },
        }

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_features_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_features?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetFeatures" in r.text
    assert "3.14159" in r.text
    assert '"spm"' in r.text


def test_lc_info_endpoint_returns_inline_setCoords(client, monkeypatch):
    """Deferred info endpoint hands ra/dec to `lcSetCoords`, which reveals
    the ZTF DR control + kicks off the dust-proxy fetch."""
    async def fake_info(*, survey, oid):
        return {"ra": 212.8, "dec": -3.5}

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    r = client.get("/htmx/lc_info?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetCoords" in r.text
    assert "212.8" in r.text
    assert "-3.5" in r.text


def test_lc_info_endpoint_handles_missing_coords(client, monkeypatch):
    """When object_info has no coords (or fails outright), the fragment
    still consumes the placeholder spinner — just doesn't try to call
    lcSetCoords with non-finite values."""
    async def fake_info(*, survey, oid):
        return {"ra": None, "dec": None}

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    r = client.get("/htmx/lc_info?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetCoords" not in r.text


def test_lc_xsurvey_endpoint_returns_inline_setCrossSurvey(client, monkeypatch):
    """Deferred cross-survey endpoint hands the matched-other-survey LC
    bundle to `lcSetCrossSurvey` so the chart can overlay LSST + ZTF
    photometry under one set of toggles."""
    async def fake_bundle(*, survey, oid):
        return {
            "survey": "ztf",
            "oid": "ZTF17aabhbva",
            "bands": [{"name": "g", "points": [{
                "mjd": 60000.0, "flux": 1000.0, "e_flux": 50.0,
                "sci_flux": None, "e_sci_flux": None,
                "identifier": "1", "has_stamp": False, "isdiffpos": 1,
            }]}],
            "forced_phot_bands": [],
            "n_det": 1, "n_fp": 0, "has_science_flux": True,
        }

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_xsurvey_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_xsurvey?oid=313888627082919999&survey_id=lsst")
    assert r.status_code == 200
    assert "window.lcSetCrossSurvey" in r.text
    assert '"lc-canvas-313888627082919999"' in r.text
    assert "ZTF17aabhbva" in r.text


def test_lc_xsurvey_endpoint_handles_no_match(client, monkeypatch):
    """No counterpart on the other survey ⇒ fragment still consumes the
    placeholder spinner (via lcMaybeHideLoadingStrip) but doesn't call
    lcSetCrossSurvey."""
    async def fake_bundle(*, survey, oid):
        return None

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_xsurvey_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_xsurvey?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetCrossSurvey" not in r.text
    assert "lcMaybeHideLoadingStrip" in r.text


def test_lc_gp_endpoint_returns_inline_setGp(client, monkeypatch):
    """Deferred GP endpoint hands the per-band posterior grid to
    `window.lcSetGp` so the client can draw the multi-band overlay."""
    async def fake_bundle(*, survey, oid, fold_period=None, science=False):
        return {
            "available": True,
            "grid": [{
                "survey": "ztf", "surveys": ["ztf"], "band": "g", "lambda_eff": 4746.0,
                "mjd": [60000.0, 60001.0], "flux_mean": [1000.0, 1100.0],
                "flux_std": [50.0, 55.0],
            }],
            "hyperparams": {"l_t_days": 12.3, "l_lambda_kA": 1.5,
                            "sigma_f_njy": 900.0, "jitter_njy": 10.0},
            "n_points": 30, "n_bands": 1, "folded": False, "period": None,
            "message": "", "oid": oid,
        }

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_gp_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_gp?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetGp" in r.text
    assert '"lc-canvas-ZTF21abc"' in r.text
    assert '"available":true' in r.text


def test_lc_gp_endpoint_handles_fit_failure(client, monkeypatch):
    """A raised error from the service still yields a 200 fragment carrying an
    `available:false` bundle so the client clears the spinner + reverts."""
    async def boom(*, survey, oid, fold_period=None, science=False):
        raise RuntimeError("sklearn blew up")

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_gp_bundle", boom,
    )
    r = client.get("/htmx/lc_gp?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "window.lcSetGp" in r.text
    assert '"available":false' in r.text


def test_lc_gp_endpoint_forwards_fold_period(client, monkeypatch):
    """A fold_period query param is forwarded to the service so the GP is fit
    on the folded (phase) light curve."""
    seen = {}

    async def fake_bundle(*, survey, oid, fold_period=None, science=False):
        seen["fold_period"] = fold_period
        return {"available": True, "grid": [{
            "survey": "ztf", "surveys": ["ztf"], "band": "g", "lambda_eff": 4746.0,
            "mjd": [0.0, 0.5, 1.0], "flux_mean": [1.0, 2.0, 1.0], "flux_std": [1.0, 1.0, 1.0],
        }], "hyperparams": {"l_t_days": 0.1, "l_lambda_kA": 1.0,
                            "sigma_f_njy": 1.0, "jitter_njy": 0.1},
            "n_points": 20, "n_bands": 1, "folded": True, "period": 2.5,
            "message": "", "oid": oid}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_gp_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_gp?oid=ZTF21abc&survey_id=ztf&fold_period=2.5")
    assert r.status_code == 200
    assert seen["fold_period"] == 2.5
    assert '"folded":true' in r.text


def test_lc_gp_endpoint_forwards_science_flag(client, monkeypatch):
    """science=1 selects a science-flux fit (unfolded Sci mode)."""
    seen = {}

    async def fake_bundle(*, survey, oid, fold_period=None, science=False):
        seen["science"] = science
        return {"available": True, "grid": [{
            "survey": "ztf", "surveys": ["ztf"], "band": "g", "lambda_eff": 4746.0,
            "mjd": [60000.0, 60001.0], "flux_mean": [9000.0, 9100.0], "flux_std": [50.0, 55.0],
        }], "hyperparams": {"l_t_days": 12.0, "l_lambda_kA": 1.0,
                            "sigma_f": 1.0, "jitter": 0.1},
            "n_points": 20, "n_bands": 1, "folded": False, "period": None,
            "science": True, "message": "", "oid": oid}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lc_gp_bundle", fake_bundle,
    )
    r = client.get("/htmx/lc_gp?oid=ZTF21abc&survey_id=ztf&science=1")
    assert r.status_code == 200
    assert seen["science"] is True
    assert '"science":true' in r.text


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
    # Download button lives inside the same conditional — nothing to
    # download when there's no data.
    assert "lc-download-btn" not in r.text


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


def test_lightcurve_synchronous_render_does_not_call_object_info(client, monkeypatch):
    """The synchronous LC route is detections-only now — no object_info,
    no FP, no features, no TNS. ra/dec ride the deferred /htmx/lc_info
    fragment instead. Guards against re-introducing the slow blocking
    fetches that used to push the panel to 15 s per object."""
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

    info_calls = 0

    async def fake_info(*, survey, oid):
        nonlocal info_calls
        info_calls += 1
        return {"ra": 1.0, "dec": 2.0}

    monkeypatch.setattr(
        "src.routes.htmx.lightcurve_service.get_lightcurve", fake_lc,
    )
    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info", fake_info,
    )
    r = client.get("/htmx/lightcurve?oid=x&survey_id=lsst")
    assert r.status_code == 200
    assert 'id="lc-canvas-x"' in r.text
    # Synchronous path doesn't hit object_info anymore.
    assert info_calls == 0
    # E(B-V) input + R_λ map are still there so manual override works.
    assert "data-ext-r=" in r.text
    assert 'id="lc-ebv-x"' in r.text


def test_detail_container_wires_lightcurve_slot(client):
    r = client.get("/htmx/detail?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert "/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf" in r.text
    assert 'id="lightcurve-slot"' in r.text


def _stub_lc_and_info(
    monkeypatch, *, has_science_flux=True, ra=150.0, dec=30.0, parametric_fits=None,
):
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
            "parametric_fits": parametric_fits or {},
        }

    async def fake_info(*, survey, oid):
        return {"ra": ra, "dec": dec}

    monkeypatch.setattr("src.routes.htmx.lightcurve_service.get_lightcurve", fake_lc)
    monkeypatch.setattr("src.routes.htmx.object_info_service.get_object_info", fake_info)


def test_lightcurve_ztf_dr_button_renders_hidden_initially(client, monkeypatch):
    """ZTF DR is now ALWAYS rendered (hidden initially). The deferred
    /htmx/lc_info fragment calls `lcSetCoords` to stamp data-ra/data-dec
    and reveal the wrap. Keeps the synchronous LC route from blocking on
    object_info just to decide whether to render this control."""
    _stub_lc_and_info(monkeypatch, ra=212.8182939, dec=-3.5206587)
    r = client.get("/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'class="lc-dr-toggle' in r.text
    assert 'data-target="lc-canvas-ZTF21abc"' in r.text
    assert 'data-lc-dr="off"' in r.text
    # Wrapper carries the tw-hidden class until coords arrive.
    assert 'id="lc-dr-wrap-ZTF21abc"' in r.text
    assert "lc-dr-wrap" in r.text
    assert "tw-hidden" in r.text
    # data-ra/data-dec are stamped at runtime by lcSetCoords, not the server.
    assert 'data-ra="212.8182939"' not in r.text
    assert 'data-dec="-3.5206587"' not in r.text
    # Alpha slider ships alongside, starts hidden.
    assert 'class="lc-dr-alpha tw-hidden"' in r.text


def test_lightcurve_overlay_picker_renders_hidden_initially(client, monkeypatch):
    """Overlay picker is now ALWAYS rendered (hidden + all options
    disabled). The deferred /htmx/lc_features fragment calls
    `lcSetFeatures`, which un-disables the options the object actually
    has and removes tw-hidden."""
    _stub_lc_and_info(monkeypatch)
    r = client.get("/htmx/lightcurve?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'class="lc-overlay-select' in r.text
    assert 'id="lc-overlay-ZTF21abc"' in r.text
    assert 'id="lc-overlay-wrap-ZTF21abc"' in r.text
    # All non-"none" options start disabled — `lcSetFeatures` opens up
    # whichever fits the object actually has.
    assert 'value="spm" disabled' in r.text
    assert 'value="fleet" disabled' in r.text
    assert 'value="tde" disabled' in r.text
    # Info strip is unconditionally present so `lcSetFeatures` can populate
    # it once the user picks an overlay.
    assert 'id="lc-overlay-info-ZTF21abc"' in r.text


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


def test_api_lsst_neighbors_proxies_service(client, monkeypatch):
    captured = {}

    async def fake_neighbors(*, ra, dec, lastmjd, exclude_oid):
        captured.update(ra=ra, dec=dec, lastmjd=lastmjd, exclude_oid=exclude_oid)
        return [
            {"oid": "111", "ra": ra + 0.01, "dec": dec + 0.01, "lastmjd": lastmjd},
            {"oid": "222", "ra": ra - 0.01, "dec": dec - 0.01, "lastmjd": lastmjd + 0.01},
        ]

    monkeypatch.setattr(
        "src.routes.rest.lsst_neighbors_service.get_lsst_neighbors",
        fake_neighbors,
    )
    r = client.get(
        "/api/lsst_neighbors?ra=180.0&dec=-30.0&lastmjd=60000.0&exclude_oid=999"
    )
    assert r.status_code == 200
    body = r.json()
    assert [row["oid"] for row in body] == ["111", "222"]
    assert captured == {
        "ra": 180.0, "dec": -30.0, "lastmjd": 60000.0, "exclude_oid": "999",
    }


def test_api_lsst_neighbors_upstream_error_is_502(client, monkeypatch):
    async def fake_neighbors(*, ra, dec, lastmjd, exclude_oid):
        raise RuntimeError("lsst down")

    monkeypatch.setattr(
        "src.routes.rest.lsst_neighbors_service.get_lsst_neighbors",
        fake_neighbors,
    )
    r = client.get("/api/lsst_neighbors?ra=180.0&dec=-30.0&lastmjd=60000.0")
    assert r.status_code == 502


def test_api_lsst_neighbors_validates_inputs(client):
    # dec out of range
    r = client.get("/api/lsst_neighbors?ra=10.0&dec=100.0&lastmjd=60000.0")
    assert r.status_code == 422
    # lastmjd must be positive
    r = client.get("/api/lsst_neighbors?ra=10.0&dec=-5.0&lastmjd=0")
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
            "stamp_url_templates_by_survey": {
                "lsst": {
                    "science": "https://lsst/science?oid=__OID__&id=__IDENT__",
                    "template": "https://lsst/template?oid=__OID__&id=__IDENT__",
                    "difference": "https://lsst/difference?oid=__OID__&id=__IDENT__",
                },
                "ztf": {
                    "science": "https://ztf/science?oid=__OID__&id=__IDENT__",
                    "template": "https://ztf/template?oid=__OID__&id=__IDENT__",
                    "difference": "https://ztf/difference?oid=__OID__&id=__IDENT__",
                },
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
    # Client-side identifier sync: legacy URL templates emitted as data attrs,
    # and the picker's onchange calls the global helper (no htmx roundtrip).
    assert 'data-url-template-science="https://x/science?id=__IDENT__"' in r.text
    assert 'data-url-template-template=' in r.text
    assert 'data-url-template-difference=' in r.text
    assert "updateStampsForIdentifier" in r.text
    # Per-survey URL templates carry both __OID__ and __IDENT__ placeholders
    # so cross-survey clicks can dispatch to the matching survey's stamp
    # service (the JS pulls the matched OID off the LC chart's $lcXOid).
    assert 'data-url-template-science-lsst="https://lsst/science?oid=__OID__&amp;id=__IDENT__"' in r.text
    assert 'data-url-template-science-ztf="https://ztf/science?oid=__OID__&amp;id=__IDENT__"' in r.text
    assert 'data-url-template-template-lsst=' in r.text
    assert 'data-url-template-difference-ztf=' in r.text
    # Zoom controls — three buttons (−, reset, +) wired to window.zoomStamps.
    assert "stamps-zoom-btn" in r.text
    assert "stamps-zoom-reset" in r.text
    assert "zoomStamps(this, 1/1.25)" in r.text
    assert "zoomStamps(this, 1.25)" in r.text
    assert "zoomStamps(this, 'reset')" in r.text
    # Per-stamp download button — one per cutout type, wired to
    # window.downloadStamp; helper fetches data-stamp-url + saves as FITS.
    assert r.text.count("stamp-download-btn") == 3
    assert "downloadStamp(this)" in r.text
    assert 'aria-label="Download science FITS"' in r.text
    assert 'aria-label="Download template FITS"' in r.text
    assert 'aria-label="Download difference FITS"' in r.text
    # AVRO button — opens the per-detection AVRO record viewer modal
    # via window.openAvroModal (reads the current canvas's stamp URL
    # to derive oid + candid + survey, then htmx-ajax /htmx/avro into
    # #avro-modal).
    assert "stamps-avro-btn" in r.text
    assert "openAvroModal()" in r.text


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
            "stamp_url_templates_by_survey": {},
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


def test_avro_endpoint_renders_table_for_ztf(client, monkeypatch):
    """AVRO modal — populates from the candidate dict, sorts rows by
    name, surfaces meta in the header."""
    async def fake_avro(*, oid, candid, survey):
        assert (survey, oid, candid) == ("ztf", "ZTF17aabhbva", "12345")
        return {
            "available": True,
            "rows": [
                {"name": "drb", "value": 0.0, "value_display": "0"},
                {"name": "magpsf", "value": 20.247,
                 "value_display": "20.247"},
            ],
            "object_id": "ZTF17aabhbva",
            "publisher": "ALeRCE",
            "schemavsn": "3.3",
            "n_prv_candidates": 5,
        }

    monkeypatch.setattr(
        "src.routes.htmx.avro_service.get_avro_info", fake_avro,
    )
    r = client.get("/htmx/avro?oid=ZTF17aabhbva&candid=12345&survey_id=ztf")
    assert r.status_code == 200
    # Header carries the OID + candid + meta.
    assert "AVRO &mdash; ZTF17aabhbva" in r.text or "AVRO — ZTF17aabhbva" in r.text
    assert "candid 12345" in r.text
    assert "schema" in r.text and "3.3" in r.text
    # Rows render in a table with name + value cells.
    assert 'class="avro-row' in r.text
    assert "magpsf" in r.text
    assert "20.247" in r.text
    # Filter input + close button.
    assert 'class="avro-filter' in r.text
    # Modal slot clear-on-close pattern matches features-modal's.
    assert "document.getElementById('avro-modal').innerHTML = ''" in r.text


def test_avro_endpoint_lsst_renders_unavailable_message(client, monkeypatch):
    """LSST measurement_ids return an `available=False` payload upstream,
    and the template renders the reason string in place of the table."""
    async def fake_avro(*, oid, candid, survey):
        assert survey == "lsst"
        return {
            "available": False,
            "reason": "AVRO records are only published for ZTF; LSST does not expose them.",
            "rows": [],
        }

    monkeypatch.setattr(
        "src.routes.htmx.avro_service.get_avro_info", fake_avro,
    )
    r = client.get(
        "/htmx/avro?oid=313888627082919999&candid=999&survey_id=lsst"
    )
    assert r.status_code == 200
    assert "ZTF" in r.text
    assert 'class="avro-row' not in r.text  # no table when unavailable


def test_avro_endpoint_rejects_unknown_survey(client):
    r = client.get("/htmx/avro?oid=x&candid=1&survey_id=panstarrs")
    assert r.status_code == 400


def test_detail_includes_avro_modal_slot(client, monkeypatch):
    """The detail container has to mount #avro-modal alongside
    #features-modal; the AVRO button targets it via htmx.ajax."""
    async def fake_info(*, survey, oid):
        return {"oid": oid, "survey": survey, "ra": 180.0, "dec": -30.0}

    monkeypatch.setattr(
        "src.routes.htmx.object_info_service.get_object_info",
        fake_info,
    )
    r = client.get("/htmx/detail?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="avro-modal"' in r.text


def test_aladin_renders_host_with_coordinates(client, monkeypatch):
    async def fake_info(*, survey, oid):
        return {
            "oid": oid, "survey": survey,
            "ra": 180.125, "dec": -30.25,
            "lastmjd": 60123.456,
        }

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
    # lastmjd is stamped on the host so JS can query LSST neighbours
    # within ±2 hr of the last detection.
    assert 'data-lastmjd="60123.456"' in r.text


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
    async def fake_prob(*, survey, oid, classifier=None):
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
    async def fake_prob(*, survey, oid, classifier=None):
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
    async def fake_prob(*, survey, oid, classifier=None):
        raise RuntimeError("probability api down")

    monkeypatch.setattr(
        "src.routes.htmx.probability_service.get_probability_context",
        fake_prob,
    )
    r = client.get("/htmx/probability?oid=x&survey_id=ztf")
    assert r.status_code == 200
    assert "Upstream error" in r.text


def test_coord_residuals_renders_static_shell(client):
    """Position-residuals panel is now a static shell — `coord_residuals.js`
    derives the scatter from the live LC chart's `$lcRaw` / `$lcXRaw` and
    re-renders on `lc:visibilityChanged`. The endpoint just stamps the
    canvas + the data-lc-target hook the JS uses to find the LC chart;
    no upstream fetch happens here."""
    r = client.get("/htmx/coord_residuals?oid=ZTF21abc&survey_id=ztf")
    assert r.status_code == 200
    assert 'id="coord-canvas-ZTF21abc"' in r.text
    assert 'data-lc-target="lc-canvas-ZTF21abc"' in r.text
    # The colorbar is still server-rendered (purely decorative — the
    # mapping is the same regardless of the data).
    assert "linear-gradient" in r.text
    # No baked-in data: the scatter is built client-side.
    assert "data-coords=" not in r.text
    # Initial count placeholder reads "0 pts" until the LC populates.
    assert "0 pts" in r.text


def test_coord_residuals_rejects_unknown_survey(client):
    r = client.get("/htmx/coord_residuals?oid=x&survey_id=panstarrs")
    assert r.status_code == 400


def test_classes_select_renders_options(client):
    r = client.get(
        "/htmx/classes_select",
        params=[("classifier_classes", "SN"), ("classifier_classes", "AGN")],
    )
    assert r.status_code == 200
    assert '<option value="SN">SN</option>' in r.text
    assert '<option value="AGN">AGN</option>' in r.text
