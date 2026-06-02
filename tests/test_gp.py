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


def test_hyperparameters_are_reported_in_physical_units():
    out = fit_multiband_gp(_synthetic_two_band(), n_grid=60)
    hp = out["hyperparams"]
    assert hp["l_t_days"] > 0
    assert hp["l_lambda_kA"] > 0
    assert hp["sigma_f_njy"] > 0
    assert hp["jitter_njy"] >= 0


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
