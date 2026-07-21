"""Per-object progress state for the bulk CDS/NED crossmatch (services/xmatch.py).

The detail-view crossmatch panel fires ~20 catalog queries for a cold (un-
prefetched) object, which can take tens of seconds. Rather than block the panel
on the whole batch, the route launches the compute in the background and the
CDS/NED section polls `/htmx/crossmatch_progress`, which reads this state to
render a live per-catalog checklist (done / failed / pending) and, on failure,
the reason each catalog gave.

Pure runtime state, updated from `xmatch.bulk_all` as each catalog task settles
(on the event loop — no locking needed) and read by the polling route. Keyed by
oid; the authoritative "done" signal is the cache record landing, not `finished`
here, so a lost/never-started progress entry never wedges the poll.
"""
from __future__ import annotations

import time

_MAX_ENTRIES = 500  # soft cap; oldest pruned past this

# oid -> {"total", "pending":[names], "done":[{name,matched}],
#         "failed":[{name,reason}], "started_at", "finished"}
_progress: dict[str, dict] = {}


def _prune() -> None:
    overflow = len(_progress) - _MAX_ENTRIES
    if overflow <= 0:
        return
    for key, _ in sorted(_progress.items(), key=lambda kv: kv[1].get("started_at", 0.0))[:overflow]:
        _progress.pop(key, None)


def start(oid: str, catalogs: list[str]) -> None:
    """Begin (or restart) tracking *oid* with the full catalog list pending."""
    _progress[str(oid)] = {
        "total": len(catalogs),
        "pending": list(catalogs),
        "done": [],
        "failed": [],
        # Matches accumulated as catalogs answer, keyed by catalog name — fed to
        # xmatch.build_partial_record so the poll can render a growing table.
        "by_catalog": {},
        "started_at": time.time(),
        "finished": False,
    }
    _prune()


def record_matches(oid: str, rows: list[dict]) -> None:
    """Accumulate a catalog's match rows so the partial table can grow live."""
    p = _progress.get(str(oid))
    if not p:
        return
    bc = p.setdefault("by_catalog", {})
    for r in rows:
        bc.setdefault(r["cat_name"], []).append(r)


def set_catshtm_markers(oid: str, markers: list[dict]) -> None:
    """Stash the object's catsHTM sky markers so the poll route can keep them in
    the "show all in sky view" button while the CDS/NED batch is still running
    (the poll doesn't re-fetch catsHTM). Read via ``get(oid)['catshtm_markers']``."""
    p = _progress.get(str(oid))
    if p is not None:
        p["catshtm_markers"] = markers or []


def mark_done(oid: str, name: str, matched: int) -> None:
    p = _progress.get(str(oid))
    if not p:
        return
    if name in p["pending"]:
        p["pending"].remove(name)
    p["done"].append({"name": name, "matched": matched})


def mark_failed(oid: str, name: str, reason: str) -> None:
    p = _progress.get(str(oid))
    if not p:
        return
    if name in p["pending"]:
        p["pending"].remove(name)
    p["failed"].append({"name": name, "reason": reason})


def finish(oid: str) -> None:
    p = _progress.get(str(oid))
    if p:
        p["finished"] = True


def get(oid: str) -> dict | None:
    return _progress.get(str(oid))


def clear() -> None:
    """Test/ops hook — drop all progress state."""
    _progress.clear()
