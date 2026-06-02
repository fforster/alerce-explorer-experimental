"""Multi-band Gaussian Process regression for the light-curve overlay.

Non-parametric companion to the SPM / FLEET / TDE parametric overlays. Fits a
single joint GP to the difference-flux detections of *all* bands (and, when a
cross-survey counterpart exists, both surveys) and returns a smooth posterior
mean ± 1σ per band on a common time grid. The client re-projects those flux
grids through the active Flux/Mag · App/Abs · Obs/Der · Fold modes, exactly
like the parametric overlays.

Method — follows Part III of AS4501/Timeseries/timeseries_examples.ipynb:

  The notebook's multi-band model is the Intrinsic Coregionalization Model
  (ICM): k((t,b),(t',b')) = k_t(t,t') · B[b,b']. There it uses a free 2×2 band
  matrix B = [[1,ρ],[ρ,1]] for ZTF g/r. To scale to LSST ugrizy (+ cross-survey
  ZTF gr) we replace the free B with a *wavelength kernel*

      B[b,b'] = exp(−½ (λ_b − λ_b')² / ℓ_λ²),

  which is PSD by construction (Schur product of two PSD kernels stays PSD) and
  adds a single hyperparameter ℓ_λ regardless of band count. Bands close in
  wavelength are strongly correlated; ℓ_λ→0 recovers independent per-band GPs.
  The same band letter from different telescopes (e.g. ZTF g + LSST g) is
  pooled by the caller into one band before the fit, so the wavelength axis
  only ever carries distinct filters (g, r, i, …).
  k_t · k_λ is exactly a single *anisotropic* RBF over the 2-D input (t, λ) with
  one length scale per dimension — so we hand sklearn a 2-column X = [t, λ] and
  it learns (ℓ_t, ℓ_λ, σ_f) by maximising the marginal log-likelihood.

We fit in difference-flux (nJy) space (handles negative transient flux, where a
magnitude is undefined) with per-point heteroscedastic noise via ``alpha=σ²``
plus a learned ``WhiteKernel`` jitter (extra scatter beyond the quoted errors),
matching the notebook's per-band fit. Detections plus forced photometry within
±30 d of the detection span feed the fit (the caller windows the FP); a uniform
per-band subsample caps the joint size so the O(N³) solve stays bounded.
"""
from __future__ import annotations

import logging
import warnings
from typing import Any

import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, ConstantKernel, WhiteKernel

log = logging.getLogger(__name__)

# Wavelengths are carried in units of 1000 Å so ℓ_λ lands at O(1) and shares a
# comfortable optimiser scale with ℓ_t (days). LSST/ZTF span ~3.6–9.7 here.
_LAMBDA_UNIT_ANGSTROM = 1000.0

# Minimum data to attempt a fit. Below this the posterior is dominated by the
# prior and the overlay is meaningless.
_MIN_POINTS = 5

# Hard cap on the joint-fit size. O(N³) Cholesky per likelihood evaluation makes
# the optimiser sluggish much beyond this; we uniformly subsample per band when
# the detection count is larger (FP is already excluded by the caller).
_MAX_POINTS = 800

# Floor on the per-point flux error (nJy) so a zero/None error can't blow up the
# inverse-variance weight (alpha = σ²).
_EFLUX_FLOOR = 1e-3


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


def _unavailable(message: str) -> dict[str, Any]:
    return {"available": False, "grid": [], "hyperparams": {}, "message": message}


# Phase-domain (folded) GP length-scale bounds, in cycles (phase ∈ [0, 1)).
# Capped well below 1 so a band can't be fit by a single broad feature that
# ignores the periodic structure.
_PHASE_LS_BOUNDS = (0.02, 0.3)


def fit_multiband_gp(
    series: list[dict[str, Any]],
    *,
    n_grid: int = 300,
    max_points: int = _MAX_POINTS,
    random_state: int = 0,
    fold_period: float | None = None,
) -> dict[str, Any]:
    """Fit one joint GP over (time, wavelength) and return per-band flux grids.

    When `fold_period` is given (> 0) the fit is done in **phase** space: the
    times are folded to phase = (mjd / P) mod 1, tiled ±1 cycle so the kernel
    wraps around the 0/1 boundary, and the returned grid spans one phase cycle
    [0, 1] (the `mjd` field then carries phase, and `folded`/`period` are set).
    Otherwise it's the time-domain fit and the grid spans the MJD range.

    Returns a JSON-ready dict:
      {available, grid: [{survey, surveys, band, lambda_eff, mjd[], flux_mean[],
       flux_std[]}, ...], hyperparams, n_points, n_bands, folded, period,
       message}
    All arrays are plain Python lists of floats so the Jinja tojson filter can
    serialise them straight into the deferred fragment.
    """
    folded = fold_period is not None and fold_period > 0
    groups = _clean_series(series)
    if not groups:
        return _unavailable("No detections available for a GP fit.")

    # Folded fits tile the data ×3 for periodic continuity, so spend a third of
    # the point budget on the original sample.
    cap = max(_MIN_POINTS, max_points // 3) if folded else max_points
    groups = _subsample(groups, cap)
    n_total = sum(len(g["mjd"]) for g in groups)
    if n_total < _MIN_POINTS:
        return _unavailable(
            f"Too few detections for a GP fit ({n_total} < {_MIN_POINTS})."
        )

    # Per-band standardization: subtract each band's mean and divide by its own
    # scatter, so every band enters the kernel at ~unit variance. Without this
    # a band whose flux varies orders of magnitude more than another would
    # dominate the single shared amplitude σ_f, and the lower-amplitude bands
    # would be over-smoothed (their signal lost under the shared jitter). This
    # is acute for science flux, where per-band amplitudes differ widely. With
    # it, the wavelength coregionalization couples band *shapes*, not their
    # amplitudes — exactly "a well-sampled band informs a sparse one". The fit
    # runs in these standardized units; predictions are de-standardized per
    # band (× scale_b + mean_b) on the way out, and σ_f/jitter are reported
    # dimensionless (a fraction of each band's own scatter).
    t_all = np.concatenate([g["mjd"] for g in groups])
    band_stats: dict[tuple[str, str], tuple[float, float]] = {}
    for g in groups:
        m = float(np.mean(g["flux"]))
        s = float(np.std(g["flux"]))
        if not np.isfinite(s) or s <= 0:
            s = 1.0  # single-point / zero-variance band → its y collapses to 0
        band_stats[(g["survey"], g["band"])] = (m, s)

    def _stats(g):
        return band_stats[(g["survey"], g["band"])]

    y = np.concatenate([(g["flux"] - _stats(g)[0]) / _stats(g)[1] for g in groups])
    alpha = np.concatenate([(g["eflux"] / _stats(g)[1]) ** 2 for g in groups])
    lam_col = np.concatenate(
        [np.full(len(g["mjd"]), g["lambda_eff"]) for g in groups]
    ) / _LAMBDA_UNIT_ANGSTROM

    t0 = float(np.mean(t_all))
    t_span = float(t_all.max() - t_all.min()) or 1.0

    if folded:
        # Fold to phase, then tile ±1 cycle so the RBF sees continuity across
        # the wrap-around (a feature near phase 1 informs phase 0).
        phase = np.mod(t_all / fold_period, 1.0)
        time_col = np.concatenate([phase - 1.0, phase, phase + 1.0])
        X = np.column_stack([time_col, np.tile(lam_col, 3)])
        y_fit = np.tile(y, 3)
        alpha_fit = np.tile(alpha, 3)
        time_ls_init, time_ls_bounds = 0.1, _PHASE_LS_BOUNDS
    else:
        # Center time so the RBF argument stays small and the optimiser happy.
        X = np.column_stack([t_all - t0, lam_col])
        y_fit, alpha_fit = y, alpha
        time_ls_init, time_ls_bounds = max(t_span / 10.0, 1.0), (1.0, 1e4)

    kernel = (
        ConstantKernel(1.0, (1e-3, 1e3))
        * RBF(
            length_scale=[time_ls_init, 1.0],
            length_scale_bounds=[time_ls_bounds, (0.2, 50.0)],
        )
        + WhiteKernel(0.1, (1e-5, 10.0))
    )
    gp = GaussianProcessRegressor(
        kernel=kernel,
        alpha=alpha_fit,
        normalize_y=False,
        n_restarts_optimizer=3,
        random_state=random_state,
    )
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ConvergenceWarning)
            gp.fit(X, y_fit)
    except Exception:  # pragma: no cover - sklearn linalg edge cases
        log.exception("GP fit failed")
        return _unavailable("Gaussian process fit failed to converge.")

    # Prediction grid: one phase cycle [0, 1] when folded, else the padded MJD
    # range. `x_out` is what the client plots on its (phase or MJD) x-axis.
    if folded:
        grid_t = np.linspace(0.0, 1.0, n_grid)
        x_out = grid_t.tolist()
    else:
        pad = 0.03 * t_span + 1.0
        grid_t = np.linspace((t_all.min() - t0) - pad, (t_all.max() - t0) + pad, n_grid)
        x_out = (grid_t + t0).tolist()

    grid: list[dict[str, Any]] = []
    for g in groups:
        lam_scaled = g["lambda_eff"] / _LAMBDA_UNIT_ANGSTROM
        X_test = np.column_stack([grid_t, np.full(n_grid, lam_scaled)])
        mu, std = gp.predict(X_test, return_std=True)
        mean_b, scale_b = band_stats[(g["survey"], g["band"])]
        flux_mean = (mu * scale_b + mean_b).astype(float)
        flux_std = (np.clip(std, 0.0, None) * scale_b).astype(float)
        grid.append(
            {
                "survey": g["survey"],
                "surveys": g.get("surveys"),
                "band": g["band"],
                "lambda_eff": g["lambda_eff"],
                "mjd": x_out,
                "flux_mean": flux_mean.tolist(),
                "flux_std": flux_std.tolist(),
            }
        )

    return {
        "available": True,
        "grid": grid,
        "hyperparams": _extract_hyperparams(gp),
        "n_points": int(n_total),
        "n_bands": len(groups),
        "folded": folded,
        "period": float(fold_period) if folded else None,
        "message": "",
    }


def _extract_hyperparams(gp: GaussianProcessRegressor) -> dict[str, float]:
    """Pull the fitted (ℓ_t, ℓ_λ, σ_f, jitter) out of the optimised kernel.
    ℓ_t is in days (time fit) or cycles (folded); ℓ_λ in kilo-Ångström. σ_f and
    jitter are in the per-band-standardized units the fit runs in — i.e. a
    fraction of each band's own scatter — so they're dimensionless, not nJy.
    Defensive against sklearn's kernel-tree layout via the flat get_params."""
    p = gp.kernel_.get_params()
    try:
        const = float(p["k1__k1__constant_value"])
        length = np.atleast_1d(p["k1__k2__length_scale"]).astype(float)
        noise = float(p["k2__noise_level"])
    except KeyError:  # pragma: no cover - layout drift across sklearn versions
        return {}
    l_t = float(length[0])
    l_lambda = float(length[1]) if length.size > 1 else float("nan")
    return {
        "l_t_days": l_t,
        "l_lambda_kA": l_lambda,  # kilo-Ångström
        "sigma_f": float(np.sqrt(max(const, 0.0))),    # × per-band scatter
        "jitter": float(np.sqrt(max(noise, 0.0))),     # × per-band scatter
    }
