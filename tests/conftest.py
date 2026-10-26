"""Shared pytest fixtures.

`lc_cache` is process-global module state, so without this the light-curve
bundle a test fetches would leak into the next test that uses the same
`(survey, oid)` — several tests do, with different monkeypatched upstreams, so
the suite would pass or fail depending on the order it ran in. Clearing it
per-test keeps each one hermetic.
"""
from __future__ import annotations

import pytest

from src.services import lc_cache


@pytest.fixture(autouse=True)
def _clear_lc_cache():
    lc_cache.clear()
    yield
    lc_cache.clear()
