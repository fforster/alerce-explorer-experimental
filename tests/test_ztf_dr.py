"""Tests for the ZTF DR shaping: fielddchunk flattening, band grouping,
filterid→band mapping, and the Diff/Sci contract (flux=null for DR points).
"""
from __future__ import annotations

import math

from src.services.ztf_dr import shape_dr


def _entry(filterid, hmjd, mag, magerr=None):
    return {
        "_id": f"dummy-{filterid}",
        "filterid": filterid,
        "fieldid": 100,
        "rcid": 0,
        "nepochs": len(hmjd),
        "objra": 0.0,
        "objdec": 0.0,
        "hmjd": list(hmjd),
        "mag": list(mag),
        "magerr": list(magerr) if magerr is not None else [],
    }


def test_shape_dr_empty_for_empty_or_bad_input():
    assert shape_dr([]) == {"bands": [], "n_pts": 0}
    assert shape_dr({"not": "a list"}) == {"bands": [], "n_pts": 0}


def test_shape_dr_groups_by_band_across_field_matches():
    raw = [
        _entry(1, [59000.0, 59010.0], [20.0, 20.1], [0.05, 0.06]),
        _entry(2, [59001.0], [19.0], [0.04]),
        _entry(1, [59005.0], [20.2], [0.07]),  # second g match merged in
    ]
    out = shape_dr(raw)
    names = [b["name"] for b in out["bands"]]
    assert names == ["g", "r"]
    assert out["n_pts"] == 4
    g_pts = out["bands"][0]["points"]
    # Merged + sorted by mjd
    assert [p["mjd"] for p in g_pts] == [59000.0, 59005.0, 59010.0]


def test_shape_dr_mag_to_njy_and_diff_is_null():
    raw = [_entry(2, [59000.0], [19.0], [0.05])]
    out = shape_dr(raw)
    pt = out["bands"][0]["points"][0]
    # Science-only photometry: diff flux must be null so Diff mode filters it out.
    assert pt["flux"] is None
    assert pt["e_flux"] is None
    # AB ZP 31.4: mag 19 → 10^((31.4-19)/2.5) nJy
    assert math.isclose(pt["sci_flux"], 10 ** ((31.4 - 19.0) / 2.5), rel_tol=1e-9)
    assert pt["e_sci_flux"] is not None and pt["e_sci_flux"] > 0
    assert pt["has_stamp"] is False
    assert pt["identifier"] is None


def test_shape_dr_drops_unknown_filterid():
    # filterid=9 is not in the {1,2,3} map; those entries are silently ignored.
    raw = [_entry(9, [59000.0], [20.0], [0.05])]
    out = shape_dr(raw)
    assert out == {"bands": [], "n_pts": 0}


def test_shape_dr_handles_missing_magerr_array():
    raw = [{"filterid": 1, "hmjd": [59000.0], "mag": [20.0]}]  # no magerr key at all
    out = shape_dr(raw)
    pt = out["bands"][0]["points"][0]
    assert pt["e_sci_flux"] is None
    assert math.isclose(pt["sci_flux"], 10 ** ((31.4 - 20.0) / 2.5), rel_tol=1e-9)
