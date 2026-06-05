"""Record / replay for upstream HTTP, so the Playwright (Tier 3) suite runs
deterministically offline.

Every server-side upstream call goes through ``httpx.AsyncClient`` (see
``alerce_client``, ``crossmatch``, ``tns``). None of those sites pass a custom
transport, so installing one process-wide transport intercepts all of them.

Modes, selected by env vars (off by default — production never touches this):

* ``EXPLORER_REPLAY_DIR`` set, ``EXPLORER_RECORD`` unset → **replay**: serve
  responses from JSON fixtures in that dir; a request with no fixture returns
  HTTP 599 with a ``replay_miss`` body so the test fails loudly and names the
  URL to record.
* ``EXPLORER_REPLAY_DIR`` set, ``EXPLORER_RECORD=1`` → **record**: proxy to the
  real network and save each response as a fixture (overwriting), so a single
  live run captures everything the endpoints fetch.

Fixtures are keyed by ``METHOD URL`` (+ body hash for non-GET), stored as
``<slug>-<hash>.json`` with ``{status, headers, body_b64}``. Storing the full
header set keeps redirects (ZTF's 308 bare-path → trailing-slash) replayable.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import Path

import httpx

_RECORD_HEADER_ALLOW = {"content-type", "location"}


def _key(request: httpx.Request) -> str:
    raw = f"{request.method} {request.url}"
    # GET bodies are an unread stream; .content raises RequestNotRead. Only
    # non-GET requests carry a body worth keying on.
    try:
        body = request.content
    except httpx.RequestNotRead:
        body = b""
    if body:
        raw += " " + hashlib.sha256(body).hexdigest()
    digest = hashlib.sha256(raw.encode()).hexdigest()[:16]
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", f"{request.method}-{request.url.host}{request.url.path}").strip("-")
    return f"{slug[:80]}-{digest}"


class ReplayTransport(httpx.AsyncBaseTransport):
    def __init__(self, fixtures_dir: str, record: bool) -> None:
        self.dir = Path(fixtures_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.record = record
        self._real = httpx.AsyncHTTPTransport(retries=1) if record else None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = self.dir / f"{_key(request)}.json"
        if path.exists():
            data = json.loads(path.read_text())
            return httpx.Response(
                data["status"],
                headers=data.get("headers", {}),
                content=base64.b64decode(data["body_b64"]),
                request=request,
            )
        if not self.record:
            miss = json.dumps({"replay_miss": str(request.url)}).encode()
            return httpx.Response(599, content=miss, request=request)

        resp = await self._real.handle_async_request(request)
        body = await resp.aread()
        headers = {k: v for k, v in resp.headers.items() if k.lower() in _RECORD_HEADER_ALLOW}
        path.write_text(json.dumps({
            "url": str(request.url),
            "status": resp.status_code,
            "headers": headers,
            "body_b64": base64.b64encode(body).decode(),
        }, indent=0))
        return httpx.Response(resp.status_code, headers=headers, content=body, request=request)


_installed = False


def maybe_install() -> bool:
    """Install the transport if EXPLORER_REPLAY_DIR is set. Idempotent.

    Patches ``httpx.AsyncClient.__init__`` to inject our transport by
    ``setdefault`` — so any client that explicitly passes a transport (e.g. the
    in-process ASGI recorder, or the FastAPI TestClient) is left untouched.
    """
    global _installed
    fixtures_dir = os.getenv("EXPLORER_REPLAY_DIR")
    if not fixtures_dir or _installed:
        return _installed
    record = os.getenv("EXPLORER_RECORD") == "1"
    transport = ReplayTransport(fixtures_dir, record)

    _orig_init = httpx.AsyncClient.__init__

    def _patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs.setdefault("transport", transport)
        _orig_init(self, *args, **kwargs)

    httpx.AsyncClient.__init__ = _patched_init  # type: ignore[method-assign]
    _installed = True
    print(f"[replay] installed ({'record' if record else 'replay'}) dir={fixtures_dir}")
    return True
