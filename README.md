# ALeRCE Explorer (experimental, htmx)

Re-implementation of the ALeRCE Explorer using htmx + FastAPI + Jinja2 + Tailwind,
mirroring the patterns used in the production
[`alercebroker/web-services/multisurveys-apis`](https://github.com/alercebroker/web-services/tree/main/multisurveys-apis).

See `CLAUDE.md` for the overall design, reference implementations, and the
domain-specific traps (survey abstraction, 64-bit OIDs, ZTF→nJy normalization,
GLS periodogram, FITS rendering, etc.).

## Status

Slices 1–6 plus radar, position residuals, probability, periodogram,
catsHTM crossmatch, airmass, and **cross-survey LC overlay** are live —
the in-app header now reads "ALeRCE multisurvey explorer". The detail
view renders, in parallel from a single row click: basic info, a Chart.js
light curve (flux/mag, diff/sci, apparent/absolute with Planck-2018
distance modulus, observed/dereddened with Fitzpatrick-1999 Milky-Way
extinction), science/template/difference stamps (in-browser FITS parsing
for LSST, PNG for ZTF), an Aladin Lite sky viewer with spec-z overlays
from 10 VizieR catalogs, a classifier radar, a position-residuals
scatter, and a catsHTM crossmatch panel that prefetches under the page.
LC ↔ stamps ↔ residuals selection is synced and **dispatches to the
right survey's stamp service** for cross-survey clicks.

**Cross-survey overlay.** When the LC arrives the panel cone-searches
the *other* survey at this object's RA/Dec (3″) via `/htmx/lc_xsurvey`
and overlays the matched counterpart on the same chart: LSST detections
render as filled circles, ZTF as filled squares, ZTF FP as apex-down
triangles (LSST FP stays apex-up). The legend groups by `(survey, kind)`
— headers like `LSST det:`, `LSST FP:`, `ZTF det:` toggle the whole
bucket as a unit; disabled bands dim to grey instead of strikethrough.
Visibility survives every Flux/Mag, Diff/Sci, App/Abs, Obs/Der, Fold
toggle via a `(survey, kind, label)` snapshot in `applyModes`. The
matched cross-survey OID surfaces in the basic-info panel as a clickable
link (`/?survey=<other>&oid=<other oid>`). The position-residuals
scatter, periodogram, and CSV download all derive from the live LC and
inherit the legend's visibility — toggling `LSST det:` in the LC
instantly drops every LSST point from the residuals + periodogram input
on the next compute.

**Basic-info panel.** 2-column layout, inline HMS/Deg coord toggle +
copy-icon (green ✓ feedback), Eq ↔ Gal ↔ Ecl coord-system cycler. A
bottom action row groups **Show features** (lazy-loaded modal: version/
band/filter picker + CSV download) and **Other archives**, with the
**Airmass** button on its own row. The feature-extractor version chosen
for the modal default is the same one used to fold the light curve and
to anchor parametric overlays, so the displayed `Multiband_period` and
the folding period can never disagree.

**Periodogram.** Toggles into the position-residuals slot from the LC
toolbar. Multi-band, multi-harmonic least-squares periodogram
(Schwarzenberg-Czerny 1996; same family as P4J's MHAOV on the production
pipeline): at each frequency it jointly fits an NH=4 Fourier model per
band — own constant + own a_k/b_k for k=1…4 — by weighted least squares
(in-place Cholesky on a 9×9 SPD normal-equations matrix) and sums χ²
reductions across bands. Inputs are the surveys/bands currently visible
in the LC legend; the status line lists the bands actually consumed
(e.g. `LSST: g r · ZTF: g`). Defaults to **Sci mag** input, draws a
dashed reference line at the selected period plus a dotted line at the
feature table's `Multiband_period`, and snaps clicks within 24 px of a
peak. Selecting a period folds the main LC chart in place via
`window.lcSetFoldPeriod` — no separate folded-LC canvas.

**Deferred LC sub-fetches.** The LC htmx render is **detections-only on
the synchronous path** (~2-3 s vs. ~15 s before, when the slow TNS
bridge dominated). Four deferred fragments update the chart in place as
they land: `/htmx/lc_fp` (FP + ZTF v2 mag_corr re-merge → `lcSetBundle`),
`/htmx/lc_features` (Fold + parametric overlays → `lcSetFeatures`),
`/htmx/lc_info` (ra/dec → `lcSetCoords` → ZTF DR + IRSA E(B-V)
auto-fetch), and `/htmx/lc_xsurvey` (cross-survey counterpart →
`lcSetCrossSurvey`). The status strip self-collapses once every loader
has finished, handing the row's vertical space back to the chart. The
TNS lookup runs through a deferred `/htmx/tns_lookup` fragment from the
basic-info panel; on a match it fills the basic-info TNS row and
OOB-populates the LC redshift input via a tiny inline script.

**catsHTM crossmatch panel** prefetches on detail-view load (`hx-trigger=
"load"` instead of on-expand) so opening the collapsible is instant.
**Airmass panel** shares a grid cell with periodogram and position
residuals; mutually exclusive toggles. **Name resolver** is still deferred.

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

Python (service layer + route fragments; upstream ALeRCE calls monkeypatched):

```bash
poetry run pytest
# or without poetry
PYTHONPATH=. pytest
```

Client-side JS (pure helpers under `src/static/js/`, run with Vitest + jsdom):

```bash
npm install        # first time, pulls vitest + jsdom
npm run test:js    # one-shot
npm run test:js:watch
```

The JS tests load each IIFE script into a jsdom `window` and assert on the
globals it exposes (see `tests-js/`). Coverage:

- `cosmology.js` — Planck-18 distance modulus
- `coords.js` — RA/Dec + date→MJD parsing
- `dust.js` — galactic latitude
- `lightcurve.js` — `projectPoint` (the Flux/Mag × Diff/Sci × App/Abs ×
  Obs/Der × offset projection), `foldDataset`, per-survey `mjdToUtcString`
  (incl. the LSST TAI offset), marker/label helpers — reached via the
  `window.__lcTest` hook the script exposes for tests
- `selection.js` — cross-panel `setSelectedIdentifier` (state, survey-routed
  stamps dispatch, URL mirroring)

Both suites run in CI via `.github/workflows/tests.yml`.

## Layout

```
src/
  app.py                  FastAPI entrypoint
  routes/
    htmx.py               HTMLResponse endpoints (Jinja2 fragments)
    rest.py               JSON endpoints for client-side features
  services/
    survey_config.py      SC() dispatch + per-survey field remapping + extinction_r;
                          mjd_scale ("tai"/"utc") + TAI_MINUS_UTC_SECONDS = 37
                          for LSST midpointMjdTai → UTC conversion
    normalize.py          Raw detection → common schema (ZTF mag→nJy)
    safe_json.py          64-bit-OID-safe JSON parsing for LSST
    alerce_client.py      httpx client for the public ALeRCE API
    object_list.py        build_search_params + ZTF↔LSST row normalization
    object_info.py        Detail-view shaping for the basic-info panel
    probability.py        Classifier probabilities for the radar panel
    coord_residuals.py    (Δra, Δdec) shape_coord_residuals (now used only via
                          the programmatic API; the UI panel derives client-side
                          from the live LC chart, including cross-survey)
    coordinates.py        ra_to_hms / dec_to_dms / equatorial_to_galactic /
                          equatorial_to_ecliptic
    other_archives.py     External archive URL builders
    classifiers.py        Dedupe + merge classifier/class options
    crossmatch.py         catsHTM crossmatch fetch + per-catalog row shaping
    stamps.py             stamp picker context + per-survey URL templates
                          (stamp_url_templates_by_survey carries __OID__ + __IDENT__
                          placeholders so cross-survey clicks dispatch correctly);
                          _mjd_to_utc(mjd, scale) applies the TAI offset for LSST
    ztf_dr.py             ZTF DR archival cone-search
    features.py           Feature-table fetch + pick_default_version (strict N.N.N picker,
                          shared with LC fold-period extractor)
    lightcurve.py         get_lightcurve (detections only) + get_lc_fp_bundle (FP +
                          v2 mag_corr re-merge) + get_lc_features_bundle
                          (Multiband_period + parametric_fits, deferred) +
                          get_lc_xsurvey_bundle (object_info → other-survey
                          conesearch (3″) → matched LC + FP for the overlay)
    tns.py                ALeRCE TNS htmx-bridge proxy (now driven by /htmx/tns_lookup)
  templates/              Jinja2 partials, grouped by feature sub-area
                          (basic_information/, features/, object_detail/, lightcurve/,
                           stamps/, aladin/, radar/, coord_residuals/, periodogram/,
                           crossmatch/, airmass/, tns/, search_form/, ...)
                          Deferred LC fragments: lightcurve/lcFpFragment.html.jinja,
                          lightcurve/lcFeaturesFragment.html.jinja,
                          lightcurve/lcInfoFragment.html.jinja,
                          lightcurve/lcXSurveyFragment.html.jinja,
                          tns/tnsLookupFragment.html.jinja
  static/
    css/tailwind.css      Tailwind entry; compiles to main.css
    htmx/htmx.min.js      Self-hosted htmx 1.9.12
    chart-js/             Vendored Chart.js 4.x + zoom/pan plugins
    js/helpers.js         send_form_Data / send_pagination_data / ...
    js/selection.js       Cross-panel selection sync; setSelectedIdentifier(ident,
                          survey, oid) routes the stamps swap by survey so cross-
                          survey clicks hit the matching survey's stamp service
    js/lightcurve.js      Chart.js LC + cycle-button toggles + per-survey markers
                          (LSST=circle, ZTF=square; ZTF FP=apex-down triangle) +
                          (survey, kind, label) visibility memory across toggles +
                          lcSetCrossSurvey / lcSetBundle / lcSetFeatures / lcSetCoords
                          + lc:dataChanged & lc:visibilityChanged custom events;
                          mjdToUtcString(mjd, survey) subtracts TAI−UTC for LSST
    js/stamps.js          FITS + WCS + asinh stretch for LSST stamps;
                          updateStampsForIdentifier(ident, survey, oid) fills
                          __OID__ + __IDENT__ placeholders in per-survey templates
    js/aladin.js          Aladin Lite bootstrap + spec-z overlays
    js/radar.js           Classifier probability radar
    js/coord_residuals.js Position-residuals scatter — derives client-side from the
                          live LC chart's $lcRaw + $lcXRaw, filters by LC legend
                          visibility, re-renders on lc:dataChanged / lc:visibilityChanged
    js/airmass.js         Airmass curve (toggleAirmassPanel from basic-info)
    js/coords.js          Shared client-side coord parsing helpers
    js/object_nav.js      Page-of-OIDs prev/next/back nav in the global header
    js/cosmology.js       Planck-2018 distance modulus
    js/dust.js            IRSA dust-proxy client for E(B-V)
    js/specz.js           VizieR spec-z loader (10 catalogs)
    js/periodogram.js     Multi-band multi-harmonic LS periodogram (chunked compute,
                          Cholesky solve per frequency per band; folds the main LC).
                          Inputs gated on the LC legend's band/survey visibility
                          (incl. cross-survey) so toggling LC bands changes the
                          periodogram input set on the next compute.
tests/                    pytest suite (service layer + route fragments)
```
