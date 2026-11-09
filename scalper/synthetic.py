"""Synthetic 5-minute bars with known, switchable structure, for tests and
for checking that the learning loop finds real edges and ignores noise."""
from __future__ import annotations

import numpy as np
import pandas as pd


def generate(days: int, start: str = "2026-09-01", seed: int = 0, phi=0.0, flow_beta: float = 0.0,
             base_vol_bps: float = 12.0, price: float = 60_000.0) -> pd.DataFrame:
    """``phi`` is the lag-1 return autocorrelation: a float, or a callable
    ``phi(day_index) -> float`` for regime switches. ``flow_beta`` makes the
    taker-buy imbalance of bar t predictive of bar t+1."""
    per_day = 288
    n = days * per_day
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, periods=n, freq="5min", tz="UTC")
    day_i = np.arange(n) // per_day
    phis = np.array([phi(d) if callable(phi) else phi for d in range(days)])[day_i]

    hour = idx.hour.to_numpy()
    season = 1.0 + 0.35 * np.exp(-0.5 * ((hour - 14.5) / 2.0) ** 2)  # US-session vol bump
    h = np.zeros(n)
    for t in range(1, n):
        h[t] = 0.97 * h[t - 1] + 0.15 * rng.standard_normal()
    sigma = base_vol_bps / 1e4 * season * np.exp(0.5 * h)

    flow = rng.standard_normal(n)
    eps = rng.standard_normal(n)
    r = np.zeros(n)
    for t in range(1, n):
        pred = phis[t] * r[t - 1] * sigma[t] / max(sigma[t - 1], 1e-12) + flow_beta * sigma[t] * flow[t - 1]
        r[t] = pred + sigma[t] * eps[t] * np.sqrt(max(1e-9, 1 - phis[t] ** 2))

    close = price * np.exp(np.cumsum(r))
    open_ = np.concatenate([[price], close[:-1]])
    wick = np.abs(rng.standard_normal((2, n))) * sigma * 0.6
    high = np.maximum(open_, close) * np.exp(wick[0])
    low = np.minimum(open_, close) * np.exp(-wick[1])
    volume = 50.0 * (1 + np.abs(r) / sigma) * rng.lognormal(0, 0.3, n)
    ratio = 0.5 + 0.12 * np.tanh(flow)
    return pd.DataFrame({
        "open": open_, "high": high, "low": low, "close": close, "volume": volume,
        "taker_buy_volume": volume * ratio, "trades": np.round(volume * 20),
    }, index=pd.DatetimeIndex(idx, name="ts"))
