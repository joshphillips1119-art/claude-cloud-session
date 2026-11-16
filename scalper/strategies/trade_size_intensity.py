"""Trade-size versus trade-count conditioned direction (research/backlog.md item 14).

Binance klines carry the number of trades per bar, so average trade size is
ATS_t = V_t / NT_t. The hypothesis (Llorente-Michaely-Saar-Wang: informed
flow continues, hedging / noise flow reverses; Jones-Kaul-Lipson and Ane-Geman:
the trade *count* is the clock) is that a bar printed with unusually large
average trades carries informed flow and continues, while a bar printed with a
burst of many small trades is transient pressure and reverses.

Score_t = sign(r_t) * tanh(|rt_t| / kappa) * tanh(a * zA_t - b * zN_t)

* rt_t: this bar's log return standardised by an EWM volatility, after removing
  the intraday volatility smile (same construction as kyle_impact_residual).
* zA_t: robust z of ln ATS_t; zN_t: robust z of ln NT_t. With seasonal=True both
  are measured against the same time-of-day slot over the previous L/288 days
  (median and 1.4826 * MAD, strictly earlier days); with seasonal=False against
  the trailing L bars (mean and std, rows <= t).
* A positive bracket says "continue bar t's direction", a negative one says
  "reverse it". ``_sign`` flips the whole thing, so a = 1, b = 0 with
  _sign = -1 is "fade bars printed with large average trades".

Crypto only: with no ``trades`` column the strategy has no opinion.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

BARS_PER_DAY = 288


def _robust_slot_z(x: pd.Series, n_days: int) -> pd.Series:
    """(x - median) / (1.4826 * MAD) at the same time-of-day slot over the previous
    n_days days. The MAD is the same-slot median of earlier days' absolute
    deviations from their own running medians (a causal approximation of the
    exact slot MAD)."""
    med = ind.same_slot(x, n_days, "median")
    dev = (x - med).abs()
    mad = ind.same_slot(dev, n_days, "median")
    scale = (1.4826 * mad).replace(0.0, np.nan)
    return (x - med) / scale


@register(
    "trade_size_intensity",
    defaults={"L": 2016, "kappa": 1.0, "a": 1.0, "b": 0.0, "seasonal": True},
    grid={"L": [2016, 8640], "kappa": [0.5, 2.0], "a": [0.0, 1.0], "b": [0.0, 1.0], "seasonal": [True, False]},
    category="order_flow",
    description="Continue (or fade, via _sign) the last bar according to whether it printed with "
                "unusually large average trade size (informed) or an unusual burst of trade count (noise).",
    requires=("open", "high", "low", "close", "volume", "trades"),
    source="https://www.johnhcochrane.com/s/llorente_michaely_saar_wang_volume_rfs.pdf",
)
def trade_size_intensity(df, L, kappa, a, b, seasonal):
    close = df["close"].astype(float)
    r = ind.log_returns(close)
    if a == 0.0 and b == 0.0 or "trades" not in df.columns or not df["trades"].notna().any():
        return pd.Series(np.nan, index=df.index)

    # Standardised return of bar t (causal: sigma lagged one bar, seasonal smile removed).
    s_slot = ind.seasonal_vol_factor(close).fillna(1.0)
    a_ew = 1.0 - 0.5 ** (1.0 / BARS_PER_DAY)
    sigma = np.sqrt((r / s_slot).pow(2).ewm(alpha=a_ew, adjust=False, min_periods=BARS_PER_DAY).mean())
    rt = (r / (s_slot * sigma.shift(1)).replace(0.0, np.nan)).clip(-10, 10)

    vol = df["volume"].astype(float)
    nt = df["trades"].astype(float).clip(lower=1.0)
    ats = (vol / nt).replace(0.0, np.nan)
    ln_ats = np.log(ats)
    ln_nt = np.log(nt)

    L = int(L)
    if seasonal:
        n_days = max(2, L // BARS_PER_DAY)
        zA = _robust_slot_z(ln_ats, n_days)
        zN = _robust_slot_z(ln_nt, n_days)
    else:
        mp = min(L, BARS_PER_DAY)
        zA = (ln_ats - ln_ats.rolling(L, min_periods=mp).mean()) / ln_ats.rolling(L, min_periods=mp).std().replace(0.0, np.nan)
        zN = (ln_nt - ln_nt.rolling(L, min_periods=mp).mean()) / ln_nt.rolling(L, min_periods=mp).std().replace(0.0, np.nan)
    zA = zA.clip(-5, 5)
    zN = zN.clip(-5, 5)

    bracket = np.tanh(a * zA - b * zN)
    score = np.sign(r) * np.tanh(rt.abs() / kappa) * bracket
    warm = rt.notna() & zA.notna() & zN.notna()
    return score.where(vol > 0, 0.0).fillna(0.0).where(warm, np.nan)
