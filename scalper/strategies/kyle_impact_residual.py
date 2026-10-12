"""Kyle-lambda impact residual (research/backlog.md item 6).

Fit the contemporaneous price-impact line rt_s = a + lam*sf_s (standardised
return on seasonally-scaled signed volume) over the previous W bars. The
residual of the last n bars says whether price over-shot the flow (fade it) or
under-reacted to it (the unpriced flow should continue). Score =
-tanh(u / (c * sd_e * sqrt(n))).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

BARS_PER_DAY = 288


def _rolling_prev(s: pd.Series, W: int, min_periods: int) -> pd.Series:
    """Rolling sum over [t-W, t-1] (excludes bar t)."""
    return s.rolling(W, min_periods=min_periods).sum().shift(1)


@register(
    "kyle_impact_residual",
    defaults={"W": 864, "n": 1, "c": 1.0, "impact": "linear", "flow_src": "taker",
              "vol_days": 20, "winsor": True},
    grid={"W": [288, 864, 2016], "n": [1, 3, 6], "c": [1.0, 2.0], "impact": ["linear", "sqrt"]},
    category="order_flow",
    description="Fade price moves larger than a rolling impact regression on signed taker volume "
                "explains; follow flow that price has not yet absorbed.",
    requires=("open", "high", "low", "close", "volume"),
    source="https://arxiv.org/abs/1011.6402",
)
def kyle_impact_residual(df, W, n, c, impact, flow_src, vol_days, winsor):
    close = df["close"]
    r = ind.log_returns(close)
    s_slot = ind.seasonal_vol_factor(close).fillna(1.0)
    a_ew = 1.0 - 0.5 ** (1.0 / BARS_PER_DAY)
    sigma = np.sqrt((r / s_slot).pow(2).ewm(alpha=a_ew, adjust=False, min_periods=BARS_PER_DAY).mean())
    rt = (r / (s_slot * sigma.shift(1)).replace(0.0, np.nan)).clip(-10, 10)

    vol = df["volume"]
    if flow_src == "taker" and "taker_buy_volume" in df:
        f = (2.0 * df["taker_buy_volume"] / vol.replace(0.0, np.nan) - 1.0).fillna(0.0)
    else:  # close-location value: OHLC-only fallback
        rng = (df["high"] - df["low"]).replace(0.0, np.nan)
        f = (((close - df["low"]) - (df["high"] - close)) / rng).fillna(0.0)
    med = ind.same_slot(vol, vol_days, "median", min_days=3)
    med = med.fillna(vol.rolling(BARS_PER_DAY, min_periods=48).median().shift(1))
    vs = vol / med.replace(0.0, np.nan)
    sf = f * vs if impact == "linear" else np.sign(f) * np.sqrt((f * vs).abs())
    if winsor:  # clip at the 0.5/99.5 percentiles of the trailing fit window
        lo = sf.rolling(W, min_periods=W // 2).quantile(0.005).shift(1)
        hi = sf.rolling(W, min_periods=W // 2).quantile(0.995).shift(1)
        sf = sf.clip(lo, hi)

    ok = rt.notna() & sf.notna()
    x = sf.where(ok)
    y = rt.where(ok)
    mp = int(0.8 * W)
    cnt = _rolling_prev(ok.astype(float), W, 1)
    sx = _rolling_prev(x.fillna(0.0), W, 1)
    sy = _rolling_prev(y.fillna(0.0), W, 1)
    sxx = _rolling_prev((x * x).fillna(0.0), W, 1)
    sxy = _rolling_prev((x * y).fillna(0.0), W, 1)
    syy = _rolling_prev((y * y).fillna(0.0), W, 1)
    cov = sxy - sx * sy / cnt
    var_x = sxx - sx * sx / cnt
    lam = cov / var_x.replace(0.0, np.nan)
    a = (sy - lam * sx) / cnt
    sse = (syy - sy * sy / cnt) - lam * cov
    sd_e = np.sqrt((sse / (cnt - 2)).clip(lower=0.0)).replace(0.0, np.nan)

    R_n = rt.rolling(n, min_periods=n).sum()
    SF_n = sf.rolling(n, min_periods=n).sum()
    u = R_n - (n * a + lam * SF_n)
    score = -np.tanh(u / (c * sd_e * np.sqrt(n)))

    valid = (cnt >= mp) & (lam > 0)
    return score.where(valid, 0.0).fillna(0.0).where(sigma.shift(1).notna(), np.nan)
