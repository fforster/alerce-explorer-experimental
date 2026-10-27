"""Multi-band Gaussian Process regression for the light-curve overlay.

Non-parametric companion to the SPM / FLEET / TDE parametric overlays. Fits a
single joint GP to the difference-flux detections of *all* bands (and, when a
cross-survey counterpart exists, both surveys) and returns a smooth posterior
mean ± 1σ per band on a common time grid. The client re-projects those flux
grids through the active Flux/Mag · App/Abs · Obs/Der · Fold modes, exactly
like the parametric overlays.

Method — one joint GP over (time, wavelength), evaluated exactly in O(n) by
`gpimg`, which puts the model in state-space form and runs a Kalman filter and
smoother instead of a dense Cholesky:

    k((t,λ), (t',λ')) = A² · Matérn-ν(|t−t'|; ℓ_t) · exp(−(ln λ − ln λ')²/2ℓ_λ²)

The time kernel is selectable: Matérn-3/2 (the default, once-differentiable
sample paths — the shape the overlay has always had) or Matérn-5/2 (twice
differentiable, so the posterior mean is visibly smoother and its curvature is
defined). Both are *exact* state-space models; 5/2 simply carries three latent
states per band instead of two, so it costs ~2× per point and nothing else
about the method changes. Which kernels the installed gpimg can build is read
off `build_info()`, so an older core transparently offers only 3/2.

The wavelength factor is the coregionalization: bands close in wavelength are
strongly correlated, ℓ_λ→0 recovers independent per-band GPs, and one extra
hyperparameter covers any number of bands. The same band letter from different
telescopes (e.g. ZTF g + LSST g) is pooled by the caller into one band before
the fit, so the wavelength axis only ever carries distinct filters.

Why gpimg rather than a dense GP: the exact likelihood, its gradient, the fit
and the posterior all cost O(n) with no approximation (agreement with a dense
double-precision GP to ~1e-11), which turns a 2–17 s blocking fit into tens of
milliseconds. That matters twice over here — `/htmx/lc_gp` is served from the
event loop, so a multi-second fit stalls every other request on the worker —
and it retires the O(N³) cost guards the dense fit needed (see `_MAX_POINTS`).

We fit in difference-flux (nJy) space (handles negative transient flux, where a
magnitude is undefined) with per-point heteroscedastic noise, plus a fitted
white `jitter` that absorbs scatter the quoted errors do not describe.
"""
from __future__ import annotations

import logging
from typing import Any

import gpimg
import numpy as np

log = logging.getLogger(__name__)

# Minimum data to attempt a fit. Below this the posterior is dominated by the
# prior and the overlay is meaningless.
_MIN_POINTS = 5

# Cap on the joint-fit size. The solve is O(n), so this is a payload/latency
# guard rather than the O(N³) cost guard the dense fit needed — it sits two
# orders of magnitude above the old 800. Thinning is uniform per band.
_MAX_POINTS = 50_000

# Time kernels the installed gpimg core can build a state space for. Matérn-5/2
# arrived after the first release, so this is read from the build rather than
# assumed: an older core advertises no "kernels" key and we offer 3/2 alone,
# instead of raising a TypeError deep inside the fit.
KERNELS: tuple[str, ...] = tuple(gpimg.build_info().get("kernels") or ("matern32",))

#: The kernel used when a caller doesn't ask for one — the overlay's historical
#: shape, so an unqualified fit is byte-for-byte what it always was.
DEFAULT_KERNEL = "matern32"

# gpimg carries up to six distinct wavelengths. Band letters are pooled across
# surveys before the fit, so LSST ugrizy + ZTF gri is exactly six — no headroom.
# Past that we keep the best-sampled bands rather than failing the overlay.
_MAX_BANDS = gpimg.build_info()["max_bands"]

# Floor on the per-point flux error (nJy) so a zero/None error can't dominate
# the inverse-variance weighting.
_EFLUX_FLOOR = 1e-3

# Phase-domain (folded) GP length-scale bounds, in cycles (phase ∈ [0, 1)).
# Capped well below 1 so a band can't be fit by a single broad feature that
# ignores the periodic structure.
_PHASE_LS_BOUNDS = (0.02, 0.3)

# Time-domain bounds on ℓ_t, in days. gpimg's own default is (0.5, 500).
_TIME_LS_BOUNDS = (0.5, 1000.0)

# Bounds on ℓ_λ in ln λ. LSST u→y spans ln(9712/3671) ≈ 0.97, so the upper end
# is "all bands move together" and the lower end "every band independent".
_WAVE_LS_BOUNDS = (0.03, 5.0)

# The jitter, as a fraction of the standardized flux scale (the fit runs in
# standardized units, so 1.0 is "as large as the band scatter itself").
_JITTER_BOUNDS = (1e-4, 2.0)


def _clean_series(series: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop non-finite samples and bands left with nothing. Each input group is
    {survey, band, lambda_eff, mjd[], flux[], eflux[]} in difference-flux nJy."""
    cleaned: list[dict[str, Any]] = []
    for grp in series:
        lam = grp.get("lambda_eff")
        if lam is None or not np.isfinite(lam):
            continue
        mjd = np.asarray(grp.get("mjd") or [], dtype=float)
        flux = np.asarray(grp.get("flux") or [], dtype=float)
        eflux = np.asarray(grp.get("eflux") or [], dtype=float)
        n = min(len(mjd), len(flux), len(eflux))
        if n == 0:
            continue
        mjd, flux, eflux = mjd[:n], flux[:n], eflux[:n]
        ok = np.isfinite(mjd) & np.isfinite(flux)
        if not ok.any():
            continue
        mjd, flux, eflux = mjd[ok], flux[ok], eflux[ok]
        # Replace missing/non-positive errors with the floor rather than dropping
        # the point — a detection with an unreliable error still constrains shape.
        eflux = np.where(np.isfinite(eflux) & (eflux > 0), eflux, _EFLUX_FLOOR)
        order = np.argsort(mjd)
        cleaned.append(
            {
                "survey": grp.get("survey") or "",
                # The surveys pooled into this band (e.g. ["lsst", "ztf"] for a
                # combined g). Carried through to the grid so the client can tie
                # the curve's visibility to either telescope's legend entry.
                "surveys": grp.get("surveys"),
                "band": grp.get("band") or "",
                "lambda_eff": float(lam),
                "mjd": mjd[order],
                "flux": flux[order],
                "eflux": eflux[order],
            }
        )
    return cleaned


def _cap_bands(groups: list[dict[str, Any]], max_bands: int) -> list[dict[str, Any]]:
    """Keep at most `max_bands` distinct wavelengths, the best-sampled first.

    The state-space form carries a bounded number of latent processes, so the
    band count is a hard limit rather than a cost trade-off. Dropping the
    sparsest band degrades the overlay by one curve; failing would lose all of
    them. Wavelength order is preserved so the kernel sees a sane axis.
    """
    if len(groups) <= max_bands:
        return groups
    keep = sorted(groups, key=lambda g: -len(g["mjd"]))[:max_bands]
    dropped = [g["band"] for g in groups if g not in keep]
    log.warning("GP: %d bands exceeds the %d gpimg supports; dropped %s",
                len(groups), max_bands, ", ".join(dropped))
    return sorted(keep, key=lambda g: g["lambda_eff"])


def _subsample(groups: list[dict[str, Any]], max_points: int) -> list[dict[str, Any]]:
    """Uniformly thin each band (preserving time order and endpoints) so the
    total stays under ``max_points``. Proportional to each band's share."""
    total = sum(len(g["mjd"]) for g in groups)
    if total <= max_points:
        return groups
    out: list[dict[str, Any]] = []
    for g in groups:
        n = len(g["mjd"])
        keep = max(2, int(round(max_points * n / total)))
        if keep >= n:
            out.append(g)
            continue
        idx = np.unique(np.linspace(0, n - 1, keep).round().astype(int))
        out.append(
            {
                **g,
                "mjd": g["mjd"][idx],
                "flux": g["flux"][idx],
                "eflux": g["eflux"][idx],
            }
        )
    return out


def normalize_kernel(name: str | None) -> str:
    """Canonical kernel name, accepting the spellings gpimg accepts ('matern52',
    'Matern-5/2', 'matern_52', …). Unknown or unsupported names raise, so a
    typo'd query param fails loudly here rather than silently fitting 3/2."""
    if name is None:
        return DEFAULT_KERNEL
    key = "".join(ch for ch in str(name).lower() if ch not in "-_/ ")
    if key not in KERNELS:
        raise ValueError(f"kernel must be one of {list(KERNELS)}, got {name!r}")
    return key


def _unavailable(message: str, kernel: str = DEFAULT_KERNEL) -> dict[str, Any]:
    return {"available": False, "grid": [], "cov_offdiag": {}, "hyperparams": {},
            "kernel": kernel, "message": message}


def _standardize(
    groups: list[dict[str, Any]], per_band_scale: bool
) -> dict[str, tuple[float, float]]:
    """Per-band (mean, scale) the fit runs in. Two regimes:

    Per-band (science flux, and the folded fit): subtract each band's mean and
    divide by its own scatter, so every band enters the kernel at ~unit
    variance. Without this a band whose flux varies orders of magnitude more
    than another would dominate the single shared amplitude A, and the
    lower-amplitude bands would be over-smoothed (their signal lost under the
    shared jitter). This is acute for science flux, where per-band amplitudes
    differ widely. With it, the wavelength coregionalization couples band
    *shapes*, not their amplitudes — exactly "a well-sampled band informs a
    sparse one".

    Global, zero-anchored (difference flux, per_band_scale=False): the physical
    baseline is zero — a faded transient has zero difference flux in *every*
    band. A per-band mean/scale would erase that shared zero: each band would
    revert to its own mean and be rescaled independently, so a band with no data
    near an epoch would relax to its own baseline instead of following the bands
    that have gone to zero. Instead we pin every band's mean at 0 and divide all
    bands by a single global scale (the pooled RMS about zero), so the
    coregionalization couples real flux *amplitudes* and "all other bands → 0"
    pulls the target band → 0 too. This also matches gpimg's zero-mean prior
    exactly, so the posterior reverts to zero far from data rather than to an
    arbitrary offset.
    """
    stats: dict[str, tuple[float, float]] = {}
    if per_band_scale:
        for g in groups:
            m = float(np.mean(g["flux"]))
            s = float(np.std(g["flux"]))
            if not np.isfinite(s) or s <= 0:
                s = 1.0  # single-point / zero-variance band → its y collapses to 0
            stats[g["band"]] = (m, s)
    else:
        flux_all = np.concatenate([g["flux"] for g in groups])
        gscale = float(np.sqrt(np.mean(flux_all ** 2)))
        if not np.isfinite(gscale) or gscale <= 0:
            gscale = 1.0  # all-zero data → unit scale, predictions stay at 0
        for g in groups:
            stats[g["band"]] = (0.0, gscale)
    return stats


def _bounds(folded: bool) -> np.ndarray:
    """gpimg fit bounds, shape (4, 2) = [(lo, hi) for ln A, ln ℓ_t, ln ℓ_λ, ln j].

    The fit runs in standardized units, so the amplitude and jitter bounds are
    fractions of the band scatter and need no reference to the data scale.
    """
    return np.log(np.array([
        (1e-3, 1e3),                                    # A, standardized
        _PHASE_LS_BOUNDS if folded else _TIME_LS_BOUNDS,  # ℓ_t: cycles or days
        _WAVE_LS_BOUNDS,                                # ℓ_λ in ln λ
        _JITTER_BOUNDS,                                 # white jitter
    ]))


def fit_multiband_gp(
    series: list[dict[str, Any]],
    *,
    n_grid: int = 300,
    max_points: int = _MAX_POINTS,
    random_state: int = 0,
    fold_period: float | None = None,
    per_band_scale: bool = True,
    kernel: str = DEFAULT_KERNEL,
) -> dict[str, Any]:
    """Fit one joint GP over (time, wavelength) and return per-band flux grids.

    When `fold_period` is given (> 0) the fit is done in **phase** space: the
    times are folded to phase = (mjd / P) mod 1, tiled ±1 cycle so the kernel
    wraps around the 0/1 boundary, and the returned grid spans one phase cycle
    [0, 1] (the `mjd` field then carries phase, and `folded`/`period` are set).
    Otherwise it's the time-domain fit and the grid spans the MJD range.

    `kernel` picks the time kernel — "matern32" (default) or "matern52" when
    the installed gpimg carries it. Both are exact; 5/2 has twice-differentiable
    sample paths, so its posterior mean is smoother (and, in practice, its
    fitted ℓ_t shorter) than 3/2's. The returned bundle echoes the kernel back
    so the client can key its per-variant cache on it.

    `random_state` is accepted and ignored: the fit is a deterministic
    projected-BFGS run from a fixed multi-start design, so there is no seed.

    Returns a JSON-ready dict:
      {available, grid: [{survey, surveys, band, lambda_eff, mjd[], flux_mean[],
       flux_std[]}, ...], cov_offdiag, hyperparams, n_points, n_bands, folded,
       period, message}
    All arrays are plain Python lists of floats so the Jinja tojson filter can
    serialise them straight into the deferred fragment.
    """
    del random_state  # deterministic fit; kept for call-site compatibility
    try:
        kernel = normalize_kernel(kernel)
    except ValueError as e:
        return _unavailable(str(e))
    folded = fold_period is not None and fold_period > 0
    groups = _clean_series(series)
    if not groups:
        return _unavailable("No detections available for a GP fit.", kernel)
    groups = _cap_bands(groups, _MAX_BANDS)

    # Folded fits tile the data ×3 for periodic continuity, so spend a third of
    # the point budget on the original sample.
    cap = max(_MIN_POINTS, max_points // 3) if folded else max_points
    groups = _subsample(groups, cap)
    n_total = sum(len(g["mjd"]) for g in groups)
    if n_total < _MIN_POINTS:
        return _unavailable(
            f"Too few detections for a GP fit ({n_total} < {_MIN_POINTS}).", kernel
        )

    stats = _standardize(groups, per_band_scale)
    t_all = np.concatenate([g["mjd"] for g in groups])
    y = np.concatenate([(g["flux"] - stats[g["band"]][0]) / stats[g["band"]][1] for g in groups])
    e = np.concatenate([g["eflux"] / stats[g["band"]][1] for g in groups])
    band = np.concatenate([[g["band"]] * len(g["mjd"]) for g in groups])
    wavelengths = {g["band"]: g["lambda_eff"] for g in groups}

    t_span = float(t_all.max() - t_all.min()) or 1.0
    if folded:
        # Fold to phase, then tile ±1 cycle so the kernel sees continuity across
        # the wrap-around (a feature near phase 1 informs phase 0).
        phase = np.mod(t_all / fold_period, 1.0)
        t_fit = np.concatenate([phase - 1.0, phase, phase + 1.0])
        y_fit, e_fit = np.tile(y, 3), np.tile(e, 3)
        band_fit = np.tile(band, 3)
        grid_t = np.linspace(0.0, 1.0, n_grid)
        x_out = grid_t
    else:
        t_fit, y_fit, e_fit, band_fit = t_all, y, e, band
        pad = 0.03 * t_span + 1.0
        grid_t = np.linspace(t_all.min() - pad, t_all.max() + pad, n_grid)
        x_out = grid_t

    try:
        # The kwarg is only passed for a non-default kernel: gpimg 0.1.0 has no
        # `kernel` parameter at all, and the default path must keep working
        # there (normalize_kernel already rejected matern52 on such a build).
        kw = {} if kernel == DEFAULT_KERNEL else {"kernel": kernel}
        gp = gpimg.GP(t_fit, band_fit, y_fit, e_fit, wavelengths=wavelengths, **kw)
        res = gp.fit(jitter=True, bounds=_bounds(folded), nstart=5)
        # The RTS smoother is the numerically stable backward pass: on a bright
        # light curve the posterior variance just before the first observation
        # can sit many orders of magnitude below the prior, where the default
        # (MBF) loses relative precision. It costs ~2-3x on the image only.
        curves, covs = gp.predict_bands(grid_t, theta=res.theta, smoother="rts", cov=True)
    except Exception:  # pragma: no cover - defensive; the solve is non-iterative
        log.exception("GP fit failed")
        return _unavailable("Gaussian process fit failed to converge.", kernel)

    grid: list[dict[str, Any]] = []
    for g in groups:
        mean_b, scale_b = stats[g["band"]]
        mu, std = curves[g["band"]]
        grid.append(
            {
                "survey": g["survey"],
                "surveys": g.get("surveys"),
                "band": g["band"],
                "lambda_eff": g["lambda_eff"],
                "mjd": x_out.tolist(),
                "flux_mean": (np.asarray(mu) * scale_b + mean_b).astype(float).tolist(),
                "flux_std": (np.clip(std, 0.0, None) * scale_b).astype(float).tolist(),
            }
        )

    # Off-diagonal band-band flux covariances for the client's color-error
    # propagation (the diagonal is the grid's flux_std²). A joint GP makes the
    # bands correlated, and ignoring that overstates a color's error several
    # times over. De-standardized by s_b·s_c: the affine map F = s·y + m leaves
    # the covariance scaled by s_b·s_c and drops the mean offset. Keyed by the
    # two band names sorted lexicographically (an unordered lookup; the client
    # picks blue/red by wavelength).
    cov_offdiag: dict[str, list[float]] = {}
    for i, a in enumerate(groups):
        for b in groups[i + 1:]:
            cab = np.asarray(covs[(a["band"], b["band"])]) * stats[a["band"]][1] * stats[b["band"]][1]
            cab = np.where(np.isfinite(cab), cab, 0.0)
            cov_offdiag["|".join(sorted([a["band"], b["band"]]))] = cab.astype(float).tolist()

    return {
        "available": True,
        "grid": grid,
        "cov_offdiag": cov_offdiag,
        "kernel": kernel,
        "hyperparams": _hyperparams(res),
        "n_points": int(n_total),
        "n_bands": len(groups),
        "folded": folded,
        "period": float(fold_period) if folded else None,
        "message": "",
    }


def _hyperparams(res: "gpimg.FitResult") -> dict[str, float]:
    """The fitted (ℓ_t, ℓ_λ, A, jitter) for the overlay's info strip.

    ℓ_t is in days (time fit) or cycles (folded); ℓ_λ is in natural-log
    wavelength, so it is dimensionless — ln(λ_red/λ_blue), not an interval in
    Ångström. A and the jitter are in the standardized units the fit runs in — a
    fraction of each band's own scatter (per-band mode) or of the pooled global
    scale (difference mode) — so they're dimensionless, not nJy.
    """
    return {
        "l_t_days": float(res.length_time),
        "l_lambda_lnlam": float(res.length_wave),  # natural-log wavelength
        "sigma_f": float(res.amplitude),           # × per-band scatter
        "jitter": float(res.jitter or 0.0),        # × per-band scatter
        "converged": bool(res.converged or res.status == 3),
    }
