"""Tests for the light-curve bundle cache (services/lc_cache.py).

The cache exists so that picking the GP overlay doesn't re-download the light
curve the detail view already fetched on load. The properties that matter are
therefore: one upstream fetch per (survey, oid), a cached None (no cross-survey
counterpart) counts as a hit, and concurrent callers coalesce.
"""
from __future__ import annotations

import asyncio

import pytest

from src.services import lc_cache


def _run(coro):
    return asyncio.run(coro)


def test_second_call_hits_the_cache_and_does_not_refetch():
    calls = []

    async def fetch():
        calls.append(1)
        return {"bands": [1, 2, 3]}

    async def go():
        a = await lc_cache.get_or_fetch("lc_fp", "ztf", "X1", fetch)
        b = await lc_cache.get_or_fetch("lc_fp", "ztf", "X1", fetch)
        return a, b

    a, b = _run(go())
    assert a == b == {"bands": [1, 2, 3]}
    assert len(calls) == 1          # the whole point


def test_none_is_cached_so_no_counterpart_is_not_re_looked_up():
    """The xsurvey bundle is legitimately None when there is no counterpart.
    Caching that is what stops the GP path redoing a 3-call pipeline to
    rediscover it."""
    calls = []

    async def fetch():
        calls.append(1)
        return None

    async def go():
        a = await lc_cache.get_or_fetch("lc_xsurvey", "ztf", "X2", fetch)
        b = await lc_cache.get_or_fetch("lc_xsurvey", "ztf", "X2", fetch)
        return a, b

    assert _run(go()) == (None, None)
    assert len(calls) == 1


def test_reads_are_isolated_copies():
    """Callers mutate these bundles (the GP path restamps keys); a shared
    mutable payload would leak across requests."""
    async def fetch():
        return {"bands": [{"flux": [1.0]}]}

    async def go():
        first = await lc_cache.get_or_fetch("lc_fp", "ztf", "X3", fetch)
        first["bands"][0]["flux"].append(999.0)
        first["injected"] = True
        return await lc_cache.get_or_fetch("lc_fp", "ztf", "X3", fetch)

    second = _run(go())
    assert second == {"bands": [{"flux": [1.0]}]}
    assert "injected" not in second


def test_distinct_keys_do_not_collide():
    async def mk(tag):
        async def fetch():
            return {"tag": tag}
        return fetch

    async def go():
        out = {}
        for name, survey, oid, tag in (
            ("lc_fp", "ztf", "A", "fp-ztf-A"),
            ("lc_fp", "lsst", "A", "fp-lsst-A"),
            ("lc_xsurvey", "ztf", "A", "xs-ztf-A"),
            ("lc_fp", "ztf", "B", "fp-ztf-B"),
        ):
            out[tag] = await lc_cache.get_or_fetch(
                name, survey, oid, await mk(tag))
        return out

    out = _run(go())
    assert {k: v["tag"] for k, v in out.items()} == {t: t for t in out}


def test_expired_entry_is_refetched(monkeypatch):
    calls = []

    async def fetch():
        calls.append(1)
        return {"n": len(calls)}

    async def go():
        first = await lc_cache.get_or_fetch("lc_fp", "ztf", "X4", fetch)
        monkeypatch.setattr(lc_cache, "TTL_SECONDS", -1.0)   # everything stale
        second = await lc_cache.get_or_fetch("lc_fp", "ztf", "X4", fetch)
        return first, second

    first, second = _run(go())
    assert (first["n"], second["n"]) == (1, 2)
    assert len(calls) == 2


def test_concurrent_callers_coalesce_into_one_fetch():
    calls = []

    async def slow_fetch():
        calls.append(1)
        await asyncio.sleep(0.05)
        return {"ok": True}

    async def go():
        return await asyncio.gather(*[
            lc_cache.get_or_fetch("lc_fp", "ztf", "X5", slow_fetch)
            for _ in range(5)
        ])

    results = _run(go())
    assert all(r == {"ok": True} for r in results)
    assert len(calls) == 1          # four waiters, one upstream fetch


def test_a_failed_fetch_is_not_cached_and_releases_waiters():
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("upstream boom")
        return {"ok": True}

    async def go():
        with pytest.raises(RuntimeError):
            await lc_cache.get_or_fetch("lc_fp", "ztf", "X6", flaky)
        # the marker must have been released, and the failure not cached
        assert lc_cache.stats()["inflight"] == 0
        return await lc_cache.get_or_fetch("lc_fp", "ztf", "X6", flaky)

    assert _run(go()) == {"ok": True}
    assert len(calls) == 2


def test_entries_are_capped_so_the_cache_cannot_grow_unbounded(monkeypatch):
    """These payloads are megabytes and production runs on a 1 GiB box, so the
    cap is a memory bound, not a tuning knob."""
    monkeypatch.setattr(lc_cache, "MAX_ENTRIES", 3)

    async def go():
        for i in range(10):
            async def fetch(i=i):
                return {"i": i}
            await lc_cache.get_or_fetch("lc_fp", "ztf", f"O{i}", fetch)
        return lc_cache.stats()

    assert _run(go())["entries"] == 3


def test_clear_drops_everything():
    async def fetch():
        return {"ok": True}

    async def go():
        await lc_cache.get_or_fetch("lc_fp", "ztf", "X7", fetch)
        assert lc_cache.stats()["entries"] == 1
        lc_cache.clear()
        return lc_cache.stats()

    s = _run(go())
    assert (s["entries"], s["inflight"], s["hits"], s["misses"]) == (0, 0, 0, 0)
