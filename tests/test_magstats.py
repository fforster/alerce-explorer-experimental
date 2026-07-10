"""Tests for the magstats service (bulk peak diff/total magnitude via TAP).

The TAP HTTP call (`_tap_query`) is the monkeypatch seam; the ADQL builder and
the per-survey reductions are exercised directly. All offline.
"""
from __future__ import annotations

import asyncio
import math

from src.services import magstats


def _run(coro):
    return asyncio.run(coro)


# --- ADQL builder ---------------------------------------------------------


def test_build_adql_ztf_uses_magstat_fid_and_quotes_oids():
    adql = magstats._build_adql(["ZTF21abmznop", "ZTF17aabopdz"], "ztf")
    assert "FROM ztf.magstat" in adql
    assert "oid,fid,magmin,magmin_corr" in adql
    assert "'ZTF21abmznop'" in adql and "'ZTF17aabopdz'" in adql
    # Not the internal-integer-oid table.
    assert "alerce_tap.magstat" not in adql


def test_build_adql_lsst_uses_dia_object_bare_ints_diff_and_total_cols():
    adql = magstats._build_adql(["170591521964294594", "313897383716978699"], "lsst")
    assert "FROM alerce_tap.lsst_dia_object" in adql
    for b in ("u", "g", "r", "i", "z", "y"):
        assert f"{b}_psffluxmax" in adql        # difference peak flux
        assert f"{b}_sciencefluxmean" in adql    # total (science) flux
    # Bare integers, not quoted.
    assert "170591521964294594" in adql
    assert "'170591521964294594'" not in adql


def test_build_adql_empty_oids_short_circuits():
    assert magstats._build_adql([], "ztf") == ""
    assert magstats._build_adql([], "lsst") == ""


# --- ZTF reduction --------------------------------------------------------


def test_reduce_ztf_peak_diff_and_total_are_brightest_per_kind():
    # Verified real shape for ZTF17aabopdz: diff magmin g=18.64 r=18.37,
    # corrected magmin_corr g=17.15 r=16.63 → brightest diff=18.37 r, tot=16.63 r.
    rows = [
        {"oid": "ZTF17aabopdz", "fid": 1, "magmin": 18.6413, "magmin_corr": 17.145018},
        {"oid": "ZTF17aabopdz", "fid": 2, "magmin": 18.36902, "magmin_corr": 16.62895},
    ]
    out = magstats._reduce_ztf(rows)
    m = out["ZTF17aabopdz"]
    assert m["peak_diff_mag"] == 18.36902 and m["peak_diff_band"] == "r"
    assert m["peak_tot_mag"] == 16.62895 and m["peak_tot_band"] == "r"


def test_reduce_ztf_total_none_when_uncorrected():
    # corrected=False objects have magmin_corr null → total mag absent.
    rows = [{"oid": "ZTF21abmznop", "fid": 2, "magmin": 19.02663, "magmin_corr": None}]
    out = magstats._reduce_ztf(rows)
    m = out["ZTF21abmznop"]
    assert m["peak_diff_mag"] == 19.02663 and m["peak_diff_band"] == "r"
    assert m["peak_tot_mag"] is None and m["peak_tot_band"] is None


# --- LSST reduction -------------------------------------------------------


def test_reduce_lsst_diff_from_psffluxmax_total_from_sciencefluxmean():
    # Real object 313897383716978699: g diff=455.9, g total(mean)=309.0.
    rows = [
        {"oid": "313897383716978699",
         "g_psffluxmax": 455.89905, "g_sciencefluxmean": 309.02106,
         "r_psffluxmax": None, "r_sciencefluxmean": None,
         "u_psffluxmax": None, "u_sciencefluxmean": None,
         "i_psffluxmax": None, "i_sciencefluxmean": None,
         "z_psffluxmax": None, "z_sciencefluxmean": None,
         "y_psffluxmax": None, "y_sciencefluxmean": None},
    ]
    out = magstats._reduce_lsst(rows)
    m = out["313897383716978699"]
    assert math.isclose(m["peak_diff_mag"], magstats.AB_ZP_NJY - 2.5 * math.log10(455.89905))
    assert m["peak_diff_band"] == "g"
    assert math.isclose(m["peak_tot_mag"], magstats.AB_ZP_NJY - 2.5 * math.log10(309.02106))
    assert m["peak_tot_band"] == "g"


def test_reduce_lsst_picks_brightest_across_bands_and_rejects_nonpositive():
    rows = [
        {"oid": "1",
         "u_psffluxmax": -5.0, "g_psffluxmax": 100.0, "r_psffluxmax": 300.0,
         "i_psffluxmax": 0.0, "z_psffluxmax": None, "y_psffluxmax": 50.0,
         "u_sciencefluxmean": None, "g_sciencefluxmean": 800.0,
         "r_sciencefluxmean": 200.0, "i_sciencefluxmean": None,
         "z_sciencefluxmean": None, "y_sciencefluxmean": None},
    ]
    out = magstats._reduce_lsst(rows)
    m = out["1"]
    # Diff: 300 (r) brightest. Total: 800 (g) brightest.
    assert m["peak_diff_band"] == "r"
    assert m["peak_tot_band"] == "g"
    assert math.isclose(m["peak_diff_mag"], magstats.AB_ZP_NJY - 2.5 * math.log10(300.0))
    assert math.isclose(m["peak_tot_mag"], magstats.AB_ZP_NJY - 2.5 * math.log10(800.0))


def test_reduce_lsst_all_nonpositive_gives_none():
    rows = [{"oid": "1",
             "g_psffluxmax": -1.0, "r_psffluxmax": 0.0,
             "u_psffluxmax": None, "i_psffluxmax": None,
             "z_psffluxmax": None, "y_psffluxmax": None,
             "u_sciencefluxmean": None, "g_sciencefluxmean": None,
             "r_sciencefluxmean": None, "i_sciencefluxmean": None,
             "z_sciencefluxmean": None, "y_sciencefluxmean": None}]
    out = magstats._reduce_lsst(rows)
    assert out["1"]["peak_diff_mag"] is None and out["1"]["peak_diff_band"] is None
    assert out["1"]["peak_tot_mag"] is None and out["1"]["peak_tot_band"] is None


# --- TAP body parsing / VOTable-XML guard ---------------------------------


def test_parse_tap_rows_zips_columns_and_data():
    body = (
        '{"columns":[{"name":"oid"},{"name":"fid"},{"name":"magmin"}],'
        '"data":[["ZTFa",1,18.3],["ZTFa",2,18.1]]}'
    )
    rows = magstats._parse_tap_rows(body)
    assert rows == [
        {"oid": "ZTFa", "fid": 1, "magmin": 18.3},
        {"oid": "ZTFa", "fid": 2, "magmin": 18.1},
    ]


def test_parse_tap_rows_votable_xml_error_yields_empty():
    xml = (
        b'<?xml version="1.0"?><VOTABLE><RESOURCE type="results">'
        b'<INFO name="QUERY_STATUS" value="ERROR">bad column</INFO>'
        b"</RESOURCE></VOTABLE>"
    )
    assert magstats._parse_tap_rows(xml) == []


def test_parse_tap_rows_valid_json_wrong_shape_yields_empty():
    assert magstats._parse_tap_rows('{"unexpected": true}') == []


def test_parse_tap_rows_lsst_bigint_oid_survives_as_string():
    body = (
        '{"columns":[{"name":"oid"},{"name":"g_psffluxmax"}],'
        '"data":[[313897383716978699,455.9]]}'
    )
    rows = magstats._parse_tap_rows(body)
    # safe_json_loads stringifies the >=16-digit int so it matches page oids.
    assert rows[0]["oid"] == "313897383716978699"


# --- fetch_magstats_bulk end-to-end (monkeypatched _tap_query) ------------


def test_fetch_bulk_empty_oids_skips_query(monkeypatch):
    called = False

    async def _never(adql):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(magstats, "_tap_query", _never)
    out = _run(magstats.fetch_magstats_bulk([], "ztf"))
    assert out == {}
    assert called is False


def test_fetch_bulk_ztf_reduces(monkeypatch):
    async def _rows(adql):
        return [
            {"oid": "Z", "fid": 1, "magmin": 20.0, "magmin_corr": 18.0},
            {"oid": "Z", "fid": 2, "magmin": 19.0, "magmin_corr": 17.5},
        ]

    monkeypatch.setattr(magstats, "_tap_query", _rows)
    out = _run(magstats.fetch_magstats_bulk(["Z"], "ztf"))
    assert out["Z"]["peak_diff_mag"] == 19.0 and out["Z"]["peak_diff_band"] == "r"
    assert out["Z"]["peak_tot_mag"] == 17.5 and out["Z"]["peak_tot_band"] == "r"


def test_fetch_bulk_returns_empty_on_query_error(monkeypatch):
    async def _boom(adql):
        raise RuntimeError("network")

    monkeypatch.setattr(magstats, "_tap_query", _boom)
    out = _run(magstats.fetch_magstats_bulk(["Z"], "ztf"))
    assert out == {}


def test_fetch_bulk_returns_empty_when_query_yields_no_rows(monkeypatch):
    # Simulates the VOTable-XML error body path: _tap_query already degraded to [].
    async def _empty(adql):
        return []

    monkeypatch.setattr(magstats, "_tap_query", _empty)
    out = _run(magstats.fetch_magstats_bulk(["Z"], "ztf"))
    assert out == {}
