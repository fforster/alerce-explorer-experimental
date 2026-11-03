"""Mirror failover for the CDS services.

Written against the November 2026 CDS Strasbourg outage: every CDS host stopped
answering at the TCP level, so these tests simulate "down" as a probe that
fails or returns an error status, never as a live network call. The autouse
fixture in conftest.py pins everything up and blocks the network; each test
here replaces `_probe` with its own scenario.
"""
from __future__ import annotations

import asyncio

import pytest

from src.services import cds_mirrors


def run(coro):
    return asyncio.run(coro)


#: The genuine `_probe`, captured at import — before conftest's autouse fixture
#: swaps it for a stub. The tests below that exercise the probe's own
#: status-code logic must call the real thing, not the fixture's "always up".
_REAL_PROBE = cds_mirrors._probe


@pytest.fixture(autouse=True)
def _clean():
    cds_mirrors.clear()
    yield
    cds_mirrors.clear()


def _probe_by_label(monkeypatch, up: set[str]):
    """Patch `_probe` so only endpoints whose label is in `up` are healthy.

    Returns the list of probed health URLs, so a test can assert how many
    probes actually happened (the caching behaviour is as important as the
    choice: 20 catalog tasks against a dead host must share one verdict).
    """
    probed: list[str] = []

    async def fake(ep):
        probed.append(ep.health)
        return ep.label in up

    monkeypatch.setattr(cds_mirrors, "_probe", fake)
    return probed


# --- preference order + failover -------------------------------------------

def test_primary_wins_when_everything_is_up(monkeypatch):
    """CDS stays first so recovery needs no code change and no stale pin."""
    _probe_by_label(monkeypatch, {"CDS Strasbourg", "CfA Harvard", "IDIA South Africa"})
    for service in ("simbad_tap", "simbad_web", "vizier_web"):
        assert run(cds_mirrors.resolve(service)).label == "CDS Strasbourg"


def test_falls_over_to_the_first_healthy_mirror(monkeypatch):
    _probe_by_label(monkeypatch, {"CfA Harvard", "IDIA South Africa"})
    assert run(cds_mirrors.resolve("simbad_tap")).label == "CfA Harvard"


def test_skips_past_several_dead_endpoints(monkeypatch):
    _probe_by_label(monkeypatch, {"IDIA South Africa"})
    ep = run(cds_mirrors.resolve("simbad_tap"))
    assert ep.label == "IDIA South Africa"
    assert "idia" in ep.base


def test_no_endpoint_available_returns_none(monkeypatch):
    """The useful negative: it's what lets bulk_all skip 14 catalogs at once.

    `None` must not be confused with an exception — callers degrade on it.
    """
    _probe_by_label(monkeypatch, set())
    assert run(cds_mirrors.resolve("simbad_tap")) is None
    assert run(cds_mirrors.base_url("simbad_tap")) is None


def test_xmatch_has_no_mirror_registered():
    """CDS XMatch exists only at Strasbourg. If this ever gains an entry it
    should be because a real mirror appeared, not by accident."""
    assert len(cds_mirrors.SERVICES["xmatch"]) == 1
    assert cds_mirrors.SERVICES["xmatch"][0].label == "CDS Strasbourg"


def test_base_url_returns_the_chosen_endpoints_base(monkeypatch):
    _probe_by_label(monkeypatch, {"CfA Harvard"})
    assert run(cds_mirrors.base_url("simbad_tap")) == (
        "https://simbad.cfa.harvard.edu/simbad/sim-tap")


def test_unknown_service_raises(monkeypatch):
    _probe_by_label(monkeypatch, {"CDS Strasbourg"})
    with pytest.raises(KeyError, match="unknown CDS service"):
        run(cds_mirrors.resolve("nope"))


def test_every_endpoint_health_url_sits_on_its_own_base_host():
    """A health check on the wrong host would certify the wrong service."""
    from urllib.parse import urlparse
    for service, candidates in cds_mirrors.SERVICES.items():
        for ep in candidates:
            assert urlparse(ep.health).netloc == urlparse(ep.base).netloc, service


# --- the 404 trap -----------------------------------------------------------

def test_a_404_on_the_health_path_counts_as_down(monkeypatch):
    """Verified real behaviour: IDIA mirrors VizieR's web UI but answers 404 on
    `TAPVizieR/tap/tables`. Treating "the host replied" as healthy would hand
    callers a base URL where every query 404s — an outage disguised as data
    loss. Only 2xx/3xx is healthy."""
    class Resp:
        def __init__(self, code): self.status_code = code

    async def fake_get(self, url):
        return Resp(404)

    import httpx
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    ep = cds_mirrors.SERVICES["vizier_tap"][0]
    assert run(_REAL_PROBE(ep)) is False


@pytest.mark.parametrize("code,expected", [
    (200, True), (204, True), (301, True), (399, True),
    (400, False), (403, False), (404, False), (500, False), (502, False),
])
def test_probe_status_thresholds(monkeypatch, code, expected):
    class Resp:
        def __init__(self, c): self.status_code = c

    async def fake_get(self, url):
        return Resp(code)

    import httpx
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    ep = cds_mirrors.SERVICES["simbad_tap"][0]
    assert run(_REAL_PROBE(ep)) is expected


def test_a_transport_error_counts_as_down(monkeypatch):
    async def fake_get(self, url):
        raise OSError("connect timeout")

    import httpx
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    assert run(_REAL_PROBE(cds_mirrors.SERVICES["xmatch"][0])) is False


# --- caching + coalescing ---------------------------------------------------

def test_a_verdict_is_cached_across_calls(monkeypatch):
    probed = _probe_by_label(monkeypatch, {"CDS Strasbourg"})

    async def scenario():
        for _ in range(10):
            await cds_mirrors.resolve("simbad_tap")

    run(scenario())
    assert len(probed) == 1, f"re-probed: {probed}"


def test_a_down_verdict_is_cached_too(monkeypatch):
    """The whole point of the fast negative: ~20 catalog tasks per page view
    must not each re-pay the connect timeout against a dead host."""
    probed = _probe_by_label(monkeypatch, set())

    async def scenario():
        for _ in range(10):
            await cds_mirrors.resolve("xmatch")

    run(scenario())
    assert len(probed) == 1


def test_concurrent_resolves_share_one_probe(monkeypatch):
    """Without in-flight coalescing a cold cache plus the crossmatch fan-out
    fires one probe per catalog at a host already suspected dead."""
    started = 0

    async def fake(ep):
        nonlocal started
        started += 1
        await asyncio.sleep(0.05)       # hold the window open
        return False

    monkeypatch.setattr(cds_mirrors, "_probe", fake)

    async def scenario():
        return await asyncio.gather(*(cds_mirrors.resolve("xmatch") for _ in range(20)))

    results = run(scenario())
    assert results == [None] * 20
    assert started == 1, f"{started} concurrent probes"


def test_an_expired_verdict_is_reprobed(monkeypatch):
    """TTL_DOWN is short so a CDS recovery is noticed without a restart."""
    probed = _probe_by_label(monkeypatch, set())
    monkeypatch.setattr(cds_mirrors, "TTL_DOWN", -1.0)   # instantly stale

    async def scenario():
        await cds_mirrors.resolve("xmatch")
        await cds_mirrors.resolve("xmatch")

    run(scenario())
    assert len(probed) == 2


def test_resolve_many_resolves_each_service(monkeypatch):
    _probe_by_label(monkeypatch, {"CfA Harvard"})
    out = run(cds_mirrors.resolve_many(["xmatch", "simbad_tap"]))
    assert out["xmatch"] is None                       # no mirror exists
    assert out["simbad_tap"].label == "CfA Harvard"


def test_clear_forgets_every_verdict(monkeypatch):
    probed = _probe_by_label(monkeypatch, {"CDS Strasbourg"})
    run(cds_mirrors.resolve("simbad_tap"))
    cds_mirrors.clear()
    run(cds_mirrors.resolve("simbad_tap"))
    assert len(probed) == 2


# --- offline / replay mode --------------------------------------------------

def test_replay_mode_never_claims_a_mirror(monkeypatch):
    """The e2e suite is hermetic; a mirror "up" verdict there would be fiction
    and would send astroquery at the real network."""
    monkeypatch.setenv("EXPLORER_REPLAY_DIR", "/tmp/whatever")
    probed = _probe_by_label(monkeypatch, {"CDS Strasbourg"})
    assert run(cds_mirrors.resolve("simbad_tap")) is None
    assert probed == []


# --- cached_endpoint (sync, probe-free) -------------------------------------

def test_cached_endpoint_never_probes(monkeypatch):
    """It runs on a render path (the Other-archives links), so it must not do
    any I/O at all — not even a cached-miss probe."""
    probed = _probe_by_label(monkeypatch, {"CfA Harvard"})
    assert cds_mirrors.cached_endpoint("simbad_web").label == "CDS Strasbourg"
    assert probed == []


def test_cached_endpoint_prefers_a_known_up_mirror(monkeypatch):
    _probe_by_label(monkeypatch, {"IDIA South Africa"})
    run(cds_mirrors.resolve("vizier_web"))
    assert cds_mirrors.cached_endpoint("vizier_web").label == "IDIA South Africa"


def test_cached_endpoint_prefers_unknown_over_known_down(monkeypatch):
    """A host we've never tried is a better guess than one we know is dead."""
    async def only_first(ep):
        return False

    monkeypatch.setattr(cds_mirrors, "_probe", only_first)
    # Probe just the primary, leaving the mirrors unknown.
    run(cds_mirrors._healthy(cds_mirrors.SERVICES["vizier_web"][0]))
    assert cds_mirrors.cached_endpoint("vizier_web").label != "CDS Strasbourg"


def test_cached_endpoint_falls_back_to_primary_when_all_known_down(monkeypatch):
    _probe_by_label(monkeypatch, set())
    run(cds_mirrors.resolve("vizier_web"))
    assert cds_mirrors.cached_endpoint("vizier_web").label == "CDS Strasbourg"


def test_cached_endpoint_unknown_service_raises():
    with pytest.raises(KeyError):
        cds_mirrors.cached_endpoint("nope")


# --- status -----------------------------------------------------------------

def test_status_reports_per_endpoint_state(monkeypatch):
    _probe_by_label(monkeypatch, {"CfA Harvard"})
    run(cds_mirrors.resolve("simbad_tap"))
    rows = cds_mirrors.status()["simbad_tap"]
    by_label = {r["label"]: r["state"] for r in rows}
    assert by_label["CDS Strasbourg"] == "down"
    assert by_label["CfA Harvard"] == "up"
    # Never reached: CfA answered first, so IDIA was never probed.
    assert by_label["IDIA South Africa"] == "unknown"


def test_status_covers_every_registered_service():
    assert set(cds_mirrors.status()) == set(cds_mirrors.SERVICES)
