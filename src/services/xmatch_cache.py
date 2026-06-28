"""In-memory TTL cache for bulk crossmatch records (services/xmatch.py).

Warmed by the page-load prefetch and read by the detail-view crossmatch panel
and the Aladin spec-z overlay. Pure runtime state — no disk persistence; it is
rebuilt on restart and simply re-warms on the next page load.

Two concerns it handles:

* **dedup** — every queried oid is cached, *including* oids with no match (an
  empty record), so paging back to a visited page or opening an already-prefetched
  object never re-queries CDS/NED.
* **in-flight coalescing** — if a prefetch is already fetching an oid, a detail
  view that needs the same oid waits on it instead of firing a second bulk_all.
"""
from __future__ import annotations

import asyncio
import logging
import time

from . import xmatch

log = logging.getLogger(__name__)

TTL_SECONDS = 3600.0
MAX_ENTRIES = 5000           # soft cap; oldest entries evicted past this
_INFLIGHT_WAIT = 30.0        # max seconds a waiter blocks on an in-flight fetch

_cache: dict[str, tuple[float, dict]] = {}      # oid -> (stored_at, record)
_inflight: dict[str, asyncio.Event] = {}        # oid -> completion event
_lock = asyncio.Lock()

# An object with no catalog matches still gets a (cached) record so we don't
# re-query it; this is the canonical "empty" shape from xmatch._build_object_record.
EMPTY_RECORD: dict = {"by_catalog": {}, "best_z": None, "simbad_type": None,
                      "counts": {}, "overlay": []}


def _fresh(oid: str) -> dict | None:
    entry = _cache.get(oid)
    if entry is None:
        return None
    stored_at, record = entry
    if time.time() - stored_at > TTL_SECONDS:
        _cache.pop(oid, None)
        return None
    return record


def _store(oid: str, record: dict) -> None:
    _cache[oid] = (time.time(), record)


def _evict_if_needed() -> None:
    overflow = len(_cache) - MAX_ENTRIES
    if overflow <= 0:
        return
    # Drop the oldest entries (smallest stored_at) first.
    for oid, _ in sorted(_cache.items(), key=lambda kv: kv[1][0])[:overflow]:
        _cache.pop(oid, None)


def stats() -> dict:
    return {"entries": len(_cache), "inflight": len(_inflight),
            "ttl_seconds": TTL_SECONDS, "max_entries": MAX_ENTRIES}


def clear() -> None:
    """Test/ops hook — drop all cached records and in-flight markers."""
    _cache.clear()
    _inflight.clear()


async def get(oid: str) -> dict | None:
    """Return the fresh cached record for *oid*, or None if absent/expired."""
    async with _lock:
        return _fresh(str(oid))


async def prefetch(positions: list[tuple[str, float, float]]) -> int:
    """Warm the cache for *positions*. Skips oids already fresh or in-flight.

    Returns the number of oids newly fetched (0 if everything was cached). Every
    claimed oid is written — matched ones with their record, unmatched ones with
    EMPTY_RECORD — so they won't be re-queried until TTL expiry.
    """
    if not positions:
        return 0
    # Claim the oids we'll fetch (atomic vs. concurrent prefetch/detail calls).
    claimed: list[tuple[str, float, float]] = []
    events: list[asyncio.Event] = []
    async with _lock:
        for oid, ra, dec in positions:
            oid = str(oid)
            if _fresh(oid) is not None or oid in _inflight:
                continue
            ev = asyncio.Event()
            _inflight[oid] = ev
            events.append(ev)
            claimed.append((oid, ra, dec))
    if not claimed:
        return 0

    try:
        records = await xmatch.bulk_all(claimed)
    except Exception:                    # pragma: no cover — bulk_all already guards per-catalog
        log.exception("prefetch bulk_all failed")
        records = {}

    async with _lock:
        for oid, _, _ in claimed:
            _store(oid, records.get(oid, EMPTY_RECORD))
        _evict_if_needed()
        for oid, _, _ in claimed:
            ev = _inflight.pop(oid, None)
            if ev is not None:
                ev.set()
    return len(claimed)


async def get_or_compute(oid: str, ra: float | None, dec: float | None) -> dict:
    """Cache-first lookup for a single object (detail view / overlay).

    Returns the cached record; on a miss it computes one via bulk_all (waiting on
    an in-flight prefetch for the same oid rather than firing a duplicate). Falls
    back to EMPTY_RECORD when coordinates are missing or the fetch fails.
    """
    oid = str(oid)
    async with _lock:
        hit = _fresh(oid)
        if hit is not None:
            return hit
        waiting = _inflight.get(oid)
    if waiting is not None:
        try:
            await asyncio.wait_for(waiting.wait(), timeout=_INFLIGHT_WAIT)
        except asyncio.TimeoutError:
            pass
        cached = await get(oid)
        if cached is not None:
            return cached
    if ra is None or dec is None:
        return EMPTY_RECORD
    # Compute via the same prefetch path so a concurrent detail open coalesces.
    await prefetch([(oid, ra, dec)])
    return await get(oid) or EMPTY_RECORD
