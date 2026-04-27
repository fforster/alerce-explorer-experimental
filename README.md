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

The basic-info panel has a 2-column layout, inline HMS/Deg coord toggle +
copy-icon (green ✓ feedback), and a bottom action row with **Show features**
(lazy-loaded feature table modal: version/band/filter picker + CSV
download) alongside the **Other archives** dropdown. The feature-extractor
version chosen for the modal default is the same one used to fold the
light curve, so the displayed `Multiband_period` and the folding period
never disagree.

The light curve panel now toggles into a **Periodogram** in place of the
position-residuals scatter. The periodogram is a multi-band, multi-harmonic
least-squares periodogram (Schwarzenberg-Czerny 1996; same family as P4J's
MHAOV on the production pipeline): at each frequency it jointly fits an
NH=4 Fourier model per band — own constant + own a_k/b_k for k=1…4 — by
weighted least squares (in-place Cholesky on a 9×9 SPD normal-equations
matrix) and sums χ² reductions across bands. This breaks yearly window-
function aliases that defeat a "sum of single-sinusoid GLS at f, 2f, …"
heuristic. Defaults to **Sci mag** input, draws a dashed reference line
at the currently-selected period plus a dotted line at the feature table's
`Multiband_period`, and snaps clicks within 24 px of a peak. Selecting a
period folds the *main* LC chart in place via `window.lcSetFoldPeriod` —
no separate folded-LC canvas.

The light curve htmx render is now **detections-only on the synchronous
path** (~2-3 s vs. ~15 s before, when the slow TNS bridge dominated).
Forced photometry, features (Fold + parametric overlays), and object
coordinates (ZTF DR overlay + Milky-Way E(B-V) auto-fetch) ride three
deferred fragments — `/htmx/lc_fp`, `/htmx/lc_features`, `/htmx/lc_info`
— that update the chart in place via `window.lcSetBundle`,
`lcSetFeatures`, `lcSetCoords`. The TNS lookup similarly runs through a
deferred `/htmx/tns_lookup` fragment fired by the basic-info panel; on a
match it fills the basic-info TNS row and OOB-populates the LC redshift
input via a tiny inline script. A small loading status strip in the LC
panel shows what's still in flight.

Crossmatch, airmass, and name resolver are still deferred.

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
    features.py           Feature-table fetch + pick_default_version (strict N.N.N picker,
                          shared with LC fold-period extractor)
    lightcurve.py         get_lightcurve (detections only) + get_lc_fp_bundle (FP +
                          v2 mag_corr re-merge) + get_lc_features_bundle
                          (Multiband_period + parametric_fits, deferred)
    tns.py                ALeRCE TNS htmx-bridge proxy (now driven by /htmx/tns_lookup)
  templates/              Jinja2 partials, grouped by feature sub-area
                          (basic_information/, features/, object_detail/, lightcurve/,
                           stamps/, aladin/, radar/, coord_residuals/, periodogram/,
                           tns/, search_form/, ...)
                          Deferred LC fragments: lightcurve/lcFpFragment.html.jinja,
                          lightcurve/lcFeaturesFragment.html.jinja,
                          lightcurve/lcInfoFragment.html.jinja,
                          tns/tnsLookupFragment.html.jinja
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
    js/periodogram.js     Multi-band multi-harmonic LS periodogram (chunked compute,
                          Cholesky solve per frequency per band; folds the main LC)
tests/                    pytest suite (service layer)
```
