"""Mirror failover for the CDS services, with health memory.

**Why this exists.** In November 2026 CDS Strasbourg was taken partly offline
by a cybersecurity incident; their notice said recovery would "take several
weeks" and pointed at mirrors. Every CDS host in this app stopped answering
*at the TCP level* — not 500s, but connect timeouts — so each of the ~20
crossmatch catalogs burned its full `_CATALOG_DEADLINE` before failing, the
Aladin sky view never loaded its library, and the panel reported "20 catalogs
unavailable" after a minute of spinning.

Two separate jobs, and the second matters as much as the first:

1. **Failover** — use a mirror when the primary is down.
2. **Fast, shared failure** — remember that a host is down, so the next caller
   fails in microseconds instead of re-paying the connect timeout. With 20
   catalog tasks per page view against a dead host, re-probing per call is the
   difference between a panel that says "unavailable" at once and one that
   hangs for a minute.

**Mirror coverage is uneven, and pretending otherwise would be worse than the
outage.** Checked against the live services while writing this:

| service | mirrors |
|---|---|
| SIMBAD TAP | CfA Harvard, IDIA South Africa — both verified working |
| VizieR TAP | **none** — the mirrors serve the web UI, not `TAPVizieR/tap` |
| CDS XMatch | **none** — the service exists only at Strasbourg |

So `base_url` returns `None` when a service has no reachable endpoint, and
callers are expected to degrade honestly rather than retry into a void. That
`None` is the useful answer: it is what lets `bulk_all` skip 14 XMatch catalogs
in one step instead of timing each of them out.

**Resolve in async, inject into workers.** The crossmatch cores are sync
functions running in a thread pool; they must not bridge back into the event
loop. `bulk_all` resolves once up front and passes the chosen base URLs down,
which also means one probe per batch rather than one per catalog.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Iterable

import httpx

log = logging.getLogger(__name__)

#: How long to trust a good result. Long: a healthy mirror rarely dies
#: mid-page-view, and re-probing costs a round trip on the critical path.
TTL_OK = 300.0
#: How long to trust a bad result. Short enough to notice CDS coming back
#: within a few minutes, long enough that a page view's ~20 catalog tasks
#: share one verdict instead of re-probing each.
TTL_DOWN = 60.0
#: Probe budget. A dead host here is a *connect* timeout, so this is mostly a
#: bound on how long the first unlucky caller waits before the answer is cached.
PROBE_TIMEOUT = 5.0


@dataclass(frozen=True)
class Endpoint:
    """One candidate host for a logical service."""
    base: str      #: what callers pass to pyvo / astroquery
    health: str    #: absolute URL that answers < 500 when the service is up
    label: str     #: human-readable site name, for logs and the UI


#: Ordered candidates per service — primary first, then mirrors. Order is
#: preference, not quality: CDS stays first so everything returns to normal on
#: its own once Strasbourg is back, with no code change and no stale pin.
SERVICES: dict[str, tuple[Endpoint, ...]] = {
    # CDS XMatch has no mirror anywhere. It is still registered, because the
    # value of registering it is the *fast negative*: one probe per minute
    # instead of 14 catalogs each waiting out a 30 s deadline.
    "xmatch": (
        Endpoint(
            base="http://cdsxmatch.u-strasbg.fr/xmatch/api/v1/sync",
            health="http://cdsxmatch.u-strasbg.fr/xmatch/api/v1/tables",
            label="CDS Strasbourg",
        ),
    ),
    # The VizieR mirrors in the CDS notice serve `viz-bin/VizieR` (the web UI);
    # none of them exposes `TAPVizieR/tap` — verified 404 at IDIA and
    # China-VO, and CfA was answering 502. Registered so a mirror that gains a
    # TAP endpoint is one line away, and so the negative is cached meanwhile.
    "vizier_tap": (
        Endpoint(
            base="https://tapvizier.cds.unistra.fr/TAPVizieR/tap",
            health="https://tapvizier.cds.unistra.fr/TAPVizieR/tap/tables",
            label="CDS Strasbourg",
        ),
        Endpoint(
            base="https://vizier.cfa.harvard.edu/TAPVizieR/tap",
            health="https://vizier.cfa.harvard.edu/TAPVizieR/tap/tables",
            label="CfA Harvard",
        ),
    ),
    # SIMBAD TAP is the one that pays off: both mirrors answer, so the Simbad
    # crossmatch survives the outage even though CDS XMatch (how we normally
    # reach the simbad table) does not. See xmatch._bulk_simbad_tap_sync.
    # The human-facing web pages behind the "Other archives" links. Separate
    # from the TAP entries: a mirror can serve the web UI and not the API (every
    # VizieR mirror does exactly that), so one verdict cannot cover both.
    # Paths verified against each mirror: `/simbad/sim-coo` and
    # `/viz-bin/VizieR-4` both answer 200 at CfA, IDIA, NAOJ and China-VO.
    "simbad_web": (
        Endpoint(
            base="https://simbad.u-strasbg.fr/simbad",
            health="https://simbad.u-strasbg.fr/simbad/",
            label="CDS Strasbourg",
        ),
        Endpoint(
            base="https://simbad.cfa.harvard.edu/simbad",
            health="https://simbad.cfa.harvard.edu/simbad/",
            label="CfA Harvard",
        ),
        Endpoint(
            base="https://simbad.idia.ac.za/simbad",
            health="https://simbad.idia.ac.za/simbad/",
            label="IDIA South Africa",
        ),
    ),
    "vizier_web": (
        Endpoint(
            base="https://vizier.cds.unistra.fr/viz-bin",
            health="https://vizier.cds.unistra.fr/viz-bin/VizieR",
            label="CDS Strasbourg",
        ),
        Endpoint(
            base="https://vizier.idia.ac.za/viz-bin",
            health="https://vizier.idia.ac.za/viz-bin/VizieR",
            label="IDIA South Africa",
        ),
        Endpoint(
            base="http://vizier.nao.ac.jp/viz-bin",
            health="http://vizier.nao.ac.jp/viz-bin/VizieR",
            label="NAOJ Japan",
        ),
        Endpoint(
            base="http://vizier.china-vo.org/viz-bin",
            health="http://vizier.china-vo.org/viz-bin/VizieR",
            label="China-VO",
        ),
    ),
    "simbad_tap": (
        Endpoint(
            base="https://simbad.cds.unistra.fr/simbad/sim-tap",
            health="https://simbad.cds.unistra.fr/simbad/sim-tap/tables",
            label="CDS Strasbourg",
        ),
        Endpoint(
            base="https://simbad.cfa.harvard.edu/simbad/sim-tap",
            health="https://simbad.cfa.harvard.edu/simbad/sim-tap/tables",
            label="CfA Harvard",
        ),
        Endpoint(
            base="https://simbad.idia.ac.za/simbad/sim-tap",
            health="https://simbad.idia.ac.za/simbad/sim-tap/tables",
            label="IDIA South Africa",
        ),
    ),
}

# health URL -> (checked_at, ok)
_health: dict[str, tuple[float, bool]] = {}
_probing: dict[str, asyncio.Event] = {}
_lock = asyncio.Lock()


def clear() -> None:
    """Test/ops hook — forget every cached verdict."""
    _health.clear()
    _probing.clear()


def _cached(health_url: str) -> bool | None:
    entry = _health.get(health_url)
    if entry is None:
        return None
    checked_at, ok = entry
    if time.time() - checked_at > (TTL_OK if ok else TTL_DOWN):
        _health.pop(health_url, None)
        return None
    return ok


async def _probe(ep: Endpoint) -> bool:
    """Is this endpoint serving the service we need? Requires a 2xx/3xx.

    Deliberately stricter than "the host answered". Every health path here is a
    listing endpoint that returns 200 on a working service, and a mirror can be
    perfectly up while not hosting the service at all: IDIA's VizieR answers
    **404** on `TAPVizieR/tap/tables` because it mirrors the web UI only. Taking
    that as healthy would hand callers a base URL where every query 404s —
    worse than a clean "no endpoint available", because it looks like data loss
    rather than an outage. A 502 (CfA VizieR during this incident: a reverse
    proxy with nothing behind it) is down for the same reason.
    """
    try:
        async with httpx.AsyncClient(
            timeout=PROBE_TIMEOUT, follow_redirects=True,
        ) as client:
            resp = await client.get(ep.health)
        ok = resp.status_code < 400
        if not ok:
            log.warning("cds_mirrors: %s answered %s for %s",
                        ep.label, resp.status_code, ep.health)
        return ok
    except Exception as exc:  # noqa: BLE001 — any transport failure is "down"
        log.warning("cds_mirrors: %s unreachable (%s)", ep.label, exc)
        return False


async def _healthy(ep: Endpoint) -> bool:
    """Cached health for one endpoint, with probe coalescing.

    Without the in-flight event, a cold cache plus ~20 concurrent catalog tasks
    would fire ~20 identical probes at a host we already suspect is dead.
    """
    cached = _cached(ep.health)
    if cached is not None:
        return cached

    async with _lock:
        cached = _cached(ep.health)
        if cached is not None:
            return cached
        waiting = _probing.get(ep.health)
        if waiting is None:
            _probing[ep.health] = asyncio.Event()

    if waiting is not None:
        try:
            await asyncio.wait_for(waiting.wait(), timeout=PROBE_TIMEOUT + 2.0)
        except asyncio.TimeoutError:
            pass
        cached = _cached(ep.health)
        return cached if cached is not None else False

    try:
        ok = await _probe(ep)
        _health[ep.health] = (time.time(), ok)
    finally:
        ev = _probing.pop(ep.health, None)
        if ev is not None:
            ev.set()
    return ok


async def resolve(service: str) -> Endpoint | None:
    """First candidate for `service` that is answering, else None.

    None means "this service has no reachable endpoint right now" — the caller
    should degrade, not retry. Unknown service names raise, so a typo surfaces
    as an error instead of a silent permanent outage.
    """
    candidates = SERVICES.get(service)
    if candidates is None:
        raise KeyError(f"unknown CDS service {service!r}; known: {sorted(SERVICES)}")
    # Offline test / e2e mode: never touch the network, and never claim a
    # mirror is up. Mirrors the EXPLORER_REPLAY_DIR guard in xmatch.bulk_all.
    if os.getenv("EXPLORER_REPLAY_DIR"):
        return None
    for ep in candidates:
        if await _healthy(ep):
            return ep
    log.warning("cds_mirrors: no endpoint available for %s", service)
    return None


async def base_url(service: str) -> str | None:
    """`resolve(service).base`, or None when nothing is answering."""
    ep = await resolve(service)
    return ep.base if ep is not None else None


async def resolve_many(services: Iterable[str]) -> dict[str, Endpoint | None]:
    """Resolve several services concurrently.

    `bulk_all` calls this once per batch so the whole fan-out shares one set of
    probes, and so the sync worker threads are handed plain URLs rather than
    having to reach back into the event loop.
    """
    names = list(services)
    results = await asyncio.gather(*(resolve(n) for n in names))
    return dict(zip(names, results))


def cached_endpoint(service: str) -> Endpoint:
    """First endpoint already *known* healthy — never probes, never blocks.

    For sync callers on a render path (`other_archives.build_archive_links`
    builds the "Other archives" links inside a sync service function). It reads
    only what the async resolver has already cached, so it costs nothing and
    can be called per render.

    Falls back to the primary when nothing is known yet, which is the right
    default: a link to CDS is correct whenever CDS is up, and the first page
    view that triggers a crossmatch warms the cache for the ones after it.
    Known-down endpoints are skipped, so once the verdict is in, the links move
    to a live mirror on their own.
    """
    candidates = SERVICES.get(service)
    if not candidates:
        raise KeyError(f"unknown CDS service {service!r}; known: {sorted(SERVICES)}")
    for ep in candidates:
        if _cached(ep.health) is True:
            return ep
    for ep in candidates:
        if _cached(ep.health) is None:      # unknown beats known-down
            return ep
    return candidates[0]


def status() -> dict[str, object]:
    """Ops hook — what we currently believe about each endpoint."""
    now = time.time()
    out: dict[str, object] = {}
    for service, candidates in SERVICES.items():
        rows = []
        for ep in candidates:
            entry = _health.get(ep.health)
            rows.append({
                "label": ep.label,
                "base": ep.base,
                "state": "unknown" if entry is None else ("up" if entry[1] else "down"),
                "age_s": None if entry is None else round(now - entry[0], 1),
            })
        out[service] = rows
    return out
