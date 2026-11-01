"""The two thread pools must be isolated from each other.

Regression lock for a production incident: the GP fit and the ~20-call CDS/NED
crossmatch batch both used `asyncio.to_thread`, i.e. the event loop's default
executor — 6 threads on the 2-vCPU production box, against a `Semaphore(8)`.
A GP fit submitted while a cold crossmatch batch was in flight sat in that
queue: measured 1.3 s warm vs 64.6 s under a batch. These tests assert the
property that fixes it — work on one pool cannot delay work on the other.
"""
from __future__ import annotations

import asyncio
import threading
import time

import pytest

from src.services import executors


def test_pools_are_distinct_and_io_is_sized_to_the_xmatch_semaphore():
    from src.services import xmatch

    # If the I/O pool were smaller than the semaphore, the pool — not the
    # semaphore — would be the batch's real limit, which is the bug in miniature.
    assert executors.IO_WORKERS >= xmatch._CONCURRENCY
    assert executors.CPU_WORKERS >= 2
    assert executors._cpu is not executors._io


def test_cpu_work_is_not_delayed_by_a_saturated_io_pool():
    """Fill the I/O pool past its worker count, then time a CPU submission."""
    release = threading.Event()

    def blocked() -> None:
        release.wait(timeout=10.0)

    async def scenario() -> float:
        # Two full waves of I/O work: every worker busy, the rest queued.
        hogs = [executors.run_io(blocked) for _ in range(executors.IO_WORKERS * 2)]
        await asyncio.sleep(0.05)          # let the pool pick them up
        t0 = time.perf_counter()
        got = await executors.run_cpu(lambda: "fit")
        elapsed = time.perf_counter() - t0
        assert got == "fit"
        release.set()
        await asyncio.gather(*hogs)
        return elapsed

    elapsed = asyncio.run(scenario())
    # The real failure mode was tens of seconds; 2 s is a generous ceiling that
    # still fails loudly if the two workloads ever share a pool again.
    assert elapsed < 2.0, f"CPU work queued behind saturated I/O pool ({elapsed:.1f}s)"


def test_io_work_is_not_delayed_by_a_saturated_cpu_pool():
    release = threading.Event()

    async def scenario() -> float:
        hogs = [executors.run_cpu(lambda: release.wait(timeout=10.0))
                for _ in range(executors.CPU_WORKERS * 2)]
        await asyncio.sleep(0.05)
        t0 = time.perf_counter()
        await executors.run_io(lambda: None)
        elapsed = time.perf_counter() - t0
        release.set()
        await asyncio.gather(*hogs)
        return elapsed

    assert asyncio.run(scenario()) < 2.0


def test_run_helpers_pass_positional_and_keyword_arguments():
    def fn(a, b, *, c, d=4):
        return (a, b, c, d)

    async def scenario():
        return (
            await executors.run_cpu(fn, 1, 2, c=3),
            await executors.run_io(fn, 1, 2, c=3, d=9),
        )

    cpu, io = asyncio.run(scenario())
    assert cpu == (1, 2, 3, 4)
    assert io == (1, 2, 3, 9)


def test_run_helpers_propagate_exceptions_like_to_thread():
    async def scenario():
        with pytest.raises(ValueError, match="boom"):
            await executors.run_cpu(lambda: (_ for _ in ()).throw(ValueError("boom")))

    asyncio.run(scenario())


def test_stats_reports_both_pools():
    s = executors.stats()
    assert s["cpu_workers"] == executors.CPU_WORKERS
    assert s["io_workers"] == executors.IO_WORKERS
    assert s["cpu_queued"] == 0 and s["io_queued"] == 0
