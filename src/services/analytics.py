"""Server-side ingest for the client session-replay analytics (rrweb).

The browser records the session with rrweb and ``navigator.sendBeacon``s
batched event blobs to ``POST /api/ux_events``. This module is the sink: it
appends each batch as one JSON line to a **gzipped, daily-rotated** log file so
the data is trivially loadable later::

    import pandas as pd
    pd.read_json("logs/analytics/2026-06-25.jsonl.gz", lines=True, compression="gzip")

Off by default — like ``replay.maybe_install`` (``EXPLORER_REPLAY_DIR``),
collection only happens when ``ANALYTICS_ENABLED`` is explicitly set. Privacy is
built in: no raw client IP is ever stored (only a salted hash that lets us tell
sessions/bots apart), no PII, and the client honors DNT / opt-out before any
beacon is sent.

Forward-compat: each batch carries an opaque ``identity`` object
(``{auth, user_id, data_rights_tier}``). Today it is always anonymous and is
persisted verbatim. When login lands, re-derive ``identity`` server-side from
the session/token instead of trusting the client (see the TODO in ``append``)
so a user can't spoof another's data-rights tier.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # repo root

# Serializes appends so concurrent beacons don't interleave partial lines.
_write_lock = threading.Lock()


def is_enabled() -> bool:
    """True only when ANALYTICS_ENABLED is explicitly truthy.

    Default off so a fresh checkout / production never collects unless the
    operator opts in — mirrors the EXPLORER_REPLAY_DIR opt-in convention.
    """
    return os.getenv("ANALYTICS_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}


def log_dir() -> Path:
    """Directory for the daily ``.jsonl.gz`` files (created on first write)."""
    return Path(os.getenv("ANALYTICS_LOG_DIR", str(BASE_DIR / "logs" / "analytics")))


def _ip_hash(client_ip: str | None) -> str | None:
    """Salted SHA-256 of the client IP — never the raw address.

    Lets us separate sessions/bots without storing a PII-grade identifier. The
    salt (ANALYTICS_IP_SALT) keeps the hash from being reversible via a rainbow
    table of the ~4 billion IPv4 addresses; if unset we fall back to a fixed
    salt (still non-reversible-by-accident, just not secret).
    """
    if not client_ip:
        return None
    salt = os.getenv("ANALYTICS_IP_SALT", "alerce-explorer-analytics")
    return hashlib.sha256(f"{salt}:{client_ip}".encode()).hexdigest()[:16]


def _today_path() -> Path:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return log_dir() / f"{day}.jsonl.gz"


def append(payload: dict, client_ip: str | None = None) -> None:
    """Append one rrweb batch as a gzip-compressed JSON line.

    ``payload`` is the opaque client body
    (``{visitor_id, session_id, identity, url, ua, ts, events}``); we wrap it
    with server-side fields rather than mutating it, so the client's view and
    our provenance stay distinct.
    """
    # TODO(login): when authentication exists, override payload["identity"]
    # here with the tier derived from the server-side session/token — never
    # trust the client-supplied identity for data-rights decisions.
    record = {
        "server_ts": time.time(),
        "ip_hash": _ip_hash(client_ip),
        "payload": payload,
    }
    line = json.dumps(record, separators=(",", ":"), default=str) + "\n"

    path = _today_path()
    with _write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        # gzip append mode: each open() starts a new gzip member, which the
        # gzip format concatenates transparently — readers (and pandas) see one
        # continuous stream. One member per batch is fine and keeps writes cheap.
        with gzip.open(path, "at", encoding="utf-8") as fh:
            fh.write(line)
