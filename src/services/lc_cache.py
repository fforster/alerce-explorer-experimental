"""Short-TTL in-memory cache for the per-object light-curve bundles.

**Why this exists.** The detail view fires `/htmx/lc_fp` and `/htmx/lc_xsurvey`
on load (`hx-trigger="load"`). Picking the GP overlay afterwards calls
`get_lc_fp_bundle` and `get_lc_xsurvey_bundle` again with the *same*
`(survey, oid)` — so without a cache, selecting GP re-downloads the whole light
curve, the forced photometry and the cross-survey counterpart from ALeRCE. On a
cross-survey object that is ~5 s of duplicate network for a 32 ms fit, which is
what made the GP overlay feel slow however fast the fit itself got.

The bundles are a pure function of `(survey, oid)` over the lifetime of a page
view, so they memoize cleanly. Two concerns, same as `xmatch_cache`:

* **dedup** — a bundle fetched for the LC panel is reused by the GP overlay (and
  by a second GP selection after a Diff/Sci flip, which refits on the same data).
* **in-flight coalescing** — picking GP while the on-load FP fetch is still
  running waits on that fetch instead of firing a duplicate.

Deliberately small. `MAX_ENTRIES` is low because these payloads are large (a few
hundred detections plus forced photometry, megabytes once realised as Python
dicts) and production runs on a 1 GiB instance. This is a bridge from page load
to the next click on the *same* object, not a general object cache — the entry
cap is a memory bound, not a hit-rate target.

`TTL_SECONDS` is short for the same reason and because a light curve genuinely
changes when new alerts land; a few minutes of staleness inside one page view is
acceptable, hours would not be.

Reads return a **deep copy**. Callers treat these bundles as their own and do
mutate them (the GP path restamps keys, route handlers hand them to templates),
and a shared mutable payload across requests is exactly the kind of bug that
only shows up under concurrency.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

TTL_SECONDS = 300.0        # one page view, not one browsing session
MAX_ENTRIES = 32           # memory bound (see module docstring), not a hit target
_INFLIGHT_WAIT = 35.0      # slightly over the 30 s httpx ceiling upstream

_Key = tuple[str, str, str]                      # (name, survey, oid)
_cache: dict[_Key, tuple[float, Any]] = {}       # key -> (stored_at, payload)
_inflight: dict[_Key, asyncio.Event] = {}
_lock = asyncio.Lock()
_hits = _misses = 0


def _fresh(key: _Key) -> tuple[bool, Any]:
    """(found, payload). `found` distinguishes a cached None from a miss — the
    xsurvey bundle is legitimately None when the object has no counterpart, and
    re-fetching that on every GP click is precisely what we're avoiding."""
    entry = _cache.get(key)
    if entry is None:
        return False, None
    stored_at, payload = entry
    if time.time() - stored_at > TTL_SECONDS:
        _cache.pop(key, None)
        return False, None
    return True, payload


def _evict_if_needed() -> None:
    overflow = len(_cache) - MAX_ENTRIES
    if overflow > 0:
        for key, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:overflow]:
            _cache.pop(key, None)


def stats() -> dict:
    return {"entries": len(_cache), "inflight": len(_inflight),
            "hits": _hits, "misses": _misses,
            "ttl_seconds": TTL_SECONDS, "max_entries": MAX_ENTRIES}


def clear() -> None:
    """Test/ops hook — drop all cached payloads and in-flight markers."""
    _cache.clear()
    _inflight.clear()
    global _hits, _misses
    _hits = _misses = 0


async def get_or_fetch(
    name: str, survey: str, oid: str, fetch: Callable[[], Awaitable[Any]],
) -> Any:
    """Return the cached payload for `(name, survey, oid)`, else await `fetch()`.

    `fetch` is a zero-argument coroutine factory so the caller keeps ownership of
    its own keyword arguments; it is invoked at most once per key per TTL across
    concurrent callers. A fetch that raises is **not** cached — the exception
    propagates to the caller that triggered it (route handlers already guard
    their own calls), and the next caller retries.
    """
    global _hits, _misses
    key = (name, str(survey), str(oid))

    async with _lock:
        found, payload = _fresh(key)
        if found:
            _hits += 1
            return copy.deepcopy(payload)
        waiting = _inflight.get(key)
        if waiting is None:
            ev = asyncio.Event()
            _inflight[key] = ev
        _misses += 1

    if waiting is not None:
        # Someone else is already fetching this exact bundle — wait for them.
        try:
            await asyncio.wait_for(waiting.wait(), timeout=_INFLIGHT_WAIT)
        except asyncio.TimeoutError:
            log.warning("lc_cache: waited out %s for %s", _INFLIGHT_WAIT, key)
        async with _lock:
            found, payload = _fresh(key)
        if found:
            return copy.deepcopy(payload)
        return await fetch()      # their fetch failed or expired; do our own

    try:
        payload = await fetch()
    finally:
        # Release the marker even on a raise or a CancelledError (the client
        # closing the tab mid-fetch is routine here), so waiters aren't stranded
        # for the full _INFLIGHT_WAIT and later callers don't skip the key.
        # Synchronous, hence atomic in the event loop.
        ev = _inflight.pop(key, None)
        if ev is not None:
            ev.set()

    async with _lock:
        _cache[key] = (time.time(), payload)
        _evict_if_needed()
    return copy.deepcopy(payload)
