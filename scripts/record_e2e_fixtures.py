"""Record upstream HTTP fixtures for the Tier 3 (Playwright) suite.

Drives the real htmx endpoints in-process with the replay transport in RECORD
mode, so a single live run captures every ALeRCE/catsHTM call the detail view
makes for one golden object. Re-run to refresh.

    EXPLORER_REPLAY_DIR=tests-e2e/fixtures/upstream EXPLORER_RECORD=1 \
        python3 scripts/record_e2e_fixtures.py

The ASGI client passes its own transport, so replay.maybe_install()'s
setdefault patch leaves it alone and only the app's internal upstream clients
are intercepted.
"""
from __future__ import annotations

import asyncio
import os

# Golden object: a ZTF Cepheid with ~2000 detections — rich LC for the
# light-curve toggles and the periodogram.
OID = os.getenv("E2E_OID", "ZTF17aabopdz")
SURVEY = os.getenv("E2E_SURVEY", "ztf")

# The endpoint set the browser hits when opening this object's detail view.
RA, DEC = 307.47413048621615, 51.12344127469595  # golden object's mean position

ENDPOINTS = [
    ("/htmx/search_objects/", {"survey": SURVEY}),
    # LSST classifiers too: the search form's survey toggle / class dropdown
    # fetches them when the user switches surveys, and the app shell at "/"
    # loads them for the default survey.
    ("/htmx/search_objects/", {"survey": "lsst"}),
    # Deferred TNS lookup armed by the basic-info panel once it has ra/dec.
    ("/htmx/tns_lookup", {"oid": OID, "ra": RA, "dec": DEC}),
    ("/htmx/list_objects", {"survey": SURVEY, "oids": OID}),
    ("/htmx/detail", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/object_information", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/lightcurve", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/lc_fp", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/lc_features", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/lc_info", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/lc_xsurvey", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/probability", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/stamps", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/crossmatch", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/coord_residuals", {"oid": OID, "survey_id": SURVEY}),
    ("/htmx/aladin", {"oid": OID, "survey_id": SURVEY}),
    # Browser-side overlay the LC arms once lc_info supplies ra/dec: the ZTF DR
    # cone-search (REST). Coordinates are the golden object's mean position.
    ("/api/ztf_dr", {"ra": 307.47413048621615, "dec": 51.12344127469595, "radius": 1.5}),
]


async def main() -> None:
    if not os.getenv("EXPLORER_REPLAY_DIR"):
        raise SystemExit("Set EXPLORER_REPLAY_DIR (and EXPLORER_RECORD=1) first.")
    import httpx
    from src.app import app  # imported after env is set so replay installs

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        for path, params in ENDPOINTS:
            try:
                r = await client.get(path, params=params, timeout=60)
                print(f"  {r.status_code}  {path}  {params}")
            except Exception as e:  # noqa: BLE001
                print(f"  ERR  {path}: {type(e).__name__}: {e}")


if __name__ == "__main__":
    asyncio.run(main())
