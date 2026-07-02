"""Tests for the bulk CDS/NED crossmatch service, its TTL cache, and the
prefetch / overlay / crossmatch-fold endpoints. All offline — the blocking
astroquery/pyvo calls and bulk_all are monkeypatched, nothing hits the network.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from src.app import app
from src.services import xmatch
from src.services import xmatch_cache


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_cache():
    xmatch_cache.clear()
    yield
    xmatch_cache.clear()


# --- normalizers ------------------------------------------------------------

def test_norm_simbad_uses_matched_coords():
    out = xmatch._norm_simbad({
        "ra2": 10.5, "dec2": -20.1, "redshift": 0.123, "redshift_err": 0.001,
        "main_type": "Galaxy", "main_id": "NGC 1", "angDist": 1.4,
    })
    assert out["cat_name"] == "Simbad"
    assert out["ra"] == 10.5 and out["dec"] == -20.1
    assert out["z"] == 0.123 and out["type"] == "Galaxy"
    assert out["sep"] == 1.4


def test_norm_sdss_keeps_galaxies_only():
    galaxy = xmatch._norm_sdss({"class": 3, "RA_ICRS": 1.0, "DE_ICRS": 2.0,
                                "zsp": 0.2, "e_zsp": 1e-4, "zph": 0.19,
                                "objID": "123", "angDist": 0.7})
    assert galaxy is not None and galaxy["z"] == 0.2 and galaxy["photoz"] == 0.19
    assert xmatch._norm_sdss({"class": 6, "RA_ICRS": 1.0, "DE_ICRS": 2.0}) is None


def test_norm_desi_zwarn_and_star_filters():
    ok = xmatch._norm_desi({"ZWARN": 0, "RA_ICRS": 1.0, "DE_ICRS": 2.0,
                            "z": 0.3, "e_z": 1e-4, "OType": "GALAXY", "angDist": 1})
    assert ok is not None and ok["z"] == 0.3
    assert xmatch._norm_desi({"ZWARN": 4, "z": 0.3}) is None
    assert xmatch._norm_desi({"ZWARN": 0, "OType": "STAR", "RA_ICRS": 1, "DE_ICRS": 2}) is None


def test_norm_vizier_cz_conversion_6dfgs():
    cfg = xmatch.VIZIER_Z_CATALOGS["6dFGS"]
    out = xmatch._norm_vizier({"q_cz": 5, "_RAJ2000": 10.0, "_DEJ2000": 20.0,
                               "cz": 30000.0, "e_cz": 150.0, "angDist": 1.0}, cfg)
    assert out is not None
    assert out["z"] == pytest.approx(30000.0 / xmatch._C_KMS)
    assert out["z_err"] == pytest.approx(150.0 / xmatch._C_KMS)
    # low quality flag is filtered out
    assert xmatch._norm_vizier({"q_cz": 1, "_RAJ2000": 10, "_DEJ2000": 20, "cz": 30000}, cfg) is None


def test_norm_vizier_glade_spectroscopic_only():
    cfg = xmatch.VIZIER_Z_CATALOGS["GLADE"]
    base = {"RAJ2000": 10.0, "DEJ2000": 20.0, "z": 0.05, "angDist": 1.0}
    assert xmatch._norm_vizier({**base, "Flag2": "2", "Flag1": "G"}, cfg) is not None
    assert xmatch._norm_vizier({**base, "Flag2": "1", "Flag1": "G"}, cfg) is None  # photometric
    assert xmatch._norm_vizier({**base, "Flag2": "2", "Flag1": "C"}, cfg) is None  # cluster


def test_cell_masks_and_nan():
    import numpy as np
    assert xmatch._cell(np.ma.masked) is None
    assert xmatch._cell(float("nan")) is None
    assert xmatch._cell(b"abc") == "abc"
    assert xmatch._cell(np.float64(1.5)) == 1.5


# --- _build_object_record ---------------------------------------------------

def test_build_record_summary_and_overlay():
    rec = xmatch._build_object_record({
        "Simbad": [{"cat_name": "Simbad", "ra": 1.0, "dec": 2.0, "z": 0.052,
                    "z_err": None, "type": "Galaxy", "name": "G", "sep": 2.0}],
        "DESI": [{"cat_name": "DESI", "ra": 1.0, "dec": 2.0, "z": 0.051,
                  "z_err": 1e-4, "type": "GALAXY", "name": "d", "sep": 0.8}],
    })
    # nearest spec-z wins (DESI at 0.8" beats Simbad at 2.0")
    assert rec["best_z"]["source"] == "DESI"
    assert rec["simbad_type"] == "Galaxy"
    assert rec["counts"] == {"Simbad": 1, "DESI": 1}
    # both z-bearing catalogs get a sky marker (DESI + Simbad)
    assert sorted(o["cat_id"] for o in rec["overlay"]) == ["desi", "simbad"]
    desi_mark = next(o for o in rec["overlay"] if o["cat_id"] == "desi")
    assert desi_mark["color"] and desi_mark["cat_name"] == "DESI"


def test_build_record_ned_redshift_becomes_overlay_marker():
    # NED matches with a redshift get a sky marker; NED rows without a redshift
    # (and Simbad) do not. (Regression: ZTF25abioriw's NED host z wasn't shown.)
    rec = xmatch._build_object_record({
        "NED": [
            {"cat_name": "NED", "ra": 1.0, "dec": 2.0, "z": 0.026, "z_err": None,
             "type": "G", "name": "host", "sep": 11.0},
            {"cat_name": "NED", "ra": 1.1, "dec": 2.1, "z": None, "z_err": None,
             "type": "", "name": "no-z", "sep": 22.0},
        ],
    })
    marks = [(o["cat_id"], o["name"]) for o in rec["overlay"]]
    assert marks == [("ned", "host")]          # NED host only; the z=None NED row is excluded


def test_ned_supernova_is_not_treated_as_host():
    # A NED SN entry sits at the transient and carries the event's own z — it
    # must not become the "host galaxy". The nearby galaxy is the real host.
    rec = xmatch._build_object_record({
        "NED": [
            {"cat_name": "NED", "ra": 1.0, "dec": 2.0, "z": 0.043, "z_err": None,
             "type": "SN", "name": "SN 2025x", "sep": 0.04},
            {"cat_name": "NED", "ra": 1.1, "dec": 2.1, "z": 0.026, "z_err": None,
             "type": "G", "name": "WISEA gal", "sep": 11.0},
        ],
    })
    assert rec["best_z"]["z"] == 0.026                  # the galaxy, not the SN
    assert [o["name"] for o in rec["overlay"]] == ["WISEA gal"]   # SN gets no host marker
    assert xmatch._is_transient_type("SN") and not xmatch._is_transient_type("SNR")


def test_stellar_agn_matches_capped_at_tight_radius():
    # Simbad (wide 36" search) can route a distant field star into "stellar";
    # a stellar/AGN match beyond 3" is dropped, but a host beyond 3" is kept.
    rec = xmatch._build_object_record({
        "Simbad": [
            {"cat_name": "Simbad", "category": "stellar", "ra": 1.0, "dec": 2.0,
             "z": None, "type": "Star", "name": "near", "sep": 1.5, "fields": [], "signals": {}},
            {"cat_name": "Simbad", "category": "stellar", "ra": 1.0, "dec": 2.0,
             "z": None, "type": "Star", "name": "far", "sep": 30.0, "fields": [], "signals": {}},
            {"cat_name": "Simbad", "category": "host", "ra": 1.0, "dec": 2.0,
             "z": 0.04, "type": "Galaxy", "name": "gal", "sep": 25.0, "fields": [], "signals": {}},
        ],
    })
    names = [m["name"] for m in rec["matches"]]
    assert "near" in names and "far" not in names      # distant star dropped
    assert "gal" in names                              # distant host galaxy kept


def test_build_record_host_without_redshift_has_no_marker():
    # A host-category match with no redshift contributes no sky marker.
    rec = xmatch._build_object_record({
        "Simbad": [{"cat_name": "Simbad", "ra": 1.0, "dec": 2.0, "z": None,
                    "z_err": None, "type": "Galaxy", "name": "g", "sep": 1.0}],
    })
    assert rec["best_z"] is None
    assert rec["overlay"] == []
    assert rec["counts"] == {"Simbad": 1}


def test_build_record_stellar_and_agn_markers_need_no_redshift():
    # Stellar / AGN counterparts are point sources at the position → they get a
    # marker even without a redshift; ordering is stars → AGN → host.
    rec = xmatch._build_object_record({
        "Gaia DR3": [{"cat_name": "Gaia DR3", "category": "stellar", "ra": 1.0, "dec": 2.0,
                      "sep": 0.5, "name": "G", "type": "star", "z": None, "fields": [],
                      "signals": {"parallax": 0.8, "parallax_snr": 12.0, "dist_pc": 1250.0}}],
        "Milliquas": [{"cat_name": "Milliquas", "category": "agn", "ra": 1.0, "dec": 2.0,
                       "sep": 0.1, "name": "Q", "type": "QSO", "z": 1.2, "fields": [],
                       "signals": {"agn_class": "QSO", "radio": True, "xray": True, "z": 1.2}}],
    })
    assert [(o["category"], o["cat_id"]) for o in rec["overlay"]] == [("stellar", "gaia_dr3"), ("agn", "milliquas")]
    assert rec["overlay"][0]["color"] == xmatch.CATEGORY_COLOR["stellar"]
    assert rec["overlay"][1]["color"] == xmatch.CATEGORY_COLOR["agn"]
    # ordered stars first, then AGN
    assert [m["cat_name"] for m in rec["matches"]] == ["Gaia DR3", "Milliquas"]
    assert "Galactic candidate" in rec["hints"]["stellar"]
    assert "AGN/QSO" in rec["hints"]["agn"]


def test_signal_extractors():
    # Milliquas Type string encodes class + radio/X-ray; Gaia RPlx is the S/N.
    assert xmatch._sig_milliquas({"Type": "QRX", "z": "1.2"}) == {
        "agn_class": "QSO", "radio": True, "xray": True, "z": 1.2, "type_label": "QSO"}
    g = xmatch._sig_gaia({"Plx": "5.0", "e_Plx": "0.5", "RPlx": "10.0", "VarFlag": "VARIABLE"})
    assert g["parallax_snr"] == 10.0 and g["gaia_variable"] is True
    # AGN + galaxies are explicit; every other Simbad type (variable stars,
    # nebulae, …) defaults to stellar — not host.
    assert xmatch._simbad_category("RRLyrae") == "stellar"
    assert xmatch._simbad_category("Mira") == "stellar"          # was wrongly "host"
    assert xmatch._simbad_category("Cepheid") == "stellar"
    assert xmatch._simbad_category("Seyfert_1") == "agn"
    assert xmatch._simbad_category("Galaxy") == "host"
    assert xmatch._simbad_category("Emission-line Galaxy") == "host"


# --- bulk_all (monkeypatched cores) -----------------------------------------

def test_bulk_all_regroups_and_tolerates_failure(monkeypatch):
    def fake_simbad(cat, positions):
        if cat != "Simbad":          # SDSS / DESI return nothing in this test
            return {}
        return {"A": [{"cat_name": "Simbad", "ra": 1.0, "dec": 2.0, "z": 0.1,
                       "z_err": None, "type": "Galaxy", "name": "G", "sep": 1.0}]}

    def fake_vizier(cat_id, positions):
        if cat_id == "6dFGS":
            return {"A": [{"cat_name": "6dFGS", "ra": 1.0, "dec": 2.0, "z": 0.099,
                           "z_err": None, "type": "", "name": "z", "sep": 0.5}]}
        return {}

    def boom_ned(positions):
        raise RuntimeError("NED down")

    monkeypatch.setattr(xmatch, "_bulk_xmatch_sync", fake_simbad)
    monkeypatch.setattr(xmatch, "_bulk_xmatch_vizier_sync", fake_vizier)
    monkeypatch.setattr(xmatch, "_bulk_ned_tap_sync", boom_ned)

    out = run(xmatch.bulk_all([("A", 1.0, 2.0)]))
    assert set(out) == {"A"}                      # NED failure didn't sink the batch
    assert out["A"]["counts"] == {"Simbad": 1, "6dFGS": 1}
    assert out["A"]["best_z"]["source"] == "6dFGS"   # nearest (0.5")


def test_bulk_all_empty_positions():
    assert run(xmatch.bulk_all([])) == {}


# --- cache ------------------------------------------------------------------

def _fake_bulk(records):
    async def _inner(positions):
        return {oid: records[oid] for oid, _, _ in positions if oid in records}
    return _inner


def test_cache_prefetch_dedup_and_empty(monkeypatch):
    rec = {"by_catalog": {}, "best_z": {"z": 0.1, "z_err": None, "source": "DESI", "sep": 1.0},
           "simbad_type": None, "counts": {"DESI": 1}, "overlay": []}
    monkeypatch.setattr(xmatch, "bulk_all", _fake_bulk({"A": rec}))

    n = run(xmatch_cache.prefetch([("A", 1.0, 2.0), ("B", 3.0, 4.0)]))
    assert n == 2
    assert run(xmatch_cache.get("A"))["best_z"]["z"] == 0.1
    # unmatched oid still cached as the empty record (so it won't re-query)
    assert run(xmatch_cache.get("B")) == xmatch_cache.EMPTY_RECORD
    # everything cached now → no new fetches
    assert run(xmatch_cache.prefetch([("A", 1.0, 2.0), ("B", 3.0, 4.0)])) == 0


def test_cache_ttl_expiry(monkeypatch):
    rec = {"by_catalog": {}, "best_z": None, "simbad_type": None, "counts": {"DESI": 1}, "overlay": []}
    monkeypatch.setattr(xmatch, "bulk_all", _fake_bulk({"A": rec}))
    monkeypatch.setattr(xmatch_cache, "TTL_SECONDS", -1.0)   # everything immediately stale
    run(xmatch_cache.prefetch([("A", 1.0, 2.0)]))
    assert run(xmatch_cache.get("A")) is None


def test_get_or_compute_uses_cache(monkeypatch):
    rec = {"by_catalog": {}, "best_z": None, "simbad_type": None, "counts": {"X": 1}, "overlay": []}
    calls = {"n": 0}

    async def counting_bulk(positions):
        calls["n"] += 1
        return {oid: rec for oid, _, _ in positions}

    monkeypatch.setattr(xmatch, "bulk_all", counting_bulk)
    first = run(xmatch_cache.get_or_compute("A", 1.0, 2.0))
    second = run(xmatch_cache.get_or_compute("A", 1.0, 2.0))
    assert first["counts"] == {"X": 1} and second["counts"] == {"X": 1}
    assert calls["n"] == 1                         # second call served from cache


def test_get_or_compute_no_coords_returns_empty():
    assert run(xmatch_cache.get_or_compute("A", None, None)) == xmatch_cache.EMPTY_RECORD


def test_prefetch_cancellation_releases_inflight(monkeypatch):
    """A cancelled prefetch (client closed the tab mid-fetch → CancelledError,
    a BaseException the `except Exception` can't catch) must still release the
    in-flight markers. Otherwise the oids are stranded: every later prefetch
    skips them and get_or_compute waiters block, so they'd return EMPTY_RECORD
    forever. Guards the `finally` in prefetch()."""
    async def cancelled_bulk(positions):
        raise asyncio.CancelledError()

    monkeypatch.setattr(xmatch, "bulk_all", cancelled_bulk)
    with pytest.raises(asyncio.CancelledError):
        run(xmatch_cache.prefetch([("A", 1.0, 2.0), ("B", 3.0, 4.0)]))

    # No stranded in-flight markers, and nothing was cached (fetch never ran).
    assert xmatch_cache.stats()["inflight"] == 0
    assert run(xmatch_cache.get("A")) is None
    assert run(xmatch_cache.get("B")) is None

    # The oids are re-fetchable — not poisoned into permanent EMPTY_RECORD.
    rec = {"by_catalog": {}, "best_z": None, "simbad_type": None,
           "counts": {"X": 1}, "overlay": []}
    monkeypatch.setattr(xmatch, "bulk_all", _fake_bulk({"A": rec}))
    got = run(xmatch_cache.get_or_compute("A", 1.0, 2.0))
    assert got["counts"] == {"X": 1}


# --- endpoints --------------------------------------------------------------

def test_prefetch_endpoint_invokes_cache(client, monkeypatch):
    captured = {}

    async def fake_prefetch(positions):
        captured["positions"] = positions
        return len(positions)

    monkeypatch.setattr("src.routes.htmx.xmatch_cache_service.prefetch", fake_prefetch)
    resp = client.post("/htmx/xmatch_prefetch",
                       json={"positions": [{"oid": "A", "ra": 1.0, "dec": 2.0},
                                           {"oid": "B", "ra": 3.0, "dec": 4.0}]})
    assert resp.status_code == 204
    assert captured["positions"] == [("A", 1.0, 2.0), ("B", 3.0, 4.0)]


def test_prefetch_endpoint_bad_body_is_204(client):
    assert client.post("/htmx/xmatch_prefetch", content=b"not json").status_code == 204


def test_overlay_endpoint_from_cache(client, monkeypatch):
    rec = {"by_catalog": {}, "best_z": None, "simbad_type": None, "counts": {"DESI": 1},
           "overlay": [{"cat_id": "desi", "cat_name": "DESI", "ra": 1.0, "dec": 2.0,
                        "z": 0.1, "z_err": None, "type": "GALAXY", "sep": 1.0,
                        "color": "#ff7f0e", "size": 14}]}

    async def fake_get(oid):
        return rec

    monkeypatch.setattr("src.routes.rest.xmatch_cache_service.get", fake_get)
    resp = client.get("/api/xmatch_overlay", params={"oid": "A", "survey_id": "lsst"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["oid"] == "A"
    assert body["overlay"][0]["cat_id"] == "desi" and body["overlay"][0]["z"] == 0.1


def test_crossmatch_route_folds_xmatch_summary(client, monkeypatch):
    async def fake_info(*, survey, oid):
        return {"ra": 10.0, "dec": 20.0}

    async def fake_catshtm(*, ra, dec, radius=30.0):
        return {"available": True, "ra": ra, "dec": dec, "radius": radius,
                "catalogs": [], "n_catalogs": 0, "error": None}

    async def fake_xm(oid, ra, dec):
        return xmatch._build_object_record({
            "Gaia DR3": [{"cat_name": "Gaia DR3", "category": "stellar", "ra": 10.0, "dec": 20.0,
                          "sep": 0.5, "name": "Gaia X", "type": "star", "z": None,
                          "fields": [{"label": "Plx", "value": 5.0, "unit": "mas"}],
                          "signals": {"parallax": 5.0, "parallax_snr": 12.0, "dist_pc": 200.0}}],
            "DESI": [{"cat_name": "DESI", "ra": 10.0, "dec": 20.0, "z": 0.05, "z_err": None,
                      "type": "GALAXY", "name": "d", "sep": 0.8}],
        })

    monkeypatch.setattr("src.routes.htmx.object_info_service.get_object_info", fake_info)
    monkeypatch.setattr("src.routes.htmx.crossmatch_service.get_crossmatch", fake_catshtm)
    monkeypatch.setattr("src.routes.htmx.xmatch_cache_service.get_or_compute", fake_xm)

    resp = client.get("/htmx/crossmatch", params={"oid": "A", "survey_id": "lsst"})
    assert resp.status_code == 200
    html = resp.text
    assert "Crossmatch &mdash; CDS / NED" in html or "Crossmatch — CDS / NED" in html
    assert "Galactic candidate" in html      # stellar hint banner
    assert "Gaia DR3" in html and "DESI" in html   # ordered match column
    assert "Plx" in html                     # catalog-specific field rendered
