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
| `GET /htmx/lc_gp` | **Lazy** multi-band GP overlay fragment (only when the GP overlay is picked; `fold_period`/`science` follow display mode; → `lcSetGp`) |
| `GET /htmx/tns_lookup` | Deferred TNS panel + OOB redshift inject into the LC redshift input |
| `GET /htmx/stamps` | Stamp picker + per-survey URL templates (`__OID__` + `__IDENT__` placeholders) so cross-survey clicks dispatch correctly |
| `GET /htmx/coord_residuals` | Position-residuals **shell** — scatter is built client-side from the live LC; endpoint just renders the canvas + `data-lc-target` |
| `GET /htmx/crossmatch` | catsHTM crossmatch panel body (prefetched on detail-view load) + the cached CDS/NED section, or a poll shell if the bulk crossmatch is still running |
| `GET /htmx/crossmatch_progress` | Self-re-polling (`load delay:900ms`) per-catalog progress checklist + growing partial match table; swaps itself for the terminal section once the cache record lands |
| `POST /htmx/xmatch_prefetch` | Fire-and-forget cache warm for a page of `{oid, ra, dec}` — **always 204** |
| `GET /htmx/avro` | ZTF AVRO alert metadata modal for one detection (ZTF-only; LSST renders an explanatory message) |
| `GET /htmx/airmass` | Airmass curve panel (shares grid cell with periodogram + residuals) |
| `GET /htmx/probability` | Classifier-probability radar |
| `GET /htmx/aladin` | Aladin sky-view panel, seeded with ra/dec/lastmjd from `object_info` |
| `GET /htmx/list_magstats` | `hx-swap-oob` spans filling the results table's Peak/Mean mag cells from one bulk TAP query |

REST endpoints (`src/routes/rest.py`, all under `/api`, JSON):

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/ztf_dr` | ZTF DR archival cone-search (default 1.5″, max 60″) for the LC's ZTF DR overlay |
| `GET /api/xmatch_overlay` | Cached CDS/NED overlay markers for Aladin (`specz.js` no longer queries VizieR from the browser) |
| `GET /api/lsst_neighbors` | LSST objects within 10′ and ±2 h of `lastmjd` — contemporaneous-neighbour overlay |
| `GET /api/stamp_center` | CRPIX of the alert inside a cutout clipped at a detector edge; **always 200**, `available:false` when not applicable (LSST) or unavailable. Trap #18 |
| `POST /api/ux_events` | rrweb session-replay beacon sink; **always 204**, no-ops unless `ANALYTICS_ENABLED` |

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
    - **Stamps dispatch**: server emits `data-url-template-{type}-{survey}` with `__OID__` + `__IDENT__` placeholders for both surveys. `setSelectedIdentifier(ident, survey, oid)` and `updateStampsForIdentifier(ident, survey, oid)` thread the click's survey + correct OID (primary OID for in-survey clicks, `chart.$lcXOid` otherwise) so cross-survey clicks reach the matching survey's stamp service. Every picker `<option>` (primary + cross) carries `data-survey`/`data-oid`, and the `<select>` onchange routes through `onStampsPickerChange` which reads them so the picked epoch dispatches to the right survey regardless of group.
    - **Cross-survey picker**: the `<select>` is server-rendered from the primary survey only; when the cross-survey bundle lands, `lcSetCrossSurvey` extracts the matched survey's stamped detections (`has_stamp && identifier`, MJD DESC, UTC via `mjdToUtcString`) and hands them to `stamps.js::setCrossSurveyStampOptions`, which wraps the primary options in a survey-labeled `<optgroup>` and appends a second `<optgroup>` for the cross survey (each option tagged with the matched survey + `chart.$lcXOid`). Idempotent + re-runnable; stashed so a stamps panel that swaps in *after* the cross-survey fragment resolved still picks it up on init (`applyPendingXStampOptions`), guarded by `panel.dataset.oid` so a stale stash can't smear onto a new object. No optgroup wrapping happens when there's no crossmatch (flat picker preserved).
    - **Position residuals derive from the live LC** (`coord_residuals.js` walks `$lcRaw` + `$lcXRaw`, filters by LC dataset visibility, re-renders on `lc:dataChanged` / `lc:visibilityChanged` custom events fired from `applyModes` and the legend `onClick`). The endpoint is now a shell renderer; `shape_coord_residuals` stays for programmatic use.
    - **Periodogram inputs** are gated the same way: `getDetDataByBand` reads from both `$lcRaw` and `$lcXRaw`, skips bands hidden via the LC legend, and the status line lists the bands actually consumed (`LSST: g r · ZTF: g`).
    - **CSV export** carries `survey`, `oid`, `candid` columns plus cross-survey rows; `oid` and `candid` are double-quoted so 64-bit LSST ids stay string-typed in pandas/Excel.
13. **MJD time scale is per-survey** — LSST alerts carry `midpointMjdTai` (atomic time); ZTF MJDs are UTC. Any conversion to a calendar string must subtract the current TAI − UTC offset for LSST, or it will mislabel TAI as UTC and be 37 s off (current as of 2017-01-01; bump on the next leap second). Multiple brokers initially shipped this bug — see [community.lsst.org "Question about midpointMjdTai to UTC conversion in recent Rubin alerts"](https://community.lsst.org/t/question-about-midpointmjdtai-to-utc-conversion-in-recent-rubin-alerts/11976). The scale lives on `SurveyConfig.mjd_scale` (`"tai"` / `"utc"`) and the constant on `services/survey_config.py::TAI_MINUS_UTC_SECONDS`. Two converters consume it:
    - `services/stamps.py::_mjd_to_utc(mjd, scale)` — stamps picker dropdown (`"MJD … (YYYY-MM-DD HH:MM:SS UTC) · band"`).
    - `static/js/lightcurve.js::mjdToUtcString(mjd, survey)` — LC tooltip; picks the scale from `ctx.dataset.$survey`.
    - **Not** applied to the search form's `firstmjd_min/max` (`coords.js::smartDateToMJD`): the filter is calendar-day granularity, so the 37 s offset is below user-visible precision. Raw MJD displays (basic-info first/last MJD, LC X-axis ticks) stay unconverted on purpose — they're labeled "MJD", not "UTC".
    - The two TAI offset constants (Python + JS) must move together on the next leap second; grep for `TAI_MINUS_UTC_SECONDS`.
14. **Multi-band Gaussian Process (`services/gp.py`)** — one joint GP over `(time, wavelength)`, not an ICM coregionalization matrix: `B[b,b'] = exp(-½(λ_b-λ_b')²/ℓ_λ²)` makes `k_t·k_λ` exactly one anisotropic 2-D RBF, so sklearn learns `(ℓ_t, ℓ_λ, σ_f)` and ugrizy+gr costs one extra hyperparameter. Traps:
    - λ is carried in units of 1000 Å so ℓ_λ shares an optimiser scale with ℓ_t in days.
    - **Two standardization regimes**, switched by `per_band_scale` (caller sets it to `use_science`): per-band mean/σ for science flux and folded fits; global zero-anchored (mean pinned at 0, pooled RMS about zero) for **difference** flux — diff flux has a physical zero and per-band centering would break "all bands → 0".
    - Reported `sigma_f`/`jitter` are dimensionless (fractions of the band scatter); `l_t_days` is days in time mode but **cycles** when folded.
    - Folded mode tiles the data ×3 (phase−1, phase, phase+1) so the RBF wraps the 0/1 boundary — which is why the point budget drops to `max_points//3` and the phase length-scale is capped at `(0.02, 0.3)`.
    - Cost guards: `_MAX_POINTS=800` with uniform per-band thinning (Cholesky is O(N³) per likelihood eval), `_EFLUX_FLOOR=1e-3` nJy so a zero error can't blow up `alpha`.
    - `cov_offdiag` (same-time band-band covariances, keys `"<band>|<band>"` **sorted lexicographically**) is best-effort — a failure yields `{}` and the mean curves still ship. `color_evolution.js` needs it for honest colour errors.
    - Caller side (`lightcurve.py`): ZTF g and LSST g are **pooled into one band before the fit** (the wavelength axis only carries distinct filters), and FP is windowed to `GP_FP_WINDOW_DAYS = 30.0` around the detection span.
    - Client side, the fetch is keyed per *variant* (`gpDesiredKey`: `"diff"` / `"sci"` / `"fold:<period>"`) and `lcSetGp` attributes a response to **its own** key rather than a shared loading flag — otherwise a folded fit landing after the user unfolds gets plotted on the time axis.
15. **LSST neighbours query ordering (`services/lsst_neighbors.py`)** — upstream `list_objects` defaults to `probability DESC`, which full-scans (blows the 30 s httpx ceiling on dense fields) **and silently ignores the `lastmjd: [lo,hi]` filter**. Passing `order_by=lastmjd, order_mode=DESC` fixes both; `_PAGE_SIZE=100` (200 times out). Upstream also returns the same oid once per classifier, so `filter_neighbors` dedupes — otherwise the overlay double-marks. The query always hits the **LSST** endpoint regardless of the detail view's survey.
16. **Deterministic offline e2e via `services/replay.py`** — Playwright runs need no network: `maybe_install()` monkey-patches `httpx.AsyncClient.__init__` with `kwargs.setdefault("transport", …)`, which works only because every upstream call goes through `AsyncClient` and none passes its own transport (so the FastAPI TestClient stays untouched). `EXPLORER_REPLAY_DIR` alone = replay; `+ EXPLORER_RECORD=1` = record. A replay miss returns a loud **HTTP 599** naming the URL to record rather than an empty body. Only `content-type` and `location` headers are stored — `location` specifically so ZTF's 308 bare-path redirect stays replayable.
17. **Analytics is opt-in and adversarially named** — `POST /api/ux_events` **always answers 204**, even when disabled or unparseable, so the browser never retries and the response never leaks whether collection is on. The endpoint and the vendored bundle avoid the substrings "analytics"/"rrweb" (Brave/uBlock filter lists match on them); server-side Python keeps the clear naming. Client honors DNT/GPC. The client-supplied `identity` block is persisted **verbatim and untrusted** — see `TODO(login)` in `analytics.py`, which must be re-derived server-side once auth exists or a data-rights tier can be spoofed.
18. **Stamp cutouts are not always centred on the alert** — a survey carves a fixed-size cutout around the alert, so an alert within half a cutout of a **detector edge** comes back truncated and *off-centre*. `blitStampCanvas` therefore anchors the **WCS reference pixel (CRPIX)** at the canvas centre, never the image's geometric centre. Traps:
    - The centre crosshair is plain CSS at 50%/50% of the canvas box. It is correct **because** the renderer puts CRPIX there — the fix is to move the image, not the crosshair. Anchoring this way also makes zoom and rotation happen *about the alert*, so it stays put at every zoom level.
    - `stampAnchor` reduces exactly to `(nx/2, ny/2)` when CRPIX is the geometric centre, so unclipped stamps render bit-identically to the pre-fix build. Keep that property — it's the regression lock in `tests-js/stamps_center.test.js`.
    - Fit-to-canvas uses the **anchor-symmetric half-extent**, not `outSize/max(nx,ny)`, so a clipped cutout gains black padding on the truncated side instead of sliding sideways.
    - **LSST needs nothing extra**: its stamps carry a real WCS whose CRPIX is already right when clipped. **ZTF stamps carry no WCS at all**, so `services/stamp_center.py` reconstructs CRPIX from the alert's CCD-quadrant position (`candidate.xpos`/`ypos` via the avro service — these are *not* in the detections payload) plus `SurveyConfig.stamp_full_size` (63) and `detector_shape` (3072×3080, a ZTF *quadrant*, not a full CCD).
    - The quadrant shape is an assumption about ZTF hardware, not something read from the data. The client therefore **self-checks** the reconstructed size against the received `NAXIS` and falls back to the geometric centre on mismatch — so a wrong convention degrades instead of shifting by a wrong amount. Keep that check.
    - The lookup is **lazy**: only a cutout smaller than nominal on some axis can be clipped, so the common path costs no request; the three canvases of an epoch share one memoised promise.
    - `augmentZTFStampWCS` must anchor on the **selected detection's** ra/dec (carried on the picker `<option>`s), *not* the object's `meanra`/`meandec`. Using the mean is what made the Aladin footprint polygon disagree with the pixels — negligible for a static source, large for a mover.
    - **Both synthesised ZTF CD terms are negative**: RA decreases with column (E-left, conventional) and **Dec decreases with row** (empirical — solved by matching stamp stars against Gaia DR3 on `ZTF23aajoiiz` candid `3143207742215010000`: `CD2_2 < 0` gives 8 matches at 0.47 px, `CD2_2 > 0` gives 1). A wrong Dec sign mirrors the Aladin footprint vertically about the alert — invisible on an unclipped cutout, since the rectangle is symmetric, but it puts the padding on the wrong side of a y-clipped one.
    - The synthesis runs *after* `buildStretchedSrcCanvas`, and `northAngle`/`flipY` are derived from the RAW header (empty for ZTF) and cached, so the synthesised WCS never reaches the display path — it only drives the footprint and scale bar. **If you move the synthesis earlier**, `computeNorthAngle` will return π for ZTF and rotate every stamp 180°: it reads the Dec direction in FITS pixel space without accounting for the canvas row flip, and the two errors only cancel while `CD2_2 > 0`. Fix that function before moving the call.
    - Reference case: `ZTF26abngxfo` candid `3510493201915015030` → 48×63 cutout, source at FITS (31.63, 32.21), geometric centre (24.50, 32.00) — a 7.1 px ≈ 7.1″ error. Its sibling candid `3509496196315015007` is 63×63 and unclipped: the regression control.

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

# Tier 1 — pytest (421 tests: services + route fragments; upstream calls monkeypatched)
python3 -m pytest           # full suite
python3 -m pytest tests/test_object_info.py -v   # single file
python3 -m pytest -k "detail"                     # by keyword

# Tier 2 — vitest over the client JS (164 tests, jsdom)
npm run test:js             # single run
npm run test:js:watch

# Tier 3 — Playwright e2e (8 specs / 11 tests) against a replay-backed server
npm run test:e2e
npm run test:e2e:ui

# Dev server (hot-reload templates via auto_reload=True)
poetry run uvicorn src.app:app --reload --port 8000

# Tailwind (rebuild main.css from tailwind.css)
npm run watch:css           # dev
npm run build:css           # minified production build
```

Tiers 1 and 2 run offline — upstream ALeRCE calls are monkeypatched in `tests/test_routes.py` via `src.routes.htmx.<service>.<fn>` attribute paths. Tier 3 runs offline too, but through `services/replay.py` (`EXPLORER_REPLAY_DIR` → JSON fixtures in `tests-e2e/fixtures/upstream/`, re-record with `EXPLORER_RECORD=1`); see domain trap #16.

All three commands run green as written; the counts above are real runs, not source counts. CI (`.github/workflows/tests.yml`) runs the same three tiers as separate jobs — **check it before merging**, since it catches things a local run can miss (see below).

**Two environment hazards, both now handled in-repo — don't "clean them up":**

- `pyproject.toml` sets `addopts = "-p no:zarr"`. The zarr pytest plugin is unrelated to this project and only appears when the interpreter shares a venv with something that uses it; built against numpy ≥ 2, it aborts **collection** for the whole suite on a numpy 1.x install (`AttributeError: module 'numpy.dtypes' has no attribute 'StringDType'`). `-p no:zarr` is a no-op where zarr isn't installed, so it is safe in CI and in a clean venv.
- `routes/htmx.py` builds its own `jinja2.Environment` and passes it as `Jinja2Templates(env=...)` rather than `Jinja2Templates(directory=..., autoescape=True, auto_reload=True)`. Starlette 1.0 removed the `**env_options` passthrough, so the kwargs form raises `TypeError` on any recent install (this repo has been seen with Starlette 1.4.1 against a `poetry.lock` pinning 0.46.2). `env=` has existed since 0.35 and Starlette still runs `_setup_env_defaults()` on a supplied env, so one code path covers both. **`autoescape=True` there is load-bearing** — Starlette's default is `jinja2.select_autoescape()`, which keys off the file extension and returns **False** for our `*.html.jinja` names, i.e. dropping it silently disables HTML escaping across every fragment.

Historical note worth remembering: before that second fix, `tests/test_routes.py`, `tests/test_xmatch.py` and `tests/test_analytics.py` failed at *import*, so ~140 tests silently never ran locally while still passing in CI. If a local suite looks suspiciously green, check for collection errors, not just the pass count.

## Repository layout

```
src/
  app.py                     # FastAPI(), CORS, static mount, router includes
  routes/
    htmx.py                  # HTMLResponse endpoints (search form, list, detail, object info, classes select,
                             # LC deferred fragments, stamps, avro, crossmatch + progress poll, features)
    rest.py                  # JSON endpoints (/api/health, /api/ztf_dr, /api/xmatch_overlay,
                             # /api/lsst_neighbors, /api/stamp_center, /api/ux_events)
  services/
    alerce_client.py         # thin httpx wrapper (follow_redirects, 30s timeout, safe_json_loads)
    safe_json.py             # regex-wraps ≥16-digit ints so LSST OIDs survive JSON parsing
    survey_config.py         # SURVEY_CONFIG dict + SC(survey) dispatcher — single source of truth
                             # for api_base/paths/bands/extinction_r/extra_params per survey
    classifiers.py           # tidy_classifiers: dedupe by name, merge class lists, priority-sort
    object_list.py           # build_search_params, shape_response (ZTF field remap to LSST schema)
    magstats.py              # bulk peak-diff / mean-total magnitude for the results table via one
                             # TAP query per page (tap.alerce.online/tap/sync, plain httpx GET,
                             # FORMAT=json). ZTF: ztf.magstat (fid; diff=magmin, total=magmean_corr);
                             # LSST: alerce_tap.lsst_dia_object (diff={b}_psffluxmax,
                             # total={b}_sciencefluxmean) → mag via AB ZP 31.4. Total is a MEAN on
                             # both surveys (honest — LSST stores no science max). Guards the
                             # VOTable-XML error body TAP returns even under FORMAT=json
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
    xmatch.py                # bulk CDS XMatch + NED TAP, generalized beyond redshift
                             # into use-case categories (stellar / host / AGN). Catalogs:
                             # Simbad/SDSS/DESI + 11 VizieR spec-z (host) + Gaia DR3 & VSX
                             # (stellar, 3") + Milliquas, Véron-Cetty, SDSS-QSO (AGN, 3") +
                             # HyperLEDA (host, 60") + NED. Each match carries category +
                             # display fields + `signals`; _build_object_record emits an
                             # ordered match list (stars→AGN→host), per-category
                             # classification hints, and a category-coloured sky overlay.
                             # async bulk_all() fans every catalog out (to_thread + gather,
                             # Semaphore(8)). "Galactic" hint requires a parallax/PM ≥5σ
                             # astrometric signature, not variability alone
    xmatch_cache.py          # in-memory TTL cache (oid→record) warmed by the page-load
                             # prefetch; in-flight de-dup; read by the crossmatch panel + overlay
    xmatch_progress.py       # per-oid progress state for the ~20-catalog bulk crossmatch —
                             # done/failed/pending checklist + accumulated partial matches +
                             # stashed catsHTM markers (the poll route doesn't re-fetch catsHTM).
                             # The authoritative "done" signal is the cache record landing, NOT
                             # `finished`, so a lost entry (restart) can't wedge the poll.
                             # No locking — all mutations happen on the event loop
    stamps.py                # stamp picker context + per-survey stamp_url_templates_by_survey
                             # (with __OID__ + __IDENT__ placeholders so cross-survey clicks
                             # dispatch to the right survey's stamp service). Picker rows also
                             # carry per-alert ra/dec (anchors the synthesised ZTF WCS) and the
                             # context carries stamp_full_size_by_survey (clipped-cutout probe)
    stamp_center.py          # reconstructs the alert's CRPIX inside a cutout clipped at a
                             # detector edge, from the AVRO candidate.xpos/ypos plus
                             # SurveyConfig.stamp_full_size / detector_shape. ZTF-only in
                             # practice (LSST stamps carry a real WCS and short-circuit before
                             # any HTTP call); every failure degrades to available=False. Trap #18
    ztf_dr.py                # ZTF DR archival cone-search (1.5″) for the LC's ZTF DR overlay
    tns.py                   # ALeRCE TNS htmx-bridge proxy (driven by /htmx/tns_lookup)
    features.py              # feature-table fetch + shape_features (per-version grouping, band labels);
                             # pick_default_version (strict N.N.N) shared with LC fold-period extractor;
                             # extract_parametric_fits (SPM / FLEET / TDE) for LC overlays
    lightcurve.py            # LC shaping + _extract_multiband_period + get_lc_fp_bundle (FP +
                             # ZTF v2 mag_corr re-merge) + get_lc_features_bundle (period + parametric
                             # fits) + get_lc_xsurvey_bundle (object_info → other-survey conesearch
                             # XSURVEY_RADIUS_ARCSEC=3.0 → matched LC + FP) + get_lc_gp_bundle
                             # (pools ZTF g with LSST g, windows FP to ±30 d, calls gp.fit_multiband_gp)
    gp.py                    # multi-band Gaussian Process over (time, wavelength) → per-band
                             # posterior flux mean ±1σ on a common grid + band-band cross-covariances
                             # for the colour panel's error propagation. See domain trap #14
    avro.py                  # ZTF AVRO alert metadata (avro.alerce.online/get_avro_info) flattened
                             # into a sorted (name, value) table; ZTF-only — LSST short-circuits with
                             # available=False before any HTTP call. Every failure mode returns a
                             # human-readable `reason`, never a 500 in the fragment
    lsst_neighbors.py        # contemporaneous-neighbour cone-search (10′, ±2 h of lastmjd) for
                             # movers/trails; always queries LSST regardless of survey. Trap #15
    analytics.py             # sink for the rrweb beacons — one JSON line per batch appended to a
                             # gzipped daily log (logs/analytics/YYYY-MM-DD.jsonl.gz), off unless
                             # ANALYTICS_ENABLED, salted-hash IP only. Trap #17
    replay.py                # record/replay httpx transport for deterministic offline Playwright
                             # runs (EXPLORER_REPLAY_DIR / EXPLORER_RECORD). Trap #16
  templates/
    base.html.jinja                           # DOCTYPE shell + CSS/JS imports; the analytics
                                              # scripts are only emitted when ANALYTICS_ENABLED
    index.html.jinja                          # app shell (header, sidebar slot, main slot)
    input.html.jinja                          # shared input() macro
    _panel_help.html.jinja                    # shared (?) tooltip macro used by 9 panels
    search_form/                              # filter form + dependent class select
    main_table_objects/objects_table.html.jinja   # results table (rows are hx-get to /htmx/detail);
                             # Peak mag / Last mag cells render as "…" placeholders + a hidden
                             # #magstats-loader (hx-trigger=load) that fetches /htmx/list_magstats
    main_table_objects/magstats_oob.html.jinja    # hx-swap-oob spans that fill the Peak diff mag /
                             # Mean tot mag cells by id (peakdiff-{oid} / meantot-{oid}); "—" absent
    basic_information/basicInformationPreview.html.jinja   # populated object info panel:
                             # 2-col layout (RA/Dec/MJDs | counts/flags), inline HMS/Deg toggle +
                             # copy icon (green ✓ feedback) on the RA/Dec rows; Show features +
                             # Other archives share a bottom action row; features-loading spinner
                             # uses .htmx-indicator-scoped so Back-to-results doesn't light it up.
    features/featuresTable.html.jinja         # features modal (lazy-loaded into #features-modal):
                             # version/band/filter picker, CSV download (oid_features_version_ts.csv),
                             # default version chosen via pick_default_version (strict N.N.N).
    object_detail/container.html.jinja        # detail view (back + info + LC/stamps/aladin/radar/residuals);
                             # exposes #features-modal and #avro-modal as empty overlay slots — the
                             # Show features / AVRO buttons hx-get populate them, close clears them.
                             # Also owns the drag-to-resize row handles (bindRowResize), persisted
                             # in sessionStorage as {row1,row2} px; double-click resets and forgets.
    lightcurve/lightcurvePreview.html.jinja   # Chart.js light curve + cycle-button toggles + z/E(B-V) inputs;
                             # 4-loader status strip (FP, features, coords, xsurvey) that self-collapses
                             # once every loader has finished via lcMaybeHideLoadingStrip. The GP is
                             # deliberately NOT one of the four loaders (it's lazy, fetched on demand).
    lightcurve/lcFpFragment.html.jinja        # script-only deferred FP fragment → lcSetBundle
    lightcurve/lcFeaturesFragment.html.jinja  # script-only deferred features fragment → lcSetFeatures
    lightcurve/lcInfoFragment.html.jinja      # script-only deferred ra/dec fragment → lcSetCoords
    lightcurve/lcXSurveyFragment.html.jinja   # script-only deferred cross-survey fragment → lcSetCrossSurvey
    lightcurve/lcGpFragment.html.jinja        # script-only lazy GP fragment → lcSetGp (does not touch
                             # the loading strip)
    stamps/stampsPreview.html.jinja           # science/template/difference triplet (FITS for LSST, PNG for ZTF);
                             # emits both legacy data-url-template-{type} (primary, __IDENT__ swap) and
                             # data-url-template-{type}-{survey} (per-survey, __OID__ + __IDENT__ swap)
                             # so cross-survey clicks dispatch to the matching survey's stamp service.
                             # Picker dropdown labels each option as "MJD … · LSST g".
    aladin/aladinPreview.html.jinja           # Aladin Lite sky viewer + spec-z overlay chips
    avro/avroTable.html.jinja                 # AVRO candidate-field modal (into #avro-modal)
    radar/radarPreview.html.jinja             # classifier probability radar (Chart.js radar)
    coord_residuals/coordResidualsPreview.html.jinja  # static shell — scatter built client-side from the
                             # live LC chart's $lcRaw + $lcXRaw (no upstream fetch)
    color_evolution/colorEvolutionPreview.html.jinja  # colour-vs-time + colour-colour panel derived from
                             # the GP posterior; takes over the residuals grid cell when GP is selected
    tns/tnsLookupFragment.html.jinja          # deferred TNS row + auto-fill of the LC redshift input
    crossmatch/crossmatchPanel.html.jinja     # catsHTM crossmatch panel body (prefetched on detail-view load)
    crossmatch/xmatchProgress.html.jinja      # pending branch — self-re-polls every 900 ms
    crossmatch/xmatchSection.html.jinja       # terminal branch once the cache record lands
    crossmatch/_xmatchMatches.html.jinja      # hint banner + stars→AGN→host table, SHARED by the partial
                             # and terminal branches so growing and final markup can't diverge
    crossmatch/_xmatchAladinButton.html.jinja # "Show all in sky view" → window.showAllCrossmatchInAladin
    airmass/airmassPanel.html.jinja           # airmass curve panel (toggleAirmassPanel from basic-info)
    periodogram/periodogramPreview.html.jinja # multi-band MH-LS periodogram panel; inputs gated on the LC
                             # legend's band/survey visibility
  static/
    htmx/htmx.min.js         # self-hosted htmx 1.9.12
    chart-js/chart.umd.js    # vendored Chart.js 4.x
    chart-js/chartjs-plugin-zoom.min.js, hammer.min.js  # zoom/pan gestures
    vendor/recorder/recorder.min.js  # vendored rrweb 2.0.0-alpha.4 (record build only), deliberately
                             # NOT named rrweb-* — filter lists substring-match the real name
    img/alerce-logo.svg
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
                             # lc:dataChanged + lc:visibilityChanged + lc:gpChanged custom events for
                             # downstream panels; CSV export with survey/oid/candid columns +
                             # cross-survey rows. Also hosts two Chart.js plugins: errorBarPlugin and
                             # drHistogramPlugin (the ZTF DR marginal histogram strip — bins the DR
                             # datasets already on the chart through the live Y scale, so it re-bins
                             # under pan/zoom and can't disagree with what's plotted; each band column
                             # normalised to its OWN peak; ▼/▲ mark the series extremes; toggled by a
                             # synthetic legend row inside the ZTF DR group). GP overlay handling —
                             # ensureGpLoaded / gpDesiredKey / lcSetGp — is trap #14.
                             # Public read API for other panels: lcGetChart, lcGpState, lcGpActive.
    js/stamps.js             # FITS parsing + asinh stretch + WCS rotation for LSST stamps;
                             # updateStampsForIdentifier(ident, survey, oid) fills both __OID__ and
                             # __IDENT__ in per-survey URL templates. blitStampCanvas anchors the
                             # WCS reference pixel (CRPIX) at the canvas centre — NOT the image's
                             # geometric centre — so an edge-clipped cutout still puts the alert
                             # under the crosshair; stampAnchor / stampFitScale hold that geometry
                             # and maybeRecoverClippedCenter does the lazy CRPIX lookup. Trap #18
    js/aladin.js             # Aladin Lite v3 bootstrap + spec-z overlays + click→z handler;
                             # position-based provisional survey + background HiPS probe/swap;
                             # honors host.dataset.torndown so an in-flight boot self-aborts;
                             # also draws the stamp footprint (applyStampFootprint) and the
                             # contemporaneous LSST-neighbour overlay (loadLsstNeighbors)
    js/detail-cleanup.js     # detail-view teardown — destroys every Chart.js chart
                             # (via Chart.getChart) + Aladin instance ($aladin.destroy(),
                             # torndown flag) before #results-slot is swapped away, so
                             # navigating objects doesn't leak them. Wired to htmx:beforeSwap
                             # on #results-slot + window.teardownDetailView() (called from
                             # backToResults before its direct-innerHTML cache restore).
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
    js/color_evolution.js    # colour-vs-time (±1σ bands) + colour-colour scatter with 1σ error
                             # ELLIPSES and a viridis time colourbar, both derived from the GP
                             # posterior. Errors use the full band-band covariance (gp.cov_offdiag),
                             # so a shared band (r in g−r vs r−i) correctly tilts the ellipse.
                             # Deliberately does not import lightcurve.js — reaches the chart at
                             # runtime via window.lcGetChart / lcGpState to avoid load-order coupling.
    js/panel_help.js         # positions the (?) tooltip cards; they must be position:fixed because
                             # the detail grid rows use overflow:hidden for the resize handles, so
                             # top/left are computed in JS. Delegated capture-phase mouseover/focusin
                             # so htmx-swapped fragments need no rebinding.
    js/scroll_shield.js      # mobile-only (pointer: coarse) tap-to-interact overlay on touch-trapping
                             # panels, so a vertical swipe scrolls the page instead of panning a chart
                             # or the Aladin map. Tap-vs-scroll is discriminated by listening for
                             # `click` (browsers suppress it after a scroll-drag). One panel armed at
                             # a time; re-scans on htmx:afterSettle and prunes detached shields.
    js/ux_recorder.js        # rrweb recorder → batched sendBeacon → POST /api/ux_events.
                             # recordCanvas:false, mousemove ~20 Hz, honors DNT/GPC + an opt-out key;
                             # identity read through the overridable window.analyticsIdentity() hook
                             # (the seam for the planned login / data-rights tiers). Trap #17

tests/                       # pytest (421) — each service file has a matching test file
tests-js/                    # vitest + jsdom (164) over the client JS modules
tests-e2e/                   # Playwright specs (8) + upstream replay fixtures; run offline
                             # through services/replay.py
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
- **Peak-diff / mean-tot mag columns** — two `col-mobile-hide` columns in the results table
  filled lazily out-of-band: the table paints with `…` placeholders, then a single hidden
  `#magstats-loader` (`hx-trigger="load"`) fires ONE bulk TAP query per page
  (`WHERE oid IN (...)` against `tap.alerce.online/tap/sync`, plain httpx GET,
  `FORMAT=json`) via `GET /htmx/list_magstats`, whose response is `hx-swap-oob` spans
  that drop into each row's `peakdiff-{oid}` / `meantot-{oid}` cell. Two magnitudes are shown
  because the relevant one is object-dependent: the **difference** peak matters for transients,
  the **total / apparent** brightness for stars & variables. The total is reported as a **mean**
  (not a peak) so the label is honest on both surveys — LSST stores no per-band science maximum,
  only a mean. `services/magstats.py` builds the ADQL, parses the JSON (guarding the VOTable-XML
  error body TAP returns even under `FORMAT=json`), and reduces per object (brightest-across-bands,
  each with its band letter). **ZTF** uses `ztf.magstat` (per-band `fid`; diff = `magmin`,
  mean total = `magmean_corr`, null when `corrected` is false) — NOT `alerce_tap.magstat` (whose
  integer internal oids don't match ZTF names). **LSST** uses `alerce_tap.lsst_dia_object`: diff =
  brightest `{b}_psffluxmax`, mean total = brightest `{b}_sciencefluxmean` → mag via the AB ZP
  (31.4). Any TAP failure degrades to `—` cells; both search paths (generic + OID-list) inherit
  the columns.
- **ZTF DR marginal histogram strip** — a vertical strip right of the LC plot area, one column per
  visible ZTF DR band, binning that band's brightness distribution along the **Y** axis (flux or
  mag, whichever is plotted). Implemented as `drHistogramPlugin` in `lightcurve.js` (ported from
  alerce-hunter). Bins are laid out through the chart's own Y scale so the strip re-bins under
  pan/zoom; the source is the DR *datasets already on the chart* (so it can't disagree with what's
  plotted, and it self-hides in Diff mode where DR yields nothing). Each column is normalised to its
  own peak (band epoch counts differ ~5×), ▼/▲ mark the series extremes with direction keyed off
  `y.options.reverse`, and a synthetic legend row inside the ZTF DR group toggles it.
- **Multi-band Gaussian Process overlay** — `/htmx/lc_gp` + `services/gp.py`: one joint GP over
  (time, wavelength) giving per-band posterior flux ±1σ, drawn as a mean line plus a shaded 2σ
  envelope re-projected through the live Flux/Mag × App/Abs × Obs/Der × Fold state. Fetched
  **lazily** and keyed per variant (`diff` / `sci` / `fold:<period>`) so a late-arriving folded fit
  can't land on a time axis. See domain trap #14.
- **Colour-evolution panel** — colour-vs-time with ±1σ bands and a colour-colour scatter with 1σ
  error *ellipses* over a viridis time colourbar, both derived from the GP posterior; errors use the
  full band-band covariance (`gp.cov_offdiag`), so ellipses tilt correctly when two colours share a
  band. Takes over the residuals grid cell while the GP overlay is selected (yielding to periodogram
  / airmass), with a dual-handle time-window slider that re-windows in place.
- **AVRO metadata viewer** — `/htmx/avro` + `services/avro.py` flattens the ZTF alert's `candidate`
  block into a sorted table in an `#avro-modal` overlay, launched per detection from the stamps
  panel. ZTF-only: LSST short-circuits with an explanatory message before any HTTP call.
- **Contemporaneous LSST neighbours** — `GET /api/lsst_neighbors` (10′, ±2 h of `lastmjd`) plotted
  as grey squares in Aladin for spotting movers/trails; always queries LSST regardless of the
  detail view's survey. The upstream ordering trap is #15.
- **Crossmatch progress + bounded timeouts** — the bulk CDS/NED crossmatch now reports itself while
  running: `/htmx/crossmatch` returns a poll shell, `/htmx/crossmatch_progress` self-re-polls every
  900 ms rendering a per-catalog done/failed/pending checklist plus a *growing* match table, and
  swaps itself for the terminal section once the cache record lands. Per-catalog failures surface as
  an amber "N catalogs unavailable" note so a sparse result reads differently from a broken one.
- **Stamp footprint in Aladin** — the current stamp's WCS corners are drawn as a graphic overlay on
  the sky view (`applyStampFootprint`), replayed if the Aladin boot finishes after the stamp loads.
- **Panel help + mobile scroll shield** — a shared `(?)` tooltip macro across 9 panels
  (`_panel_help.html.jinja` + `panel_help.js`), and a coarse-pointer-only tap-to-interact shield
  over touch-trapping plot areas so mobile swipes scroll the page instead of panning charts.
- **Session-replay analytics** — rrweb → batched `sendBeacon` → `POST /api/ux_events` → gzipped
  daily JSONL under `logs/analytics/`. Off unless `ANALYTICS_ENABLED`; honors DNT/GPC; anonymous
  UUIDs and a salted IP hash only. See trap #17 and the `TODO(login)` seam.
- **Test tiers** — the suite is now three tiers: pytest over services + route fragments, vitest +
  jsdom over the client JS modules, and Playwright e2e driven against a replay-backed server
  (`services/replay.py`), so the interaction features have automated coverage too.
- **Name resolver** — done: `coords.js` calls the CDS Sesame resolver directly from the browser
  (CORS-enabled, no server proxy) and fills the conesearch inputs from the search form.
- **Edge-clipped stamp centring** — stamps now anchor the WCS reference pixel at the canvas
  centre instead of the image's geometric centre, so a cutout truncated at a detector edge still
  puts the alert under the crosshair (it was ~7″ off on `ZTF26abngxfo`). Fixes LSST for free — its
  WCS already recorded the clipping — while ZTF, whose stamps carry no WCS at all, gets its CRPIX
  reconstructed lazily via `GET /api/stamp_center`. Also re-anchors the synthesised ZTF WCS on the
  selected detection's ra/dec rather than the object mean, which is what made the Aladin footprint
  disagree with the pixels. See trap #18.
- **Starlette ≥ 1.0 compatibility** — `routes/htmx.py` builds its own Jinja environment and passes
  `Jinja2Templates(env=...)`; the old `autoescape=`/`auto_reload=` kwargs raise `TypeError` on
  recent Starlette. `autoescape=True` is preserved deliberately (Starlette's `select_autoescape()`
  default would leave `*.html.jinja` unescaped). `pyproject.toml` also disables the zarr pytest
  plugin so `python3 -m pytest` collects. Both are covered in the Commands section above.
