"""Short-horizon candle reversal with a taker-flow gate (research/backlog.md item 1)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


@register(
    "short_horizon_reversal",
    defaults={"K": 1, "lam": 1.0, "mode": "sign", "w0": 1.0,
              "ret_def": "cc", "kappa": 1.0, "theta": 0.0, "I_ref": 0.3, "vol_n": 288},
    grid={"K": [1, 3, 6], "lam": [0.6, 1.0], "mode": ["sign", "mag"], "w0": [0.5, 1.0]},
    category="mean_reversion",
    description="Fade a decay-weighted kernel of the last K candles' signs (or sizes), "
                "stronger after bars whose move agreed with intense taker flow.",
    invertible=False,
    source="https://arxiv.org/abs/2608.21888",
)
def short_horizon_reversal(df, K, lam, mode, w0, ret_def, kappa, theta, I_ref, vol_n):
    close = df["close"]
    r = ind.log_returns(close)
    sigma = ind.realized_vol(close, vol_n).shift(1).replace(0.0, np.nan)
    if ret_def == "oc":
        s_slot = ind.seasonal_vol_factor(close).fillna(1.0)
        x = (np.log(close / df["open"]) / (s_slot * sigma)).clip(-10, 10)
    else:
        x = r / sigma if mode == "mag" else r

    phi = np.sign(x) if mode == "sign" else x.clip(-2, 2) / 2.0
    w = lam ** np.arange(K)
    u = sum(w[k] * phi.shift(k) for k in range(K)) / w.sum()

    gate = pd.Series(1.0, index=df.index)
    if w0 < 1.0 and "taker_buy_volume" in df:
        vol = df["volume"].replace(0.0, np.nan)
        i = 2.0 * df["taker_buy_volume"] / vol - 1.0
        flow_driven = ((np.sign(i) == np.sign(r)) & (i.abs() >= theta)).astype(float)
        med = ind.same_slot(df["volume"], 10, "median")
        med = med.fillna(df["volume"].rolling(288, min_periods=48).median().shift(1))
        vs = (df["volume"] / med.replace(0.0, np.nan)).fillna(1.0)
        intensity = i.abs().fillna(0.0) * vs.clip(upper=3.0)
        gate = w0 + (1.0 - w0) * flow_driven * (intensity / I_ref).clip(upper=1.0)

    score = -(kappa * u * gate).clip(-1.0, 1.0)
    # Warm-up: K+1 bars for the sign kernel; sigma's window for anything that needs it.
    ready = r.notna().rolling(K, min_periods=K).sum() == K
    if mode == "mag" or ret_def == "oc":
        ready &= sigma.rolling(K, min_periods=K).count() == K
    return score.where(ready, 0.0).where(close.index >= close.index[min(K, len(close) - 1)])
