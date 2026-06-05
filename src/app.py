"""FastAPI entrypoint.

Single-app layout (tutorial). Production ALeRCE splits each feature into its
own service; for this tutorial we mount everything under one app.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routes import htmx, rest
from .services import replay

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Off unless EXPLORER_REPLAY_DIR is set (Tier 3 / E2E). No-op in production.
replay.maybe_install()

app = FastAPI(title="Tutorial ALeRCE Explorer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # htmx reads these response headers to drive history/redirects/retargeting;
    # the browser only surfaces them to JS if they're in Access-Control-Expose-Headers.
    # Same-origin requests don't need this, but it keeps things working when the
    # page and API are on different ports (e.g. during local experiments).
    expose_headers=[
        "HX-Push-Url",
        "HX-Replace-Url",
        "HX-Redirect",
        "HX-Refresh",
        "HX-Retarget",
        "HX-Reswap",
        "HX-Trigger",
        "HX-Trigger-After-Settle",
        "HX-Trigger-After-Swap",
    ],
)

app.state.api_url = os.getenv("API_URL", "http://localhost:8000")

app.include_router(htmx.router)
app.include_router(rest.router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
