"""Unit tests for the multi-band Gaussian-Process overlay fit.

Runs offline — `fit_multiband_gp` is pure numpy/sklearn, no network. A fixed
random_state keeps sklearn's n_restarts_optimizer deterministic.
"""
from __future__ import annotations

import math

import numpy as np

from src.services.gp import fit_multiband_gp


def _synthetic_two_band(seed: int = 0) -> list[dict]:
    """A smooth Gaussian bump shared by two bands at different offsets — the
    kind of correlated multi-band transient the wavelength kernel exploits."""
    rng = np.random.default_rng(seed)

    def bump(t, amp, base):
        return base + amp * np.exp(-0.5 * ((t - 30.0) / 8.0) ** 2)

    series = []
    for band, lam, amp, base in [("g", 4827.0, 5000.0, 200.0), ("r", 6223.0, 4000.0, 400.0)]:
        t = np.sort(rng.uniform(0.0, 60.0, 25))
        err = np.full(t.size, 150.0)
        flux = bump(t, amp, base) + rng.normal(0.0, 150.0, t.size)
        series.append(
            {
                "survey": "lsst",
                "band": band,
                "lambda_eff": lam,
                "mjd": t.tolist(),
                "flux": flux.tolist(),
                "eflux": err.tolist(),
            }
        )
    return series


def test_fit_returns_per_band_grids_of_equal_length():
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=120)
    assert out["available"] is True
    assert out["n_bands"] == 2
    assert {g["band"] for g in out["grid"]} == {"g", "r"}
    for g in out["grid"]:
        assert len(g["mjd"]) == 120
        assert len(g["flux_mean"]) == 120
        assert len(g["flux_std"]) == 120


def test_fit_outputs_are_finite_with_positive_uncertainty():
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=80)
    for g in out["grid"]:
        assert all(math.isfinite(v) for v in g["flux_mean"])
        assert all(math.isfinite(v) and v >= 0 for v in g["flux_std"])
        # The posterior std must be strictly positive somewhere (a flat-zero
        # band would mean the fit collapsed).
        assert max(g["flux_std"]) > 0


def test_posterior_recovers_the_bump_peak():
    """The GP mean near MJD 30 should sit close to the true bump peak — well
    above the band's baseline — confirming the fit tracks the signal."""
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=200)
    g = next(x for x in out["grid"] if x["band"] == "g")
    peak_idx = max(range(len(g["mjd"])), key=lambda i: g["flux_mean"][i])
    # Peak should land near MJD 30 (within a length-scale) and reach a clear
    # excess over the ~200 nJy baseline (true peak ≈ 5200 nJy).
    assert abs(g["mjd"][peak_idx] - 30.0) < 12.0
    assert g["flux_mean"][peak_idx] > 3000.0


def test_hyperparameters_are_reported():
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=60)
    hp = out["hyperparams"]
    assert hp["l_t_days"] > 0
    assert hp["l_lambda_kA"] > 0
    # σ_f / jitter are dimensionless now (per-band-standardized units).
    assert hp["sigma_f"] > 0
    assert hp["jitter"] >= 0


def test_too_few_points_is_unavailable():
    series = [{
        "survey": "ztf", "band": "g", "lambda_eff": 4746.0,
        "mjd": [1.0, 2.0], "flux": [10.0, 20.0], "eflux": [1.0, 1.0],
    }]
    out = fit_multiband_gp(series)
    assert out["available"] is False
    assert out["grid"] == []
    assert out["message"]


def test_empty_series_is_unavailable():
    out = fit_multiband_gp([])
    assert out["available"] is False


def test_single_band_still_fits():
    """A lone band has a degenerate wavelength axis but is still a valid GP."""
    rng = np.random.default_rng(1)
    t = np.sort(rng.uniform(0.0, 50.0, 20))
    flux = 1000.0 + 300.0 * np.sin(t / 5.0) + rng.normal(0, 30, t.size)
    series = [{
        "survey": "ztf", "band": "g", "lambda_eff": 4746.0,
        "mjd": t.tolist(), "flux": flux.tolist(),
        "eflux": np.full(t.size, 30.0).tolist(),
    }]
    out = fit_multiband_gp(series, n_grid=50)
    assert out["available"] is True
    assert out["n_bands"] == 1


def test_subsampling_caps_the_fit_size():
    """A dense band is thinned below max_points before the O(N³) solve."""
    rng = np.random.default_rng(2)
    t = np.sort(rng.uniform(0.0, 100.0, 500))
    flux = 1000.0 + rng.normal(0, 50, t.size)
    series = [{
        "survey": "lsst", "band": "r", "lambda_eff": 6223.0,
        "mjd": t.tolist(), "flux": flux.tolist(),
        "eflux": np.full(t.size, 50.0).tolist(),
    }]
    out = fit_multiband_gp(series, n_grid=40, max_points=100)
    assert out["available"] is True
    assert out["n_points"] <= 100


def test_non_finite_samples_are_dropped():
    series = [{
        "survey": "ztf", "band": "g", "lambda_eff": 4746.0,
        "mjd": [1.0, float("nan"), 3.0, 4.0, 5.0, 6.0],
        "flux": [10.0, 20.0, float("inf"), 40.0, 50.0, 60.0],
        "eflux": [1.0, 1.0, 1.0, None, 1.0, 1.0],
    }]
    out = fit_multiband_gp(series, n_grid=30)
    # Two bad rows dropped (nan mjd, inf flux); 4 usable remain (< _MIN_POINTS
    # is 5, so this lands unavailable — exactly the guard we want).
    assert out["available"] is False


def test_folded_fit_returns_phase_grid():
    """With fold_period set, the GP is fit in phase space: the grid spans one
    phase cycle [0, 1] and the bundle is flagged folded with the period."""
    rng = np.random.default_rng(3)
    period = 2.5
    t = np.sort(rng.uniform(0.0, 60.0, 60))
    flux = 1000.0 + 400.0 * np.sin(2 * np.pi * t / period) + rng.normal(0, 40, t.size)
    series = [{
        "survey": "ztf", "band": "g", "lambda_eff": 4746.0,
        "mjd": t.tolist(), "flux": flux.tolist(),
        "eflux": np.full(t.size, 40.0).tolist(),
    }]
    out = fit_multiband_gp(series, n_grid=50, fold_period=period)
    assert out["available"] is True
    assert out["folded"] is True
    assert out["period"] == period
    g = out["grid"][0]
    assert min(g["mjd"]) >= 0.0 and max(g["mjd"]) <= 1.0
    assert len(g["mjd"]) == 50
    assert all(math.isfinite(v) for v in g["flux_mean"])


def test_unfolded_fit_is_not_flagged_folded():
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=40)
    assert out["folded"] is False
    assert out["period"] is None
    # x is MJD (the synthetic data spans MJD 0..60), not phase.
    assert max(out["grid"][0]["mjd"]) > 1.5


def test_per_band_standardization_recovers_low_amplitude_band():
    """A band whose flux varies orders of magnitude less than another must not
    be over-smoothed away: with per-band standardization each band is fit at
    its own scale, so the faint band still tracks its own signal."""
    rng = np.random.default_rng(7)
    t = np.sort(rng.uniform(0.0, 40.0, 30))

    def bump(amp, base):
        return base + amp * np.exp(-0.5 * ((t - 20.0) / 5.0) ** 2)

    # g varies by ~20000 nJy; y by only ~200 nJy (100× smaller) on a big base.
    big = {"survey": "lsst", "band": "g", "lambda_eff": 4827.0,
           "mjd": t.tolist(), "flux": (bump(20000.0, 1000.0) + rng.normal(0, 300, t.size)).tolist(),
           "eflux": np.full(t.size, 300.0).tolist()}
    small = {"survey": "lsst", "band": "y", "lambda_eff": 9712.0,
             "mjd": t.tolist(), "flux": (bump(200.0, 50000.0) + rng.normal(0, 5, t.size)).tolist(),
             "eflux": np.full(t.size, 5.0).tolist()}
    out = fit_multiband_gp([big, small], n_grid=100)
    y_band = next(g for g in out["grid"] if g["band"] == "y")
    span = max(y_band["flux_mean"]) - min(y_band["flux_mean"])
    # The faint band's bump is ~200 nJy peak; the GP should recover a good
    # fraction of it (a global scale would flatten it to far less).
    assert span > 80.0


def _bright_and_sparse_bands() -> list[dict]:
    """A difference-flux transient (baseline 0, fades to 0) shared by two bands.
    `g` is densely sampled across the whole event — including late times where it
    has returned to ~0. `r` is sampled *only* near the peak, so it carries no
    late-time data and its own data mean is a large positive number. This is the
    case the user flagged: at late epochs `r` should follow `g` to zero."""
    rng = np.random.default_rng(5)

    def bump(t, amp):
        return amp * np.exp(-0.5 * ((t - 30.0) / 6.0) ** 2)

    tg = np.sort(rng.uniform(0.0, 60.0, 40))
    g = {"survey": "lsst", "band": "g", "lambda_eff": 4827.0, "mjd": tg.tolist(),
         "flux": (bump(tg, 5000.0) + rng.normal(0, 60, tg.size)).tolist(),
         "eflux": np.full(tg.size, 60.0).tolist()}
    tr = np.sort(rng.uniform(22.0, 38.0, 12))
    r = {"survey": "lsst", "band": "r", "lambda_eff": 6223.0, "mjd": tr.tolist(),
         "flux": (bump(tr, 4500.0) + rng.normal(0, 60, tr.size)).tolist(),
         "eflux": np.full(tr.size, 60.0).tolist()}
    return [g, r]


def test_difference_mode_sparse_band_follows_others_to_zero():
    """In difference-flux mode the bands share one global scale and are anchored
    at zero, so a sparsely-sampled band follows the well-sampled bands to zero
    where it has no data of its own. Per-band standardization instead reverts
    that band to its own (large, positive) mean — the behaviour the user wants
    suppressed in diff mode."""
    series = _bright_and_sparse_bands()

    def r_at_late_time(per_band_scale):
        grid = fit_multiband_gp(series, n_grid=121, per_band_scale=per_band_scale)["grid"]
        r = next(x for x in grid if x["band"] == "r")
        # Late epoch (~MJD 55) where g has returned to ~0 and r has no data.
        i = min(range(len(r["mjd"])), key=lambda k: abs(r["mjd"][k] - 55.0))
        return r["flux_mean"][i]

    per_band = r_at_late_time(True)
    global_scale = r_at_late_time(False)
    # Per-band: r reverts to its own ~thousands-nJy mean. Global: r tracks g → ~0.
    assert per_band > 1000.0
    assert abs(global_scale) < 500.0


# ── Off-diagonal band covariances (color-evolution panel) ────────────────────

def _synthetic_three_band(seed: int = 0) -> list[dict]:
    """A correlated bump shared by g, r, i at three wavelengths — exercises the
    full set of unordered band pairs the covariance ships."""
    rng = np.random.default_rng(seed)

    def bump(t, amp, base):
        return base + amp * np.exp(-0.5 * ((t - 30.0) / 8.0) ** 2)

    series = []
    for band, lam, amp, base in [
        ("g", 4827.0, 5000.0, 300.0),
        ("r", 6223.0, 4200.0, 350.0),
        ("i", 7546.0, 3600.0, 400.0),
    ]:
        t = np.sort(rng.uniform(0.0, 60.0, 25))
        flux = bump(t, amp, base) + rng.normal(0.0, 120.0, t.size)
        series.append({
            "survey": "lsst", "band": band, "lambda_eff": lam,
            "mjd": t.tolist(), "flux": flux.tolist(),
            "eflux": np.full(t.size, 120.0).tolist(),
        })
    return series


def test_cov_offdiag_has_every_band_pair():
    out = fit_multiband_gp(_synthetic_three_band(), n_grid=100)
    cov = out["cov_offdiag"]
    assert set(cov.keys()) == {"g|r", "g|i", "i|r"}
    for arr in cov.values():
        assert len(arr) == 100
        assert all(math.isfinite(v) for v in arr)


def test_cov_offdiag_satisfies_cauchy_schwarz():
    """|Cov(F_b,F_c)| ≤ sqrt(V_b·V_c) at every grid point (V from flux_std)."""
    out = fit_multiband_gp(_synthetic_three_band(), n_grid=80)
    grid = {x["band"]: x for x in out["grid"]}
    for key, arr in out["cov_offdiag"].items():
        b, c = key.split("|")
        Vb = np.array(grid[b]["flux_std"]) ** 2
        Vc = np.array(grid[c]["flux_std"]) ** 2
        bound = np.sqrt(Vb * Vc)
        cov = np.array(arr)
        # Tiny tolerance for float roundoff at the saturating bound.
        assert np.all(np.abs(cov) <= bound + 1e-6 * bound + 1e-9)


def test_cov_offdiag_positive_for_correlated_bands():
    """The wavelength kernel correlates the bands, so the same-time flux
    covariance is positive where both bands are well-measured (near the bump)."""
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=120)
    g = next(x for x in out["grid"] if x["band"] == "g")
    arr = np.array(out["cov_offdiag"]["g|r"])
    # Index nearest the bump centre (MJD 30) — both bands strongly measured.
    k = min(range(len(g["mjd"])), key=lambda i: abs(g["mjd"][i] - 30.0))
    assert arr[k] > 0


def test_covariance_reduces_color_error_vs_naive():
    """Validates the documented color-error formula: at a well-positive grid
    point the variance computed WITH the cross-covariance term is finite, ≥0,
    and strictly smaller than the naive (cov=0) variance — exactly the
    over-estimate the panel avoids."""
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=120)
    g = next(x for x in out["grid"] if x["band"] == "g")
    r = next(x for x in out["grid"] if x["band"] == "r")
    cov = np.array(out["cov_offdiag"]["g|r"])
    Fg, Fr = np.array(g["flux_mean"]), np.array(r["flux_mean"])
    Vg, Vr = np.array(g["flux_std"]) ** 2, np.array(r["flux_std"]) ** 2
    k = min(range(len(g["mjd"])), key=lambda i: abs(g["mjd"][i] - 30.0))
    a = 2.5 / math.log(10)
    var_naive = a * a * (Vg[k] / Fg[k] ** 2 + Vr[k] / Fr[k] ** 2)
    var_cov = var_naive - a * a * 2 * cov[k] / (Fg[k] * Fr[k])
    assert math.isfinite(var_cov)
    assert var_cov >= 0
    assert var_cov < var_naive  # positive Cov(F_g,F_r) shrinks the color error


def test_folded_bundle_has_cov_offdiag_on_phase_grid():
    """The covariance ships for the folded (phase) fit too, length-matched to the
    phase grid so colors-over-phase get the same proper errors."""
    series = _synthetic_two_band()
    out = fit_multiband_gp(series, n_grid=60, fold_period=3.5)
    assert out["folded"] is True
    assert "g|r" in out["cov_offdiag"]
    assert len(out["cov_offdiag"]["g|r"]) == 60
