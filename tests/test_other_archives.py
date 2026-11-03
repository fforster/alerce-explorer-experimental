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


# --- CDS mirror awareness ---------------------------------------------------

def _mirrors(monkeypatch, up: set[str]):
    from src.services import cds_mirrors

    async def fake(ep):
        return ep.label in up

    cds_mirrors.clear()
    monkeypatch.setattr(cds_mirrors, "_probe", fake)


def _link(links, name):
    return next(l["url"] for l in links if l["name"] == name)


def test_cds_links_use_the_primary_before_anything_is_known(monkeypatch):
    """Cold cache → CDS, which is correct whenever CDS is up and costs no probe
    on the render path."""
    _mirrors(monkeypatch, {"CDS Strasbourg"})
    links = build_archive_links(ra=185.7, dec=15.8)
    assert "simbad.u-strasbg.fr" in _link(links, "SIMBAD")
    assert "vizier.cds.unistra.fr" in _link(links, "VizieR")


def test_cds_links_follow_a_live_mirror_once_the_verdict_is_in(monkeypatch):
    """After a crossmatch has warmed the health cache, the user's links point
    somewhere that actually answers."""
    import asyncio
    from src.services import cds_mirrors

    _mirrors(monkeypatch, {"CfA Harvard", "IDIA South Africa"})
    asyncio.run(cds_mirrors.resolve_many(["simbad_web", "vizier_web"]))

    links = build_archive_links(ra=185.7, dec=15.8)
    assert "simbad.cfa.harvard.edu" in _link(links, "SIMBAD")
    assert "vizier.idia.ac.za" in _link(links, "VizieR")


def test_mirror_links_keep_the_query_shape(monkeypatch):
    """The mirrors serve the same CGI paths, so only the host may change —
    verified live: /simbad/sim-coo and /viz-bin/VizieR-4 answer on every one."""
    import asyncio
    from src.services import cds_mirrors

    _mirrors(monkeypatch, {"CfA Harvard", "IDIA South Africa"})
    asyncio.run(cds_mirrors.resolve_many(["simbad_web", "vizier_web"]))
    links = build_archive_links(ra=185.7, dec=15.8)

    simbad, vizier = _link(links, "SIMBAD"), _link(links, "VizieR")
    assert "/simbad/sim-coo?Coord=" in simbad and "Radius=10" in simbad
    assert "/viz-bin/VizieR-4?-c=" in vizier and "-c.rs=10" in vizier


def test_non_cds_archive_links_are_untouched_by_a_cds_outage(monkeypatch):
    """Only the two CDS links are mirror-aware; the rest must not move."""
    _mirrors(monkeypatch, set())
    links = build_archive_links(ra=185.7, dec=15.8)
    assert "ps1images.stsci.edu" in _link(links, "PanSTARRS")
    assert "skyserver.sdss.org" in _link(links, "SDSS DR19")
    assert "wis-tns.org" in _link(links, "TNS")
