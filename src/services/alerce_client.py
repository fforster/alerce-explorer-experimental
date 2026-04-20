"""Thin httpx client for the public ALeRCE REST API.

We proxy the ALeRCE endpoints rather than talking to Postgres directly. The
client returns parsed dicts (64-bit-OID-safe) and does no domain normalization
— that lives in the higher-level services (`classifiers`, `object_list`).
"""
from __future__ import annotations

from typing import Any

import httpx

from .safe_json import safe_json_loads
from .survey_config import SC

_TIMEOUT = httpx.Timeout(30.0)


async def _get(url: str, params: dict[str, Any] | None = None) -> Any:
    # follow_redirects: the ZTF API 308s bare paths onto their trailing-slash form.
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        return safe_json_loads(r.content)


async def list_objects(survey: str, params: dict[str, Any]) -> Any:
    cfg = SC(survey)
    query = cfg.extra_params({**params, "survey": survey})
    return await _get(cfg.objects_url(), params=query)


async def get_object(survey: str, oid: str) -> Any:
    cfg = SC(survey)
    return await _get(cfg.object_url(oid))


async def get_classifiers(survey: str) -> Any:
    cfg = SC(survey)
    return await _get(cfg.classifiers_url())
