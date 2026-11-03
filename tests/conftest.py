"""Shared pytest fixtures.

`lc_cache` is process-global module state, so without this the light-curve
bundle a test fetches would leak into the next test that uses the same
`(survey, oid)` — several tests do, with different monkeypatched upstreams, so
the suite would pass or fail depending on the order it ran in. Clearing it
per-test keeps each one hermetic.

`cds_mirrors` is the same kind of global, with a sharper edge: its health cache
is populated by a **real network probe**. Left alone, `bulk_all` would probe
CDS from the unit suite — slow, and the result would depend on whether CDS
happens to be up, which is exactly the thing under test. The autouse fixture
below pins every endpoint "up" (so the primary is always chosen and existing
behaviour is unchanged) and guarantees no test reaches the network. Tests that
care about an outage override `_probe` themselves — see `tests/test_cds_mirrors.py`.
"""
from __future__ import annotations

import pytest

from src.services import cds_mirrors, lc_cache


@pytest.fixture(autouse=True)
def _clear_lc_cache():
    lc_cache.clear()
    yield
    lc_cache.clear()


@pytest.fixture(autouse=True)
def _cds_mirrors_all_up(monkeypatch):
    """Every CDS endpoint healthy, with no network access.

    Patched at `_probe`, not at `resolve`, so the caching, coalescing and
    preference-order logic all still runs for real — only the socket is faked.
    """
    async def _fake_probe(ep):
        return True

    cds_mirrors.clear()
    monkeypatch.setattr(cds_mirrors, "_probe", _fake_probe)
    yield
    cds_mirrors.clear()
