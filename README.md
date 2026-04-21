# Tutorial ALeRCE Explorer (htmx)

Re-implementation of the ALeRCE Explorer using htmx + FastAPI + Jinja2 + Tailwind,
mirroring the patterns used in the production
[`alercebroker/web-services/multisurveys-apis`](https://github.com/alercebroker/web-services/tree/main/multisurveys-apis).

See `CLAUDE.md` for the overall design, reference implementations, and the
domain-specific traps (survey abstraction, 64-bit OIDs, ZTF→nJy normalization,
GLS periodogram, FITS rendering, etc.).

## Status

Slices 1–6 plus radar, coord-residuals, and probability panels are live.
The detail view renders, in parallel from a single row click: a basic-info
panel, a Chart.js light curve (flux/mag, diff/sci, apparent/absolute with
Planck-2018 distance modulus, observed/dereddened with Fitzpatrick-1999
Milky-Way extinction), science/template/difference stamps (in-browser FITS
parsing for LSST, PNG for ZTF), an Aladin Lite sky viewer with spec-z
overlays from 10 VizieR catalogs, a classifier radar, and a coordinate
residuals scatter. LC ↔ stamps ↔ residuals selection is synced.
Crossmatch, periodogram, airmass, and name resolver are still deferred.

## Install

```bash
# Python deps (Poetry)
poetry install

# Node deps (Tailwind CLI)
npm install

# Build the stylesheet (required before first run)
npm run build:css
```

## Run

```bash
poetry run uvicorn src.app:app --reload --port 8000
# or, with tailwind live-rebuild in another terminal:
npm run watch:css
```

Then open http://localhost:8000.

## Test

```bash
poetry run pytest
# or without poetry
PYTHONPATH=. pytest
```

## Layout

```
src/
  app.py                  FastAPI entrypoint
  routes/
    htmx.py               HTMLResponse endpoints (Jinja2 fragments)
    rest.py               JSON endpoints for client-side features
  services/
    survey_config.py      SC() dispatch + per-survey field remapping + extinction_r
    normalize.py          Raw detection → common schema (ZTF mag→nJy)
    safe_json.py          64-bit-OID-safe JSON parsing for LSST
    alerce_client.py      httpx client for the public ALeRCE API
    object_list.py        build_search_params + ZTF↔LSST row normalization
    object_info.py        Detail-view shaping for the basic-info panel
    probability.py        Classifier probabilities for the radar panel
    coord_residuals.py    (Δra, Δdec) per detection from the mean position
    coordinates.py        ra_to_hms / dec_to_dms
    other_archives.py     External archive URL builders
    classifiers.py        Dedupe + merge classifier/class options
  templates/              Jinja2 partials, grouped by feature sub-area
  static/
    css/tailwind.css      Tailwind entry; compiles to main.css
    htmx/htmx.min.js      Self-hosted htmx 1.9.12
    chart-js/             Vendored Chart.js 4.x + zoom/pan plugins
    js/helpers.js         send_form_Data / send_pagination_data / ...
    js/selection.js       Cross-panel selection sync (LC ↔ stamps ↔ residuals)
    js/lightcurve.js      Chart.js LC + cycle-button toggles
    js/stamps.js          FITS + WCS + asinh stretch for LSST stamps
    js/aladin.js          Aladin Lite bootstrap + spec-z overlays
    js/radar.js           Classifier probability radar
    js/coord_residuals.js (Δra, Δdec) scatter
    js/cosmology.js       Planck-2018 distance modulus
    js/dust.js            IRSA dust-proxy client for E(B-V)
    js/specz.js           VizieR spec-z loader (10 catalogs)
tests/                    pytest suite (service layer)
```
