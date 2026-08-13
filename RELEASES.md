# Releases

## v0.1

Feature comparison with the production explorers.

Production today is two things: the **ZTF explorer** (`ztf_explorer`, Vue/Nuxt, serving alerce.online) and **multisurveys-apis** (FastAPI+htmx, behind lsst.alerce.online). The experimental build is a single htmx/FastAPI app covering both. Grouped by theme, with each item marked as present-in-production (parity) or not-present-in-production (new), as far as can be determined.

### A. Multi-survey unification

| Item | In production | Experimental |
|---|---|---|
| ZTF and LSST in one detail view | Separate sites | Single detail view |
| Cross-survey LC overlay (3″ cone-search of the other survey, matched LC+FP on one chart, per-survey markers) | No | Yes |
| Cross-survey identity in stamps, periodogram, residuals, CSV | No | Yes |
| Single `SURVEY_CONFIG` abstraction | — | Yes |

### B. Photometry

- **Absolute magnitudes/fluxes** via redshift association (Planck-2018 distance modulus) — not in production.
- **Dereddened mag/flux** (Fitzpatrick 1999, per-band R_λ, E(B-V) from IRSA) — not in production.
- **Composable LC toggles** — flux/mag × diff/sci × app/abs × obs/der × fold × band visibility/offset through one projection function.
- **Multi-band Gaussian Process fit** — one joint GP over (time, wavelength): the coregionalization matrix is a wavelength kernel, so `k_t·k_λ` is a single anisotropic 2-D RBF and ugrizy+gr costs one extra hyperparameter. Mean ±1σ per band, re-projected through the active toggle state; folded fits tile the phase ×3 so the kernel wraps. Not in production.
- **Colour evolution from the GP** — colour-vs-time with ±1σ bands, and a colour–colour scatter with 1σ error *ellipses* over a viridis time colourbar. Errors use the full band–band covariance, so ellipses tilt correctly when two colours share a band. Not in production.
- **Parametric-fit overlays** (SPM, FLEET, TDE-tail), re-projected through the active toggle state — not in production UI.
- **Band-offset strategy** differs from production.

### C. Periodicity / timing

- **Periodogram** — multi-band, multi-harmonic GLS (Schwarzenberg-Czerny 1996), inputs gated on LC legend visibility; click a peak → folds the main chart.
- **Airmass evolution panel** — not in production.

### D. Imaging

- **WCS-rotated, North-up LSST stamps** (CD-matrix rotation, asinh stretch, in-browser FITS).
- **Click an LC point → that epoch's stamp** (and reverse) — cross-panel selection sync — not in production.
- **Stamp footprint drawn in Aladin** — not in production.

### E. Sky context / crossmatch

- **Spec-z catalogs in Aladin** — 10 VizieR catalogs as clickable overlays; click a host galaxy → fills the LC redshift input → drives absolute mags. Not in production.
- **Contemporaneous neighbor detection** (LSST cone-search 10′, ±2 hr of `lastmjd`) for moving objects / trails — not in production.
- **Bulk CDS/NED crossmatch**, prefetched for the whole results page and cached, feeding both the crossmatch panel (stars → AGN → host, with classification hints) and the Aladin overlay; a live per-catalog progress checklist with a growing partial table while it runs — not in production.
- **Position scatter plot** ((Δra, Δdec), derived live from the LC, filtered by legend visibility) — not in production.

### F. Data products & metadata

- **ZTF Data Release overlay** on the LC — present in production (alerce.online); also implemented here, plus a **marginal histogram strip** binning each visible DR band's brightness distribution along the Y axis, re-binning under pan/zoom — not in production.
- **Peak-difference / mean-total magnitude columns** in the results table, filled out-of-band from one bulk TAP query per page — not in production.
- **Features: view, filter, download** with version picker + CSV; default version chosen by the strict `N.N.N` rule that also anchors the fold period.
- **LC data download** — CSV with survey/oid/candid columns, cross-survey rows, double-quoted 64-bit ids.
- **AVRO metadata viewer** per detection.
- **Ecliptic / galactic coordinate display** + HMS/Deg toggle with copy-to-clipboard.

### G. UX / interaction

- **Drag to resize panels** (persisted per session).
- **Deep-linkable URLs** (`HX-Push-Url`) + page-of-OIDs prev/next navigation + cached back-navigation.
- **Sesame name resolver** — working.
- **TNS lookup** auto-populating the redshift input.
- **Per-panel (?) help tooltips** on 9 panels.
- **Mobile scroll shield** — tap-to-interact overlay on touch-trapping plot areas so a vertical swipe scrolls the page instead of panning a chart or the sky view.
- **Optional session-replay analytics** (rrweb) — off by default, honors DNT/GPC, anonymous ids only.

### H. Architecture / correctness

- Self-hosted htmx; data fetched server-side via httpx (browser does not call the ALeRCE API directly); mirrors `multisurveys-apis` patterns.
- **64-bit LSST OID safety** throughout.
- **Per-survey MJD time scale** (LSST TAI vs ZTF UTC; 37 s offset handled).
- **Detail-view teardown** — every Chart.js chart and Aladin instance is destroyed on navigate/back, including the cache-restore path that bypasses htmx.
- **Three test tiers** — ~399 pytest tests over services + route fragments, ~131 vitest/jsdom tests over the client JS, and 8 Playwright e2e specs (11 tests) driven against a replay-backed server, so the whole suite runs offline.

### Items to verify before demoing

- **e2e coverage is a thin slice** — the 8 Playwright specs cover the smoke path, search, LC render + Flux/Mag, dereddening, periodogram folding, Aladin + redshift, selection sync, and the teardown leak guard. Panels added since (GP overlay, colour evolution, AVRO modal, crossmatch progress) have service- and unit-level tests but no e2e path.
- **Replay fixtures pin upstream shapes** — if an ALeRCE response schema changes, the e2e tier keeps passing against the recorded bodies. Re-record with `EXPLORER_RECORD=1` before trusting it as an integration signal.
- **The crossmatch cache is runtime-only** — a restart empties it, so the first detail view after a deploy pays the full CDS/NED latency.
