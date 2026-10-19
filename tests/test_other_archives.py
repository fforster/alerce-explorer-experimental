"""External archive URL builder tests."""
from __future__ import annotations

from src.services.other_archives import build_archive_links


def test_without_coords_returns_empty():
    assert build_archive_links(ra=None, dec=None) == []
    assert build_archive_links(ra=180.0, dec=None) == []
    assert build_archive_links(ra=None, dec=-30.0) == []


def test_with_coords_emits_full_set():
    links = build_archive_links(ra=180.0, dec=-30.0)
    names = [link["name"] for link in links]
    # Spot-check a handful of expected archives
    for expected in [
        "DESI Legacy Survey DR11", "NED", "PanSTARRS", "SDSS DR19",
        "SIMBAD", "TNS", "VizieR", "VSX",
    ]:
        assert expected in names


def test_removed_alerce_entries_not_present():
    """ALeRCE Explorer + Finding Chart were dropped — guard against
    accidentally re-adding them with broken target services."""
    links = build_archive_links(ra=180.0, dec=-30.0)
    names = [link["name"] for link in links]
    assert "ALeRCE Explorer" not in names
    assert "ALeRCE Finding Chart" not in names


def test_ra_dec_propagated_to_link_urls():
    """Coords show up encoded in the conesearch URLs (spot-check SIMBAD/TNS)."""
    links = build_archive_links(ra=180.0, dec=-30.0)
    by_name = {link["name"]: link["url"] for link in links}
    assert "180.0%20-30.0" in by_name["SIMBAD"]
    assert "ra=180.0" in by_name["TNS"] and "decl=-30.0" in by_name["TNS"]


def test_legacy_survey_dr11_url_format():
    """Exact URL: the stable viewer, pinned to the released `ls-dr11` layer.

    Two separate drifts were corrected here — the layer was `ls-dr11-early-v2`
    (the pre-release layer) and the path was `/viewer-dev/` (the development
    viewer, not the public one). Nothing asserted either, so both were
    invisible; hence the full-string comparison over a substring check.
    """
    links = build_archive_links(ra=120.55252310424017, dec=-4.239017874612488)
    url = {link["name"]: link["url"] for link in links}["DESI Legacy Survey DR11"]
    assert url == (
        "https://www.legacysurvey.org/viewer/"
        "?ra=120.55252310424017&dec=-4.239017874612488&layer=ls-dr11&zoom=15"
    )
