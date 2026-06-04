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
- **Multi-band Gaussian Process fit** (ICM + wavelength kernel) — not in production.
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
- **Contemporaneous neighbor detection** (LSST cone-search ±10′, ±2 hr) for moving objects / trails — not in production.
- **Position scatter plot** ((Δra, Δdec), derived live from the LC, filtered by legend visibility) — not in production.

### F. Data products & metadata

- **ZTF Data Release overlay** on the LC — present in production (alerce.online); also implemented here.
- **Features: view, filter, download** with version picker + CSV; default version chosen by the strict `N.N.N` rule that also anchors the fold period.
- **LC data download** — CSV with survey/oid/candid columns, cross-survey rows, double-quoted 64-bit ids.
- **AVRO metadata viewer** per detection.
- **Ecliptic / galactic coordinate display** + HMS/Deg toggle with copy-to-clipboard.

### G. UX / interaction

- **Drag to resize panels** (persisted).
- **Deep-linkable URLs** (`HX-Push-Url`) + page-of-OIDs prev/next navigation + cached back-navigation.
- **Sesame name resolver** — working.
- **TNS lookup** auto-populating the redshift input.

### H. Architecture / correctness

- Self-hosted htmx; data fetched server-side via httpx (browser does not call the ALeRCE API directly); mirrors `multisurveys-apis` patterns.
- **64-bit LSST OID safety** throughout.
- **Per-survey MJD time scale** (LSST TAI vs ZTF UTC; 37 s offset handled).
- ~323 tests, service-layer focused.

### Items to verify before demoing

- **Client-side code has no automated coverage** — all 323 tests are service-layer; the interaction features (toggles, selection sync, drag-resize, cross-survey overlay) are exercised only manually.
