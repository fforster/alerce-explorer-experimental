#!/usr/bin/env python3
"""Pre-warm the explorer's server-side caches before the IUCAA 2026 tutorial.

Why two modes, and why they run at different times
--------------------------------------------------
The app has two server-side caches with very different shapes, so one warm-up
pass cannot serve both:

* ``xmatch_cache``  — TTL **3600 s**, 5000 entries, one entry per oid. Holds the
  ~20-catalog CDS/NED bulk crossmatch, which is by far the most expensive thing
  a cold detail view triggers. Warming this is worth doing for *every* object
  the tutorial touches, and it survives an hour.  -> ``--mode xmatch``

* ``lc_cache``      — TTL **300 s**, MAX_ENTRIES **32**, and *three* key
  families per object (``lc_fp``, ``lc_xsurvey``, ``ztf_dr``). That is roughly
  **ten objects of capacity, expiring every five minutes**. Warming it hours
  ahead does nothing, and warming twenty objects into it just evicts the ones
  you care about. So it is warmed for the guiding objects only, immediately
  before a live demo.  -> ``--mode full``

Both caches are module-level dicts inside the single uvicorn worker, so a warm
from anywhere benefits every student. Running this once from one machine is also
the *polite* option: the alternative is forty laptops behind one classroom IP
each triggering the same cold batch against ALeRCE's per-IP rate limit.

Usage
-----
    # ~50 min before, and once per hour during the session:
    python3 scripts/prewarm_tutorial.py --mode xmatch

    # 1-2 min before showing an object live (guiding objects by default):
    python3 scripts/prewarm_tutorial.py --mode full
    python3 scripts/prewarm_tutorial.py --mode full --objects ztf:ZTF17aabhbva
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://explorer-experiment.alerce.online"

# The three guiding objects named in the tutorial README (all in COSMOS, seen by
# both surveys) plus the LSST ids that appear in the authored cells of notebooks
# 00/01/02. These are what the presenter shows and what the room hits at once.
GUIDING: list[tuple[str, str]] = [
    ("ztf", "ZTF26aaonmha"),            # SN 2026gzf, type Ic-BL  (notebooks 00-03)
    ("ztf", "ZTF17aabhbva"),            # RR Lyrae                (notebooks 00-02, 05)
    ("ztf", "ZTF20acyxpwi"),            # quasar                  (notebooks 00-02, 04)
    ("lsst", "314003014107006318"),     # LSST counterpart        (notebooks 00-02)
    ("lsst", "313985345706262538"),     # LSST counterpart        (notebooks 00-02, 04)
]

# Objects used in the per-topic notebooks' authored cells.
SECONDARY: list[tuple[str, str]] = [
    # 03 - supernovae
    ("ztf", "ZTF26abltffn"), ("ztf", "ZTF26abicncn"), ("ztf", "ZTF26abfqjst"),
    ("ztf", "ZTF26aazeadp"), ("ztf", "ZTF26aazbfav"), ("ztf", "ZTF26aagmisy"),
    # 04 - AGN
    ("ztf", "ZTF22aademwd"), ("ztf", "ZTF20aavijyr"),
    # 05 - variable stars
    ("ztf", "ZTF19aakzaeb"), ("ztf", "ZTF17aaansag"), ("ztf", "ZTF18acurdih"),
    ("lsst", "313976545432567829"), ("lsst", "313893021775560722"),
    ("lsst", "313888627082919999"),
]

TIMEOUT = 120.0
POLL_INTERVAL = 1.5
POLL_BUDGET = 90.0


def get(path: str, params: dict[str, str]) -> tuple[int, str]:
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "prewarm-tutorial/1"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:                                    # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def warm_xmatch(survey: str, oid: str) -> str:
    """Trigger the bulk CDS/NED crossmatch and wait for the cache record.

    `GET /htmx/crossmatch` launches the ~20-catalog batch in the background and
    hands back a poll shell, so the useful signal is the *progress* endpoint
    going terminal — which it does when the cache record lands, not when the
    progress dict says `finished`.
    """
    t0 = time.time()
    status, _ = get("/htmx/crossmatch", {"oid": oid, "survey_id": survey})
    if status != 200:
        return f"crossmatch HTTP {status}"
    deadline = t0 + POLL_BUDGET
    while time.time() < deadline:
        status, html = get(
            "/htmx/crossmatch_progress", {"oid": oid, "survey_id": survey}
        )
        if status != 200:
            return f"progress HTTP {status}"
        # The pending branch re-polls itself; the terminal section does not.
        if "crossmatch_progress" not in html:
            return f"cached in {time.time() - t0:.1f}s"
        time.sleep(POLL_INTERVAL)
    return f"still pending after {POLL_BUDGET:.0f}s"


def warm_full(survey: str, oid: str) -> str:
    """Also warm lc_cache (lc_fp, lc_xsurvey) and run one GP fit."""
    notes = [warm_xmatch(survey, oid)]
    for label, path in (
        ("info", "/htmx/object_information"),
        ("lc", "/htmx/lightcurve"),
        ("fp", "/htmx/lc_fp"),
        ("xsurvey", "/htmx/lc_xsurvey"),
        ("gp", "/htmx/lc_gp"),
    ):
        t0 = time.time()
        status, _ = get(path, {"oid": oid, "survey_id": survey})
        flag = "" if status == 200 else f"!{status}"
        notes.append(f"{label}{flag} {time.time() - t0:.1f}s")
    return " | ".join(notes)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=("xmatch", "full"), default="xmatch")
    ap.add_argument("--concurrency", type=int, default=3,
                    help="keep this low: ALeRCE rate-limits per IP (default 3)")
    ap.add_argument("--objects", nargs="*", default=None,
                    help="override, as survey:oid (e.g. ztf:ZTF26aaonmha)")
    args = ap.parse_args()

    if args.objects:
        targets = []
        for spec in args.objects:
            survey, _, oid = spec.partition(":")
            if not oid or survey not in ("ztf", "lsst"):
                print(f"bad --objects entry: {spec!r} (want ztf:OID or lsst:OID)")
                return 2
            targets.append((survey, oid))
    elif args.mode == "full":
        targets = GUIDING                      # respects the ~10-object lc_cache cap
    else:
        targets = GUIDING + SECONDARY

    work = warm_full if args.mode == "full" else warm_xmatch
    print(f"mode={args.mode}  objects={len(targets)}  concurrency={args.concurrency}")
    print(f"target={BASE}\n")

    t0 = time.time()
    results: dict[tuple[str, str], str] = {}
    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futs = {pool.submit(work, s, o): (s, o) for s, o in targets}
        for fut in cf.as_completed(futs):
            key = futs[fut]
            try:
                results[key] = fut.result()
            except Exception as e:             # noqa: BLE001
                results[key] = f"ERROR {type(e).__name__}: {e}"
            print(f"  {key[0]:4s} {key[1]:20s} {results[key]}")

    bad = [k for k, v in results.items()
           if "pending" in v or "HTTP" in v or v.startswith("ERROR") or "!" in v]
    print(f"\ndone in {time.time() - t0:.1f}s — "
          f"{len(results) - len(bad)}/{len(results)} clean")
    if bad:
        print("needs a look: " + ", ".join(f"{s}:{o}" for s, o in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
