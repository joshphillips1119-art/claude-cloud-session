"""Session-trend gate (research/backlog.md item 16c), as a strategy.

Most of the live weight sits on fades, which lose together on directional
days. This measures, causally and within the current UTC session, how
directional the day has been so far:

* Kaufman efficiency ratio ER_t = |C_t - O_session| / sum |C_s - C_{s-1}| over
  the session's bars so far (needs at least ``m`` bars);
* distance d_t = |ln(C_t / O_session)| divided by the typical size of that
  quantity at the same time of day over the previous ``d_days`` sessions
  (``same_slot``), so a 0.5% move at 02:00 UTC counts for more than at 15:00.

gate_t = clip((ER_t - er0) / er_w, 0, 1) * clip(d_t / d0, 0, 1). The score
follows the session's direction only when the gate says it is a trend day:
score_t = gate_t * sign(C_t - O_session), else 0. With ``_sign=-1`` it fades
trend days instead. If the strategy version shows anything, the framework
change in the backlog (multiply reversal-family scores by 1 - gate) is next.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


@register(
    "trend_day_fade_gate",
    defaults={"er0": 0.1, "er_w": 0.2, "d0": 1.0, "m": 24, "d_days": 14},
    grid={"er0": [0.1, 0.2], "er_w": [0.1, 0.2], "d0": [1.0, 1.5], "m": [24, 48]},
    category="regime",
    description="Follow the UTC session's direction only once the day is clearly directional "
                "(efficiency ratio and a seasonally scaled distance from the open).",
    source="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172",
)
def trend_day_fade_gate(df, er0, er_w, d0, m, d_days):
    close = df["close"]
    key = ind.session_key(df.index)
    grp = close.groupby(key.values, group_keys=False)
    o_session = grp.transform("first")
    bars_in = grp.cumcount() + 1
    net = (close - o_session).abs()
    path = close.diff().abs().groupby(key.values, group_keys=False).cumsum()
    er = net / path.replace(0.0, np.nan)
    dist = np.log(close / o_session).abs()
    scale = ind.same_slot(dist, d_days, "mean", min_days=3)
    d = dist / scale.replace(0.0, np.nan)
    gate = ((er - er0) / er_w).clip(0.0, 1.0) * (d / d0).clip(0.0, 1.0)
    score = gate * np.sign(close - o_session)
    score = score.where(bars_in >= m, 0.0)
    # No opinion until the time-of-day scale exists (needs 3 prior sessions).
    return score.where(scale.notna())
