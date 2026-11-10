"""VPIN toxicity-gated short-horizon signed flow (research/backlog.md item 10).

VPIN (Easley, Lopez de Prado, O'Hara) measures how one-sided recent volume has
been: sum |Vb - Vs| / sum V over the last n bars. It is a magnitude / regime
variable, not a direction, so it is used as a gate: when VPIN sits in the top
(1 - p0) of its trailing L-bar distribution the last m bars' signed flow is
given full weight, and when it is low the flow is treated as noise. Whether
one-sided flow in a toxic regime continues or is faded is left to ``_sign``.

Buy volume comes from the taker-buy column where the venue provides it, and
otherwise from bulk volume classification (BVC) on close changes.

Score_t = g_t * tanh(OI_t / c), with
  g_t  = clip((pctrank_L(VPIN_t) - p0) / (1 - p0), 0, 1)
  OI_t = sum_{k<m}(Vb - Vs)_{t-k} / sum_{k<m} V_{t-k}
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

BARS_PER_DAY = 288


def _buy_volume(df: pd.DataFrame, flow_src: str) -> pd.Series:
    vol = df["volume"]
    if flow_src == "taker" and "taker_buy_volume" in df.columns and df["taker_buy_volume"].notna().any():
        return df["taker_buy_volume"].astype(float)
    frac = ind.bvc_buy_fraction(df["close"], BARS_PER_DAY)
    return vol * frac


@register(
    "vpin_gated_flow",
    defaults={"n": 12, "m": 1, "p0": 0.5, "L": 2016, "c": 0.2, "flow_src": "taker"},
    grid={"n": [12, 50], "m": [1, 3], "p0": [0.5, 0.8], "L": [864, 2016], "c": [0.2, 0.4]},
    category="order_flow",
    description="Signed taker flow over the last m bars, weighted by how toxic (one-sided) the "
                "trailing n-bar VPIN is versus its L-bar history; follow or fade with _sign.",
    requires=("open", "high", "low", "close", "volume"),
    source="https://stoye.economics.cornell.edu/docs/Easley_ssrn-4814346.pdf",
)
def vpin_gated_flow(df, n, m, p0, L, c, flow_src):
    vol = df["volume"].astype(float)
    vb = _buy_volume(df, flow_src).clip(lower=0.0)
    vb = vb.clip(upper=vol)
    vs = vol - vb
    signed = vb - vs

    # Bar-time VPIN over the last n bars (includes bar t; causal).
    v_n = vol.rolling(n, min_periods=n).sum()
    vpin = signed.abs().rolling(n, min_periods=n).sum() / v_n.replace(0.0, np.nan)

    # Percentile rank of today's VPIN inside its trailing L-bar window (ending at t).
    mp = min(int(L), BARS_PER_DAY)
    rank = vpin.rolling(int(L), min_periods=mp).rank(pct=True)
    gate = ((rank - p0) / (1.0 - p0)).clip(0.0, 1.0)

    # Short signed imbalance over the last m bars.
    v_m = vol.rolling(m, min_periods=m).sum()
    oi = signed.rolling(m, min_periods=m).sum() / v_m.replace(0.0, np.nan)

    score = gate * np.tanh(oi / c)
    # No opinion (0) when volume was zero or the gate is closed; NaN only while warming up.
    score = score.where(v_m > 0, 0.0).where(v_n > 0, 0.0)
    warm = rank.notna() & vpin.notna()
    return score.fillna(0.0).where(warm, np.nan)
