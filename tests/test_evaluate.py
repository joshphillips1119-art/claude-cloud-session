import math

import numpy as np
import pandas as pd

from scalper.evaluate import forward_returns, metrics, wilson, window_mask
from scalper.ensemble import combine, hedge_update, tune_threshold


def _df(closes, start="2026-09-01", gaps=()):
    idx = pd.date_range(start, periods=len(closes), freq="5min", tz="UTC")
    idx = idx.delete(list(gaps)) if gaps else idx
    closes = np.delete(np.array(closes, float), list(gaps)) if gaps else np.array(closes, float)
    return pd.DataFrame({"open": closes, "high": closes, "low": closes, "close": closes, "volume": 1.0}, index=idx)


def test_forward_returns_and_gaps():
    df = _df([100, 101, 100, 102, 103], gaps=[3])  # bar 3 missing
    fwd = forward_returns(df)
    assert math.isclose(fwd.iloc[0], math.log(101 / 100))
    assert np.isnan(fwd.iloc[2]), "label across a gap must be NaN"
    assert np.isnan(fwd.iloc[-1])


def test_open_to_close_mode():
    df = _df([100, 101, 102])
    df["open"] = [100, 100.5, 101.5]
    fwd = forward_returns(df, mode="open_to_close")
    assert math.isclose(fwd.iloc[0], math.log(101 / 100.5))


def test_metrics_hand_example():
    idx = pd.date_range("2026-09-01", periods=6, freq="5min", tz="UTC")
    fwd = pd.Series([0.01, -0.01, 0.02, 0.0, -0.02, np.nan], index=idx)
    score = pd.Series([1.0, 1.0, 0.5, 1.0, -0.2, 1.0], index=idx)
    m = metrics(score, fwd)
    # valid non-zero labels: bars 0,1,2,4 -> preds +,+,+,- vs +,-,+,- -> 3/4
    assert m["n"] == 4 and m["hits"] == 3 and m["acc"] == 0.75
    assert math.isclose(m["z"], (3 - 2) / 1.0)
    wz = (1 - 1 + 0.5 + 0.2) / math.sqrt(1 + 1 + 0.25 + 0.04)
    assert math.isclose(m["wz"], round(wz, 3))
    m2 = metrics(score, fwd, threshold=0.6)
    assert m2["n"] == 2 and m2["hits"] == 1


def test_wilson_bounds():
    lo, hi = wilson(55, 100)
    assert 0.45 < lo < 0.46 and 0.64 < hi < 0.65
    assert wilson(0, 0) == (0.0, 1.0)


def test_window_mask_embargo():
    idx = pd.date_range("2026-09-01", periods=288 * 2, freq="5min", tz="UTC")
    m = window_mask(idx, ["2026-09-01"], embargo_bars=2)
    assert m.sum() == 286
    assert not m.iloc[286] and m.iloc[285]


def test_combine_ignores_warmup_nans():
    idx = pd.date_range("2026-09-01", periods=3, freq="5min", tz="UTC")
    a = pd.Series([np.nan, 1.0, 1.0], index=idx)
    b = pd.Series([-0.5, -0.5, np.nan], index=idx)
    out = combine({"a": a, "b": b}, {"a": 0.5, "b": 0.5})
    assert list(out.round(3)) == [-0.5, 0.25, 1.0]


def test_hedge_moves_weight_to_winner_and_keeps_floor():
    w = {"a": 0.5, "b": 0.5}
    for _ in range(30):
        w = hedge_update(w, {"a": 2.0, "b": -2.0}, eta=0.3, share=0.05)
    assert w["a"] > 0.9
    assert w["b"] >= 0.05 / 2 - 1e-9, "fixed share keeps a floor so b can recover"
    assert math.isclose(sum(w.values()), 1.0, abs_tol=1e-5)


def test_tune_threshold_respects_coverage():
    idx = pd.date_range("2026-09-01", periods=1000, freq="5min", tz="UTC")
    rng = np.random.default_rng(0)
    fwd = pd.Series(rng.standard_normal(1000), index=idx)
    ens = pd.Series(rng.uniform(-1, 1, 1000), index=idx)
    big = ens.abs() > 0.95
    ens[big] = np.sign(fwd[big]) * ens[big].abs()  # only extreme scores are informative
    res = tune_threshold(ens, fwd, [0.0, 0.5, 0.9], 0.0, min_coverage=0.2, min_gain=0.5)
    assert res["threshold"] in (0.0, 0.5)  # 0.9 has ~5% coverage, below the floor
