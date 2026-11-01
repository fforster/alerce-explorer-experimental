"""Named thread pools, so CPU work never queues behind network work.

`asyncio.to_thread` runs on the event loop's **default** executor, whose size is
`min(32, os.cpu_count() + 4)` — **6 threads** on the production t3.micro (2
vCPU). Two very different workloads were sharing it:

* `xmatch.bulk_all` — ~20 blocking astroquery / pyvo catalog calls, each with a
  30 s deadline, fanned out behind a `Semaphore(8)`.
* `gp.fit_multiband_gp` — one short CPU-bound solve (tens of ms).

Eight permits against six threads means the catalog batch saturates the whole
pool for as long as it runs, and the GP fit then waits in the queue behind it.
Measured on production: a GP fit that takes **1.3 s** with warm inputs took
**64.6 s** when it was submitted while a cold crossmatch batch was in flight —
which is exactly the reported symptom, because a *new* object starts that batch
on detail-view load and the second attempt finds it finished.

(64 s rather than 30 s because `asyncio.wait_for` only abandons the *wait*: the
timed-out thread keeps its slot until its own HTTP request unwinds.)

So the two workloads get their own pools. Nothing is faster in isolation; the
point is that neither can starve the other, and the default pool is left empty
for anything that reaches for `to_thread` later.
"""
from __future__ import annotations

import asyncio
import functools
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

T = TypeVar("T")

#: Short CPU-bound solves (the GP fit). Sized to the box, not to the request
#: rate: gpimg releases the GIL and parallelises internally with OpenMP, so more
#: workers than cores would only thrash. Queueing here is honest contention for
#: the CPU — unlike queueing behind a catalog call, which is contention for
#: nothing.
CPU_WORKERS = max(2, os.cpu_count() or 2)

#: Blocking catalog I/O (astroquery / pyvo in `xmatch.bulk_all`). Sized to that
#: module's `Semaphore(_CONCURRENCY)` so the semaphore is the real limit and the
#: pool is never the bottleneck. A thread abandoned by a per-catalog timeout
#: holds its slot until its own request unwinds, which can slow the rest of the
#: batch — but now only the batch.
IO_WORKERS = 8

_cpu = ThreadPoolExecutor(max_workers=CPU_WORKERS, thread_name_prefix="cpu")
_io = ThreadPoolExecutor(max_workers=IO_WORKERS, thread_name_prefix="catalog-io")


def _run(pool: ThreadPoolExecutor, fn: Callable[..., T], *args: Any, **kw: Any) -> Any:
    """`asyncio.to_thread(fn, *args, **kw)` against an explicit pool.

    Returns the awaitable `run_in_executor` gives us, so callers can wrap it in
    `asyncio.wait_for` exactly as they did with `to_thread`.
    """
    return asyncio.get_running_loop().run_in_executor(
        pool, functools.partial(fn, *args, **kw)
    )


def run_cpu(fn: Callable[..., T], *args: Any, **kw: Any) -> Any:
    """Run a short CPU-bound function on the CPU pool."""
    return _run(_cpu, fn, *args, **kw)


def run_io(fn: Callable[..., T], *args: Any, **kw: Any) -> Any:
    """Run a blocking network call on the catalog-I/O pool."""
    return _run(_io, fn, *args, **kw)


def stats() -> dict[str, int]:
    """Ops hook — pool sizes and queue depths (`/api/health` style use)."""
    return {
        "cpu_workers": CPU_WORKERS,
        "cpu_queued": _cpu._work_queue.qsize(),
        "io_workers": IO_WORKERS,
        "io_queued": _io._work_queue.qsize(),
    }
