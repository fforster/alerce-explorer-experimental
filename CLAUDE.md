# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

Reproduce the ALeRCE Explorer using **htmx** (matching the stack of the original production ALeRCE explorer), based on an existing single-file JavaScript prototype. This repository is primarily a tutorial demonstrating Claude Code workflows on the ALeRCE project — correctness of the port matters, but the pedagogical framing (small, reviewable steps) is part of the point.

## Reference implementations

Two prior artifacts must be consulted before writing code here:

- **Feature / numerics source:** `../ALeRCE_explorer/alerce_explorer.html` — the single-file JS prototype (~5600 lines). Source of truth for UI layout, feature set, normalization logic, and numerical recipes (GLS periodogram, cosmology, FITS rendering, extinction). Its sibling `../ALeRCE_explorer/CLAUDE.md` has a detailed section map — consult it first when porting a specific feature.
- **htmx patterns source:** [`alercebroker/web-services/multisurveys-apis`](https://github.com/alercebroker/web-services/tree/main/multisurveys-apis) — the production ALeRCE web services. Mirror its htmx patterns (see below).

When porting a feature, read the corresponding line range in `alerce_explorer.html` rather than reimplementing from scratch — the normalization, error propagation, and survey-specific quirks have been debugged there.

## How ALeRCE uses htmx (patterns to mirror)

The production stack in `multisurveys-apis` is a **FastAPI + Jinja2 + htmx 1.9.12 + Tailwind CSS** application. Each feature area (object search, lightcurve, stamps, crossmatch, aladin, classifier, probability, magstat) is a separate FastAPI sub-app (microservice) under `src/<feature>_api/`, each with the same internal shape:

```
src/<feature>_api/
  api.py              # FastAPI() app, CORS, Prometheus, include_router(rest), include_router(htmx)
  routes/
    htmx.py           # endpoints returning HTMLResponse via Jinja2Templates
    rest.py (or json/) # endpoints returning JSON for programmatic clients
  services/           # business logic (DB queries, validators, parsers, idmapper, TNS, ...)
  models/             # Pydantic request/response models
  templates/          # Jinja2 partials, grouped by feature sub-area
  static/             # per-service CSS assets
```

Shared code lives under `src/core/` (config, exceptions, idmapper, htmx/htmx.min.js bundled locally, chart-js helpers, periodogram, repository). Each service is mounted on its own port via a YAML `services:` config consumed by `scripts/run_all.py`-style tooling; `API_URL` is injected into Jinja globals so templates build absolute URLs.

### The FastAPI + htmx contract

Each htmx endpoint takes filter query params, runs Pydantic/ad-hoc validation, calls a service function, and returns `templates.TemplateResponse(...)` with an HTML fragment. Example pattern from `object_api/routes/htmx.py`:

```python
router = APIRouter()
templates = Jinja2Templates(directory="src/object_api/templates", autoescape=True, auto_reload=True)
templates.env.globals["API_URL"] = os.getenv("API_URL", "http://localhost:8000")

@router.get("/htmx/list_objects", response_class=HTMLResponse)
def objects_table(request: Request, survey: str | None = None, ...):
    object_list = get_objects_list(session_ms=request.app.state.psql_session, search_params=...)
    return templates.TemplateResponse(
        name="main_table_objects/objects_table.html.jinja",
        context={"request": request, "objects_list": object_list, ...},
    )
```

Key endpoint families already implemented in production (reuse these names):

| Endpoint | Returns |
|---|---|
| `GET /htmx/search_objects/` | Filter form (survey toggle, classifier/class, probability, ndet range, dates, conesearch) |
| `GET /htmx/classes_select` | Dependent class `<select>` options for a chosen classifier |
| `GET /htmx/list_objects` | Main results table with pagination + sortable column headers |
| `GET /htmx/side_objects` | Sidebar list of objects (alternate view of the same results) |
| `GET /htmx/object_information` | Basic information panel for one object (oid + survey_id) |
| `GET /htmx/features` | Feature table modal (version/band/filter picker + CSV download); survey-gated on `SurveyConfig.features_url_template` |
| `GET /htmx/tns/` | TNS lookup by RA/Dec |
| `GET /htmx/lightcurve` | LC panel — detections only on the synchronous path |
| `GET /htmx/lc_fp` | Deferred FP fragment (FP + ZTF v2 mag_corr re-merge → `lcSetBundle`) |
| `GET /htmx/lc_features` | Deferred features fragment (`Multiband_period` + parametric fits → `lcSetFeatures`) |
| `GET /htmx/lc_info` | Deferred ra/dec fragment (drives ZTF DR + IRSA E(B-V); → `lcSetCoords`) |
| `GET /htmx/lc_xsurvey` | Deferred cross-survey overlay (object_info → other-survey conesearch (3″) → matched LC + FP; → `lcSetCrossSurvey`) |
| `GET /htmx/tns_lookup` | Deferred TNS panel + OOB redshift inject into the LC redshift input |
| `GET /htmx/stamps` | Stamp picker + per-survey URL templates (`__OID__` + `__IDENT__` placeholders) so cross-survey clicks dispatch correctly |
| `GET /htmx/coord_residuals` | Position-residuals **shell** — scatter is built client-side from the live LC; endpoint just renders the canvas + `data-lc-target` |
| `GET /htmx/crossmatch` | catsHTM crossmatch panel body (prefetched on detail-view load) |
| `GET /htmx/airmass` | Airmass curve panel (shares grid cell with periodogram + residuals) |
| `GET /htmx/probability` | Classifier-probability radar |
| `GET /htmx/ztf_dr` | ZTF DR archival cone-search (1.5″) for the LC's ZTF DR overlay |

### Jinja template conventions

- Each fragment template starts by including `<script src="{{API_URL}}/htmx/htmx.min.js"></script>` and `<link rel="stylesheet" href="{{API_URL}}/static/...">` — htmx is **self-hosted**, not loaded from a CDN.
- Templates include `<meta name="htmx-config" content='{"selfRequestsOnly": false}'>` so the service can be embedded cross-origin.
- The `htmx-ext-response-targets` extension is loaded from unpkg for error-target routing.
- Tailwind classes are prefixed with `tw-` (configured in `tailwind.config.js`). Dark mode via `dark:` variants. Tailwind is compiled to `src/static/main.css` with `npm run build:css` / `watch:css`.
- Partials are small and composable; a feature area has a `templates/<feature>/` folder with multiple `.html.jinja` files plus a shared `input.html.jinja` macro (`{% from "input.html.jinja" import input as customInput %}`).

### htmx attribute idioms used throughout

- `hx-get="{{API_URL}}/htmx/list_objects"` with `hx-target="#objects_table"` and `hx-swap="outerHTML"` — endpoint returns the whole container so it can re-render itself (pagination links trigger this too).
- `hx-trigger="click"` on sortable `<th>` column headers and pagination spans.
- `hx-indicator="#table-objects-loading"` drives visible loading bars (`.loaderBar` class in `loading_indicators.css`).
- `hx-vals='js:{...send_form_Data(), ...send_pagination_data({{next}}), ...send_order_data(...)}'` — client-side JS helpers compose the query string from form state. This means **some client JS remains** to read DOM state and hand it back to htmx.
- `hx-ext="response-targets"` on the outer div so 4xx/5xx responses can target a different error region.
- Dependent dropdowns: the classifier `<span>` has `hx-get=".../classes_select" hx-trigger="change" hx-target="#classes_options" hx-swap="innerHTML" hx-vals='js:{...send_classes_data()}'`, so picking a classifier re-fetches the matching class options as an HTML fragment.
- **Scoped loading indicators** — prefer `.htmx-indicator-scoped` (defined in `tailwind.css` under `@layer components`) over the built-in `.htmx-indicator` for any spinner that sits inside a swap target. The built-in class uses a descendant combinator (`.htmx-request .htmx-indicator`) and leaks across unrelated requests: a `htmx.ajax(..., '#results-slot')` lights up every `.htmx-indicator` inside that slot. The scoped variant only reacts when htmx puts `.htmx-request` on the indicator element itself via `hx-indicator`.

### Where client-side JS still lives

Even with htmx, these subsystems remain JS-heavy and should not be ported to server-rendered partials:

- Chart.js 4.x plots (light curve, radar, periodogram, folded, airmass) — the production stack bundles `chart.js` locally under `src/core/chart-js/` with `helpers/` modules (our port should do the same rather than pull from a CDN).
- P4J / GLS periodogram (production uses the `P4J` Python wheel for offline jobs, but the UI still needs an in-browser periodogram for interactive phase folding — keep the GLS implementation from the prototype).
- In-browser FITS parsing + stamp rendering (asinh stretch, WCS rotation) for LSST stamps.
- Aladin Lite sky viewer.
- Zoom/pan gestures (`chartjs-plugin-zoom`, `Hammer.js`).
- Keyboard / touch navigation between objects in the result list.
- The small JS helpers that produce `hx-vals` payloads (`send_form_Data`, `send_pagination_data`, `send_order_data`, `send_classes_data`, etc.).

### Good targets for server-rendered htmx fragments

Search results table, object metadata panel, filter accordion state, crossmatch table, external archives dropdown, airmass observatory picker, classifier/class dropdowns (which depend on the survey), TNS side-panel.

## Domain complexity that is NOT obvious

These are the traps — read the referenced sections in `../ALeRCE_explorer/CLAUDE.md` before touching them:

1. **Survey abstraction via `SURVEY_CONFIG`** — LSST and ZTF use different field names, endpoints, and band sets. Never branch on survey directly; add entries to the config table.
2. **Normalization contract** — ZTF detections arrive in magnitudes and must be converted to nJy (`psfFlux = 10^((31.4 - mag)/2.5)`); LSST arrives in nJy already. Visualization consumes normalized data only.
3. **LSST OIDs are 64-bit integers** — `JSON.parse` silently loses precision. Use the `safeJsonParse` regex-wrap approach for every LSST response containing OIDs; compare candids as strings.
4. **ZTF v1/v2 lightcurve merge** — `mag_corr`/`e_mag_corr` come from the v2 endpoint and must be joined to v1 detections by candid string; `e_mag_corr = 100.0` is a sentinel for "unreliable" and any value ≥ 1.0 should be rejected.
5. **Light-curve display toggles are independent and composable** (flux/mag × diff/sci × apparent/absolute × observed/dereddened × band visibility × band offset × phase folding). A single `getPlotY` function applies all active corrections; don't scatter this logic.
6. **Cosmology** — Planck 2018 (H0=67.4, Ωm=0.315); distance modulus is computed by numeric integration, not a closed form.
7. **Milky Way extinction** — E(B-V) is fetched from a Cloudflare Workers proxy to IRSA; cache by RA/Dec rounded to 0.01°; Fitzpatrick (1999) R_λ coefficients are stored per survey.
8. **FITS pipeline** — gzip detection by magic bytes, 2880-byte block parsing, BZERO/BSCALE, asinh stretch on z-scaled percentiles, Y-flip only when `CDELT2 > 0`, North-up rotation via the CD matrix.
9. **Periodogram** — Generalized Lomb-Scargle with inverse-variance weighting, frequency grid `df = 1/(oversample·T)`, time-centered to reduce trig-argument magnitude, multi-harmonic score (sum of power at 1f–6f, NH=6) to suppress aliases, parabolic peak refinement.
10. **HiPS probing** — uses FITS cutouts (not JPEG) so compression artifacts don't fake coverage.
11. **Feature-extractor version selection** — the ZTF features endpoint bundles *every* version ever run on an object (~5 versions, ~180 rows each), no "current" flag. `src/services/features.py::pick_default_version` picks strictly-matched `N.N.N` versions (three pure-integer dot-separated segments), sorted `(first, second, third)` DESC — so `27.5.6` beats `27.5.0` beats legacy labels like `lc_classifier_1.2.1-P` or partial `25.0.1a8` whose third segment isn't a pure integer. **This helper is shared between the features-table modal default and the light-curve fold-period extractor** (`src/services/lightcurve.py::_extract_multiband_period`); the two must agree, otherwise the displayed `Multiband_period` and the period used for folding drift apart (original ZTF20acuwouz bug).
12. **Cross-survey overlay (LSST ↔ ZTF)** — every detail view cone-searches the *other* survey at this object's RA/Dec (`XSURVEY_RADIUS_ARCSEC = 3.0`) via `services/lightcurve.py::get_lc_xsurvey_bundle`, and the matched counterpart's LC + FP overlays the same chart. Per-survey identity is plumbed end-to-end:
    - `services/normalize.py` passes through `ra` and `dec` per detection (the position-residuals scatter and the CSV need them).
    - LC datasets stamp `$survey` + `$kind` ("det"/"fp"/"dr"/"overlay") on every dataset; pointStyle is `pointStyleFor(survey)` (LSST=circle, ZTF=square; ZTF FP is rotated 180° for apex-down).
    - Legend `generateLabels` groups by `(survey, kind)` and emits headers (`LSST det:`, `ZTF FP:`, …); header click toggles the whole bucket. Disabled datasets dim to `#484f58` (suppress Chart.js's strikethrough by always setting `hidden:false` and overriding `fontColor` / marker fills).
    - `applyModes` snapshots `(survey, kind, label) → hidden` *before* tearing down `chart.data.datasets` and re-applies it after, so band visibility survives every Flux/Mag, Diff/Sci, App/Abs, Obs/Der, Fold toggle. New entries (just-arrived FP / xsurvey / armed overlay) start visible.
    - Cross-survey OID lives on `chart.$lcXOid` (set by `lcSetCrossSurvey`) and is also surfaced as a clickable link in the basic-info panel (`#basic-info-xsurvey`, gated on `data-oid` to avoid stale-fragment smearing during a swap).
    - **Stamps dispatch**: server emits `data-url-template-{type}-{survey}` with `__OID__` + `__IDENT__` placeholders for both surveys. `setSelectedIdentifier(ident, survey, oid)` and `updateStampsForIdentifier(ident, survey, oid)` thread the click's survey + correct OID (primary OID for in-survey clicks, `chart.$lcXOid` otherwise) so cross-survey clicks reach the matching survey's stamp service. The picker dropdown only knows primary detections — cross-survey clicks update the stamps without touching the picker.
    - **Position residuals derive from the live LC** (`coord_residuals.js` walks `$lcRaw` + `$lcXRaw`, filters by LC dataset visibility, re-renders on `lc:dataChanged` / `lc:visibilityChanged` custom events fired from `applyModes` and the legend `onClick`). The endpoint is now a shell renderer; `shape_coord_residuals` stays for programmatic use.
    - **Periodogram inputs** are gated the same way: `getDetDataByBand` reads from both `$lcRaw` and `$lcXRaw`, skips bands hidden via the LC legend, and the status line lists the bands actually consumed (`LSST: g r · ZTF: g`).
    - **CSV export** carries `survey`, `oid`, `candid` columns plus cross-survey rows; `oid` and `candid` are double-quoted so 64-bit LSST ids stay string-typed in pandas/Excel.
13. **MJD time scale is per-survey** — LSST alerts carry `midpointMjdTai` (atomic time); ZTF MJDs are UTC. Any conversion to a calendar string must subtract the current TAI − UTC offset for LSST, or it will mislabel TAI as UTC and be 37 s off (current as of 2017-01-01; bump on the next leap second). Multiple brokers initially shipped this bug — see [community.lsst.org "Question about midpointMjdTai to UTC conversion in recent Rubin alerts"](https://community.lsst.org/t/question-about-midpointmjdtai-to-utc-conversion-in-recent-rubin-alerts/11976). The scale lives on `SurveyConfig.mjd_scale` (`"tai"` / `"utc"`) and the constant on `services/survey_config.py::TAI_MINUS_UTC_SECONDS`. Two converters consume it:
    - `services/stamps.py::_mjd_to_utc(mjd, scale)` — stamps picker dropdown (`"MJD … (YYYY-MM-DD HH:MM:SS UTC) · band"`).
    - `static/js/lightcurve.js::mjdToUtcString(mjd, survey)` — LC tooltip; picks the scale from `ctx.dataset.$survey`.
    - **Not** applied to the search form's `firstmjd_min/max` (`coords.js::smartDateToMJD`): the filter is calendar-day granularity, so the 37 s offset is below user-visible precision. Raw MJD displays (basic-info first/last MJD, LC X-axis ticks) stay unconverted on purpose — they're labeled "MJD", not "UTC".
    - The two TAI offset constants (Python + JS) must move together on the next leap second; grep for `TAI_MINUS_UTC_SECONDS`.

## External services the port depends on

- ALeRCE API (LSST and ZTF variants — distinct `apiBase`, `objectsUrl`, `lcUrl`, `fpUrl`, `probUrl`). The production microservices in `multisurveys-apis` are the canonical implementations; depending on how far the tutorial goes, we either call those APIs as a client or re-host a FastAPI sub-app that proxies them.
- ALeRCE stamp service (`avro.alerce.online/get_stamp` for ZTF PNG; `stamps_api/stamp` for LSST FITS).
- `catshtm.alerce.online/crossmatch_all` for catalog crossmatch.
- IRSA dust map via `dust-proxy.francisco-forster.workers.dev` (Cloudflare Worker).
- CDS: `hips2fits` (HiPS cutouts), Sesame name resolver, Aladin Lite CDN.

## Tutorial stack (in use)

- **Python 3.11+**, **FastAPI**, **Jinja2** (`auto_reload=True` in dev), **htmx 1.9.12 self-hosted** at `src/static/htmx/htmx.min.js`, **Tailwind 3.4+** via the `tailwindcss` CLI (prefix `tw-`), **Poetry** for Python deps, **npm** only for the Tailwind CLI.
- Single FastAPI app (not microservices) at `src/app.py`; `routes/htmx.py` returns `HTMLResponse`, `routes/rest.py` returns JSON.
- All ALeRCE data is fetched **server-side** via `httpx` in `src/services/alerce_client.py` and proxied through htmx fragments — the browser never calls the ALeRCE API directly. Set `follow_redirects=True` on the httpx client (ZTF endpoints 308 bare paths → trailing-slash form) and keep the timeout at 30s (LSST `list_objects` is slow).
- Client JS helpers in `src/static/js/helpers.js` (`send_form_Data`, `send_pagination_data`, `send_classes_data`) are exposed on `window` and attached via `hx-vals='js:{...helper()}'` — filter state lives in the DOM, not the server.
- Use the new `Jinja2Templates.TemplateResponse(request, name, context)` signature, not the deprecated `(name, {"request": request, ...})` form.

## Commands

```bash
# Install deps
poetry install              # Python
npm install                 # Tailwind CLI only

# Run tests (~256 total — services + route fragments; upstream calls monkeypatched)
python3 -m pytest           # full suite
python3 -m pytest tests/test_object_info.py -v   # single file
python3 -m pytest -k "detail"                     # by keyword

# Dev server (hot-reload templates via auto_reload=True)
poetry run uvicorn src.app:app --reload --port 8000

# Tailwind (rebuild main.css from tailwind.css)
npm run watch:css           # dev
npm run build:css           # minified production build
```

Tests run offline — upstream ALeRCE calls are monkeypatched in `tests/test_routes.py` via `src.routes.htmx.<service>.<fn>` attribute paths.

## Repository layout

```
src/
  app.py                     # FastAPI(), CORS, static mount, router includes
  routes/
    htmx.py                  # HTMLResponse endpoints (search form, list, detail, object info, classes select)
    rest.py                  # JSON endpoints (e.g. /api/health)
  services/
    alerce_client.py         # thin httpx wrapper (follow_redirects, 30s timeout, safe_json_loads)
    safe_json.py             # regex-wraps ≥16-digit ints so LSST OIDs survive JSON parsing
    survey_config.py         # SURVEY_CONFIG dict + SC(survey) dispatcher — single source of truth
                             # for api_base/paths/bands/extinction_r/extra_params per survey
    classifiers.py           # tidy_classifiers: dedupe by name, merge class lists, priority-sort
    object_list.py           # build_search_params, shape_response (ZTF field remap to LSST schema)
    object_info.py           # shape_object_info (ZTF ndet/ncovhist; LSST n_det/n_non_det/n_forced)
    coordinates.py           # ra_to_hms / dec_to_dms / equatorial_to_galactic / equatorial_to_ecliptic
    other_archives.py        # external archive URL builders (ALeRCE, NED, SIMBAD, TNS, …)
    normalize.py             # ZTF mag↔nJy conversion (AB ZP 31.4) — feeds the light curve;
                             # passes through ra/dec so the position-residuals scatter can derive
                             # client-side from the LC
    probability.py           # classifier → probability list fetch + shaping for the radar panel
    coord_residuals.py       # shape_coord_residuals — programmatic API only; the UI panel derives
                             # client-side from the live LC chart (incl. cross-survey)
    crossmatch.py            # catsHTM crossmatch fetch + per-catalog row shaping
    xmatch.py                # bulk CDS XMatch (Simbad/SDSS/DESI + 11 VizieR spec-z
                             # catalogs) + NED TAP; async bulk_all() fans every catalog
                             # out concurrently (to_thread + gather, Semaphore(8)).
                             # Ported from the TNS pipeline's catalogs.py registry/normalizers
    xmatch_cache.py          # in-memory TTL cache (oid→record) warmed by the page-load
                             # prefetch; in-flight de-dup; read by the crossmatch panel + overlay
    stamps.py                # stamp picker context + per-survey stamp_url_templates_by_survey
                             # (with __OID__ + __IDENT__ placeholders so cross-survey clicks
                             # dispatch to the right survey's stamp service)
    ztf_dr.py                # ZTF DR archival cone-search (1.5″) for the LC's ZTF DR overlay
    tns.py                   # ALeRCE TNS htmx-bridge proxy (driven by /htmx/tns_lookup)
    features.py              # feature-table fetch + shape_features (per-version grouping, band labels);
                             # pick_default_version (strict N.N.N) shared with LC fold-period extractor;
                             # extract_parametric_fits (SPM / FLEET / TDE) for LC overlays
    lightcurve.py            # LC shaping + _extract_multiband_period + get_lc_fp_bundle (FP +
                             # ZTF v2 mag_corr re-merge) + get_lc_features_bundle (period + parametric
                             # fits) + get_lc_xsurvey_bundle (object_info → other-survey conesearch
                             # XSURVEY_RADIUS_ARCSEC=3.0 → matched LC + FP)
  templates/
    base.html.jinja                           # DOCTYPE shell + CSS/JS imports
    index.html.jinja                          # app shell (header, sidebar slot, main slot)
    input.html.jinja                          # shared input() macro
    search_form/                              # filter form + dependent class select
    main_table_objects/objects_table.html.jinja   # results table (rows are hx-get to /htmx/detail)
    basic_information/basicInformationPreview.html.jinja   # populated object info panel:
                             # 2-col layout (RA/Dec/MJDs | counts/flags), inline HMS/Deg toggle +
                             # copy icon (green ✓ feedback) on the RA/Dec rows; Show features +
                             # Other archives share a bottom action row; features-loading spinner
                             # uses .htmx-indicator-scoped so Back-to-results doesn't light it up.
    features/featuresTable.html.jinja         # features modal (lazy-loaded into #features-modal):
                             # version/band/filter picker, CSV download (oid_features_version_ts.csv),
                             # default version chosen via pick_default_version (strict N.N.N).
    object_detail/container.html.jinja        # detail view (back + info + LC/stamps/aladin/radar/residuals);
                             # exposes #features-modal as an empty overlay slot — the Show features
                             # button hx-get populates it, close button clears it.
    lightcurve/lightcurvePreview.html.jinja   # Chart.js light curve + cycle-button toggles + z/E(B-V) inputs;
                             # 4-loader status strip (FP, features, coords, xsurvey) that self-collapses
                             # once every loader has finished via lcMaybeHideLoadingStrip.
    lightcurve/lcFpFragment.html.jinja        # script-only deferred FP fragment → lcSetBundle
    lightcurve/lcFeaturesFragment.html.jinja  # script-only deferred features fragment → lcSetFeatures
    lightcurve/lcInfoFragment.html.jinja      # script-only deferred ra/dec fragment → lcSetCoords
    lightcurve/lcXSurveyFragment.html.jinja   # script-only deferred cross-survey fragment → lcSetCrossSurvey
    stamps/stampsPreview.html.jinja           # science/template/difference triplet (FITS for LSST, PNG for ZTF);
                             # emits both legacy data-url-template-{type} (primary, __IDENT__ swap) and
                             # data-url-template-{type}-{survey} (per-survey, __OID__ + __IDENT__ swap)
                             # so cross-survey clicks dispatch to the matching survey's stamp service.
                             # Picker dropdown labels each option as "MJD … · LSST g".
    aladin/aladinPreview.html.jinja           # Aladin Lite sky viewer + spec-z overlay chips
    radar/radarPreview.html.jinja             # classifier probability radar (Chart.js radar)
    coord_residuals/coordResidualsPreview.html.jinja  # static shell — scatter built client-side from the
                             # live LC chart's $lcRaw + $lcXRaw (no upstream fetch)
    crossmatch/crossmatchPanel.html.jinja     # catsHTM crossmatch panel body (prefetched on detail-view load)
    airmass/airmassPanel.html.jinja           # airmass curve panel (toggleAirmassPanel from basic-info)
    periodogram/periodogramPreview.html.jinja # multi-band MH-LS periodogram panel; inputs gated on the LC
                             # legend's band/survey visibility
  static/
    htmx/htmx.min.js         # self-hosted htmx 1.9.12
    chart-js/chart.umd.js    # vendored Chart.js 4.x
    chart-js/chartjs-plugin-zoom.min.js, hammer.min.js  # zoom/pan gestures
    css/tailwind.css         # @tailwind directives (source)
    css/main.css             # compiled Tailwind output (npm run build:css)
    js/helpers.js            # send_form_Data, send_pagination_data, send_classes_data;
                             # backToResults() (URL-derived: reads window.location so the detail
                             # route's HX-Push-Url acts as the source of truth, instead of the
                             # search form whose dependent class-name select can be empty on first
                             # render); #results-slot HTML cache for instant back-navigation.
    js/selection.js          # window._selectedIdentifier + Chart plugin; syncs LC↔stamps↔residuals.
                             # setSelectedIdentifier(ident, survey, oid) routes the stamps swap by
                             # survey so cross-survey clicks hit the matching survey's stamp service.
    js/lightcurve.js         # Chart.js LC + cycle-button toggles (flux/mag, diff/sci, app/abs, obs/der);
                             # per-survey markers (LSST=circle, ZTF=square; ZTF FP rotated 180° for
                             # apex-down); legend grouped by (survey, kind) with header click-to-toggle;
                             # band-visibility memory across toggles via (survey, kind, label) snapshot;
                             # lc:dataChanged + lc:visibilityChanged custom events for downstream panels;
                             # CSV export with survey/oid/candid columns + cross-survey rows.
    js/stamps.js             # FITS parsing + asinh stretch + WCS rotation for LSST stamps;
                             # updateStampsForIdentifier(ident, survey, oid) fills both __OID__ and
                             # __IDENT__ in per-survey URL templates.
    js/aladin.js             # Aladin Lite v3 bootstrap + spec-z overlays + click→z handler
    js/airmass.js            # airmass curve (Chart.js); shares grid cell with periodogram + residuals
    js/radar.js              # Chart.js radar panel
    js/coord_residuals.js    # position-residuals scatter — derives client-side from the live LC chart
                             # ($lcRaw + $lcXRaw), filters by LC dataset visibility, re-renders on
                             # lc:dataChanged / lc:visibilityChanged
    js/coords.js             # shared client-side coord parsing helpers
    js/object_nav.js         # page-of-OIDs prev/next/back nav in the global header
    js/cosmology.js          # Planck-2018 distance modulus (numeric integration)
    js/dust.js               # IRSA dust-proxy client + galactic latitude warning
    js/specz.js              # 10-catalog VizieR spec-z loader (VOTable parsing)
    js/periodogram.js        # multi-band MH-LS periodogram (chunked Cholesky-per-frequency-per-band);
                             # inputs come from the LC chart, filtered by the legend's visibility.

tests/                       # pytest; each service file has a matching test file
```

### ALeRCE API endpoints in use

- **LSST** — `https://api-lsst.alerce.online/` root (`classifier_api/classifiers`, `object_api/list_objects`, `object_api/object?survey_id=lsst&oid={oid}`). Note the flat prefix — not `api.alerce.online/lsst/v1/`.
- **ZTF** — `https://api.alerce.online/ztf/v1/` with `classifiers/`, `objects/`, `objects/{oid}`.
- Configured in `SURVEY_CONFIG`; never hard-code. ZTF's `extra_params` must drop `None` values (the API rejects them); LSST's must pin `survey=lsst`.

### Field remap quick reference

`src/services/object_list.py::_normalize_ztf_row` and `src/services/object_info.py::shape_object_info` map ZTF responses onto the LSST-style schema used by templates:

| Template field | LSST raw | ZTF raw |
|---|---|---|
| `n_det` | `n_det` | `ndet` |
| `n_non_det` | `n_non_det` | derived: `ncovhist - ndethist` |
| `n_forced` | `n_forced` | — (not present) |
| `class_name` | `class_name` | `class` |
| `classifier_name` | `classifier_name` | `classifier` |
| `classifier_version` | `classifier_version` | `step_id_corr` |
| `corrected`, `stellar` | — | `corrected`, `stellar` |

## Slice progress

- **Slice 1** — FastAPI + htmx + Jinja + Tailwind scaffold, self-hosted htmx, app shell.
- **Slice 2** — live search form with dependent classifier/class dropdowns, results table with pagination (sorted by probability DESC), calls real ALeRCE API.
- **Slice 3** — object detail view: row click → `/htmx/detail` container with back button, basic-information panel (coords/HMS/DMS, MJDs, detection counts, ZTF `corrected`/`stellar`, external archives dropdown).
- **Slice 4** — light curve (Chart.js): ZTF v1/v2 merge, forced-photometry overlay, per-band coloring, tooltip with errors, zoom/pan (`chartjs-plugin-zoom`). Cycle-button toggles collapse each projection axis into a single compact button: **Flux/Mag** (AB ZP 31.4), **Diff/Sci** (science flux only when available), **App/Abs** (Planck-2018 distance modulus via `cosmology.js`, requires z > 0), **Obs/Der** (Fitzpatrick 1999 per-band Milky-Way extinction via `dust.js`, E(B-V) auto-fetched from the IRSA proxy). Animations disabled so toggles snap.
- **Slice 5** — stamps (science/template/difference): in-browser FITS pipeline for LSST (asinh stretch, WCS rotation, N-up via CD matrix), PNG for ZTF. Cross-panel selection: clicking a point in the LC highlights the matching stamp and vice versa (`selection.js`).
- **Slice 6** — Aladin Lite sky viewer with HiPS survey chooser and 10-catalog VizieR spec-z overlay (`specz.js`: DESI DR1, SDSS DR16, SDSS DR16 QSO, 6dFGS, GAMA DR4, 2MRS, WiggleZ, zCOSMOS, VIPERS PDR2, OzDES DR1). Clicking a host-galaxy source fills the redshift input in the LC panel.
- **Post-Slice 6** — radar panel (classifier probabilities), coord-residuals panel ((Δra, Δdec) scatter), cross-panel selection synced through `window._selectedIdentifier` + Chart plugin.
- **Features modal** — `/htmx/features` endpoint + `featuresTable.html.jinja` lazy-loaded into the `#features-modal` overlay slot. Version/band/filter picker, CSV download (`{oid}_features_{version}_{timestamp}.csv`). Default version picked by the strict `N.N.N` helper (`pick_default_version`), shared with the LC fold-period extractor so the displayed `Multiband_period` and the folding period always agree. Survey-gated via `SurveyConfig.features_url_template` (LSST returns `available=False`). Spinner uses `.htmx-indicator-scoped` to avoid spurious firing during unrelated `#results-slot` requests.
- **Basic Information panel rework** — 2-column data grid, inline compact HMS/Deg toggle + copy-icon with green ✓ / red ✗ feedback on the RA/Dec rows, Show features + Other archives consolidated into a shared bottom action row. Coord-system toggle (Eq ↔ Gal ↔ Ecl) sits above the HMS/Deg button: Galactic (IAU rotation matrix, ICRS anchor) and J2000 Ecliptic (ε = 23.4392911°) are precomputed in `services/coordinates.py` and stashed on `data-gal` / `data-ecl` attrs so cycling is pure DOM; HMS/Deg is hidden outside Equatorial (sexagesimal isn't a convention for ℓ/b or λ/β).
- **Deep-link Back navigation** — `backToResults()` derives the listing URL from `window.location` (authoritative thanks to the detail route's `HX-Push-Url`) instead of reading the search form, whose dependent class-name select may not have the chosen class hydrated on first render. The result HTML is cached in `window._lastResultsHtml`; fallback calls `/htmx/list_objects` only on true deep-links.
- **Parametric-fit overlays** — SPM (Sánchez-Sáez+2021), FLEET, and TDE-tail model curves drawn over the light curve. Picker is a `<select>` in the LC toolbar with per-overlay options disabled when the object has no fit for it; a mono-font strip under the toolbar shows the per-band params (plus χ²). `extract_parametric_fits` in `services/features.py` rides the same features fetch as the Fold period and uses `pick_default_version` so the overlay can't drift away from what the Show-features modal would display. Pure client-side rendering via Chart.js line datasets, re-projected through the active Flux/Mag × App/Abs × Obs/Der × Fold state (SPM_A is in mJy → ×1e6 to our nJy axis; FLEET/TDE return mag → converted via AB ZP 31.4). Overlay choice persists through `lc_overlay=` in the URL cache. LSST has no features endpoint → `parametric_fits={}` and the picker is hidden.
- **Periodogram panel** — toggles into the position-residuals slot from the LC toolbar. Multi-band, multi-harmonic GLS (Schwarzenberg-Czerny 1996; same family as P4J's MHAOV). Inputs are the surveys/bands currently visible in the LC legend (incl. cross-survey via `$lcXRaw`); the status line lists the bands actually consumed (`LSST: g r · ZTF: g`). Selecting a peak folds the *main* LC chart via `window.lcSetFoldPeriod`. Pipeline `Multiband_period` reference line + the selected period's dashed line.
- **catsHTM crossmatch panel** — bottom-of-page collapsible (`<details>` / `<summary>`); `hx-trigger="load"` so the catsHTM call fires as the detail view renders and opening the panel is instant. `services/crossmatch.py` shapes per-catalog rows (closest match each).
- **Airmass panel** — toggleable from the basic-info "Airmass" button; shares a grid cell with periodogram + position residuals (mutually exclusive). `js/airmass.js` + `templates/airmass/airmassPanel.html.jinja`.
- **Cross-survey LC overlay** — every detail view cone-searches the *other* survey at this object's RA/Dec (3″) via `/htmx/lc_xsurvey` and overlays the matched counterpart on the same chart. See domain-trap #12 for the end-to-end plumbing (per-survey markers, legend grouping, visibility memory, stamps dispatch, position-residuals + periodogram + CSV inheritance, basic-info xsurvey link). The header reads "ALeRCE multisurvey explorer" once this lands.
- **Position residuals from live LC** — the `/htmx/coord_residuals` endpoint became a shell renderer; `js/coord_residuals.js` derives the scatter client-side from the LC chart's `$lcRaw` + `$lcXRaw`, filters by LC dataset visibility, and re-renders on `lc:dataChanged` / `lc:visibilityChanged`. Marker shape mirrors the LC (LSST=circle, ZTF=square).
- **Bulk CDS/NED crossmatch prefetch** — at each results-page render (or, for an
  OID-list search, the whole list at once via `all_positions`) a fire-and-forget
  `POST /htmx/xmatch_prefetch` bulk-crossmatches every object against the CDS XMatch
  catalogs (Simbad, SDSS DR16, DESI DR1 + 11 VizieR spec-z catalogs) **and** NED TAP,
  concurrently, warming `services/xmatch_cache.py` (in-memory, TTL 1h, oid-keyed,
  in-flight de-dup). The detail-view **catsHTM panel folds in** the cached CDS/NED
  summary (best spec-z + source + sep, SIMBAD type, per-catalog counts + cards), and
  the Aladin **spec-z overlay reads from the cache** via `GET /api/xmatch_overlay`
  (`specz.js` no longer queries VizieR per object from the browser). Registry +
  normalizers ported nearly verbatim from the ALeRCE TNS pipeline
  (`../TNS_report/alerce_tns_project/alerce_tns/clients/catalogs.py`). Adds the
  `astroquery` + `pyvo` deps (astropy transitive). Cache is runtime-only.
- **Deferred** — name resolver.
