"""Volatility-standardised large-move (drift-burst) reversal (research/backlog.md item 5).

When the last ``m`` bars moved at least ``theta`` seasonally-adjusted standard
deviations (sigma measured *before* the move) on at least ``v_min`` times the
usual volume for those time-of-day slots, fade the move. The bet decays over
``decay_bars`` bars and is cancelled once half the move has reversed.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

BARS_PER_DAY = 288


@register(
    "large_move_reversal",
    defaults={"m": 1, "theta": 3.0, "theta_w": 2.0, "v_min": 0.0, "side": "both",
              "decay_bars": 3, "vol_days": 20},
    grid={"m": [1, 3, 6], "theta": [2.5, 3.5], "v_min": [0.0, 1.5], "decay_bars": [0, 3]},
    category="mean_reversion",
    description="Fade m-bar moves of >= theta seasonal sigmas (sigma from before the move) on "
                "heavy volume; decays over decay_bars and cancels once half-reversed.",
    source="https://repec.econ.au.dk/repec/creates/rp/16/rp16_28.pdf",
)
def large_move_reversal(df, m, theta, theta_w, v_min, side, decay_bars, vol_days):
    close = df["close"]
    r = ind.log_returns(close)
    s_slot = ind.seasonal_vol_factor(close).fillna(1.0)
    a = 1.0 - 0.5 ** (1.0 / BARS_PER_DAY)
    sigma = np.sqrt((r / s_slot).pow(2).ewm(alpha=a, adjust=False, min_periods=BARS_PER_DAY).mean())

    move = np.log(close / close.shift(m))
    scale = sigma.shift(m) * np.sqrt((s_slot**2).rolling(m, min_periods=m).sum())
    z = (move / scale.replace(0.0, np.nan)).to_numpy()

    vol = df["volume"]
    med = ind.same_slot(vol, vol_days, "median", min_days=3)
    vr = (vol.rolling(m, min_periods=m).sum()
          / med.rolling(m, min_periods=m).sum().replace(0.0, np.nan)).to_numpy()

    c = close.to_numpy()
    c_m = close.shift(m).to_numpy()
    n = len(c)
    out = np.zeros(n)
    life = max(1, 3 * decay_bars)
    e = 0.0
    t0 = -1
    zsign = 0.0
    c0 = move0 = 0.0
    for t in range(n):
        zt = z[t]
        if np.isfinite(zt) and abs(zt) >= theta and (v_min <= 0 or (np.isfinite(vr[t]) and vr[t] >= v_min)) \
                and (side == "both" or zt < 0):
            e = -np.sign(zt) * min(1.0, 0.25 + (abs(zt) - theta) / theta_w)
            t0, zsign, c0, move0 = t, np.sign(zt), c[t], abs(c[t] - c_m[t])
        if t0 < 0 or t - t0 >= life:
            continue
        if t > t0 and -zsign * (c[t] - c0) >= 0.5 * move0:
            t0 = -1  # half the move has reversed: the bet is done
            continue
        if decay_bars == 0:
            out[t] = e if t == t0 else 0.0
        else:
            out[t] = e * np.exp(-(t - t0) / decay_bars)

    score = pd.Series(out, index=df.index)
    return score.where(sigma.shift(m).notna(), np.nan)
