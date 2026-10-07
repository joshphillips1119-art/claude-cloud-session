"""Every registered strategy must be causal, bounded and deterministic.

Causality is checked mechanically: the score computed on a prefix of the data
must equal the score computed on the full data, bar for bar. Any lookahead
(centred windows, negative shifts, full-sample normalisation) breaks this.
"""
import numpy as np
import pandas as pd
import pytest

from scalper import strategies as S

S.load_all()
NAMES = sorted(S.REGISTRY)
CUTS = [400, 777, 1100, 1500]


@pytest.mark.parametrize("name", NAMES)
@pytest.mark.parametrize("which", ["defaults", "grid_extremes"])
def test_prefix_stable(bars, name, which):
    strat = S.REGISTRY[name]
    grid = S.full_grid(strat)
    params_list = [S.canonical(strat, strat.defaults)] if which == "defaults" else [grid[0], grid[-1]]
    for params in params_list:
        full = S.compute(name, bars, params)
        for k in CUTS:
            part = S.compute(name, bars.iloc[: k + 1], params)
            a, b = part.to_numpy(), full.iloc[: k + 1].to_numpy()
            same_nan = np.isnan(a) == np.isnan(b)
            assert same_nan.all(), f"{name}{params}: NaN pattern differs on prefix {k}"
            m = ~np.isnan(a)
            assert np.allclose(a[m], b[m], atol=1e-9), f"{name}{params}: lookahead detected at cut {k}"


@pytest.mark.parametrize("name", NAMES)
def test_bounded_and_informative(bars, name):
    strat = S.REGISTRY[name]
    s = S.compute(name, bars, S.canonical(strat, strat.defaults))
    assert len(s) == len(bars) and s.index.equals(bars.index)
    vals = s.dropna()
    assert ((vals >= -1) & (vals <= 1)).all()
    tail = s.iloc[len(s) // 2:]
    assert tail.notna().mean() > 0.9, f"{name} mostly NaN after warm-up"
    assert (tail.fillna(0) != 0).any(), f"{name} never has an opinion"


@pytest.mark.parametrize("name", NAMES)
def test_deterministic_and_sign_flip(bars, name):
    strat = S.REGISTRY[name]
    p = S.canonical(strat, strat.defaults)
    a = S.compute(name, bars, p)
    b = S.compute(name, bars, p)
    pd.testing.assert_series_equal(a, b)
    if strat.invertible:
        flipped = S.compute(name, bars, {**p, "_sign": -1})
        np.testing.assert_allclose(flipped.fillna(0).to_numpy(), -a.fillna(0).to_numpy())


@pytest.mark.parametrize("name", NAMES)
def test_does_not_mutate_input(bars, name):
    before = bars.copy()
    S.compute(name, bars, {})
    pd.testing.assert_frame_equal(bars, before)


def test_missing_inputs_give_nan(bars):
    no_flow = bars.drop(columns=["taker_buy_volume"])
    for name, strat in S.REGISTRY.items():
        if "taker_buy_volume" in strat.requires:
            assert S.compute(name, no_flow, {}).isna().all()


def test_registry_metadata():
    for name, strat in S.REGISTRY.items():
        assert strat.category and strat.description, name
        assert 1 <= len(S.full_grid(strat)) <= 400, f"{name}: grid too large to tune daily"
