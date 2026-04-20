# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

Reproduce the ALeRCE Explorer using **htmx** (matching the stack of the original production ALeRCE explorer), based on an existing single-file JavaScript prototype. This repository is primarily a tutorial demonstrating Claude Code workflows on the ALeRCE project — correctness of the port matters, but the pedagogical framing (small, reviewable steps) is part of the point.

## Reference implementations

Two prior artifacts must be consulted before writing code here:

- `../ALeRCE_explorer/alerce_explorer.html` — the single-file JS prototype (~5600 lines). This is the source of truth for UI layout, feature set, normalization logic, and numerical recipes (GLS periodogram, cosmology, FITS rendering, extinction). Its sibling `../ALeRCE_explorer/CLAUDE.md` contains a detailed section map and is the first thing to read when porting a specific feature.
- The production ALeRCE explorer — the htmx patterns (server-rendered partials, `hx-*` attributes, progressive enhancement) should mirror what the production site does.

When porting a feature, read the corresponding line range in `alerce_explorer.html` rather than reimplementing from scratch — the normalization, error propagation, and survey-specific quirks have been debugged there.

## Architectural shift: all-JS → htmx

The prototype does everything in the browser (fetch → normalize → render). The htmx version should push as much as possible to the server and return HTML partials, but some features **cannot** move server-side and must stay client-side JS:

- Chart.js plots (light curve, radar, periodogram, folded, airmass) — interactive, need a JS runtime.
- In-browser FITS parsing / stamp rendering (asinh stretch, WCS-aware rotation) for LSST.
- Aladin Lite sky viewer.
- Zoom/pan gestures (chartjs-plugin-zoom, Hammer.js).
- Keyboard/touch navigation between objects.

Good targets for server-rendered htmx partials: the search results table, object metadata panel, filter accordion state, crossmatch table, external archives dropdown, airmass observatory picker, classifier/class dropdowns (which depend on the survey).

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

## External services the port depends on

- ALeRCE API (LSST and ZTF variants — distinct `apiBase`, `objectsUrl`, `lcUrl`, `fpUrl`, `probUrl`).
- ALeRCE stamp service (`avro.alerce.online/get_stamp` for ZTF PNG; `stamps_api/stamp` for LSST FITS).
- `catshtm.alerce.online/crossmatch_all` for catalog crossmatch.
- IRSA dust map via `dust-proxy.francisco-forster.workers.dev` (Cloudflare Worker).
- CDS: `hips2fits` (HiPS cutouts), Sesame name resolver, Aladin Lite CDN.

## Repository status

No source files, build configuration, or tests exist yet. Once scaffolding is in place (backend framework, template layout, static assets), re-run `/init` so this file can be extended with real build/lint/test commands and the final architecture overview.
