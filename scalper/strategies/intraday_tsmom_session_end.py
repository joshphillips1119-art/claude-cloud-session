"""End-of-session intraday time-series momentum (research/backlog.md item 3).

Gao, Han, Li & Zhou (JFE 2018) and Baltussen, Da, Lammers & Martens (JFE 2021):
the return so far in a session (or its first half hour) predicts the last 30-60
minutes, plausibly through short-gamma hedging and late rebalancing. The score is
active only when bar t+1 is one of the last L_min/5 bars of the session.

For crypto the session anchor is conventional: '00:00UTC' (24h sessions) or
'equity_rth' (09:30-16:00 New York, weekdays). P0 is the open of the session's
first bar, which for a 24/7 market equals the close of the bar ending at A.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import register

_BAR = pd.Timedelta(minutes=5)
_N_SESS = 20
_MIN_SESS = 10


def _sessions(index: pd.DatetimeIndex, anchor: str):
    """(session start A, session end E) per bar; NaT outside a session."""
    if anchor == "equity_rth":
        ny = index.tz_convert("America/New_York")
        day = ny.tz_localize(None).floor("D")
        a = (day + pd.Timedelta(hours=9, minutes=30)).tz_localize(
            "America/New_York", ambiguous="NaT", nonexistent="shift_forward").tz_convert(index.tz)
        e = (day + pd.Timedelta(hours=16)).tz_localize(
            "America/New_York", ambiguous="NaT", nonexistent="shift_forward").tz_convert(index.tz)
        inside = (index >= a) & (index < e) & (ny.weekday < 5)
        return a.where(inside), e.where(inside)
    a = index.floor("D")
    return a, a + pd.Timedelta(days=1)


def _prev_sessions(x: pd.Series, by: np.ndarray, stat: str) -> pd.Series:
    """``stat`` of x over the previous _N_SESS sessions at the same slot (causal)."""
    def f(s):
        r = s.shift(1).rolling(_N_SESS, min_periods=_MIN_SESS)
        return r.median() if stat == "median" else r.mean()
    return x.groupby(by, group_keys=False).transform(f)


@register(
    "intraday_tsmom_session_end",
    defaults={"anchor": "00:00UTC", "mode": "rest", "F_min": 30, "L_min": 60, "c": 1.0, "delta": 0.0},
    grid={"anchor": ["equity_rth", "00:00UTC"], "mode": ["first", "rest", "gao2"],
          "L_min": [30, 60], "c": [1.0], "delta": [0.0, 1.0]},
    category="momentum",
    description="In the last L_min of a session, follow the session's return so far "
                "(or its first half hour), normalised by the same quantity in previous sessions.",
    source="https://ideas.repec.org/a/eee/jfinec/v129y2018i2p394-414.html",
)
def intraday_tsmom_session_end(df, anchor, mode, F_min, L_min, c, delta):
    idx = df.index
    if mode == "gao2" and anchor != "equity_rth":
        mode = "first"  # gao2 is defined for the cash session only
    a, e = _sessions(idx, anchor)
    a = pd.Series(a, index=idx)
    e = pd.Series(e, index=idx)
    inside = a.notna().to_numpy()
    key = a.dt.strftime("%Y-%m-%dT%H:%M").where(a.notna(), "").to_numpy()
    j = ((pd.Series(idx, index=idx) - a) / _BAR).round()
    slot = j.fillna(-1).astype(int).to_numpy()

    close = df["close"].astype(float)
    lc = np.log(close)
    grp = pd.Series(key, index=idx)
    # P0: open of the anchor bar; sessions without it (partial data) stay flat.
    first_open = df["open"].groupby(grp.values).transform("first")
    first_j = j.groupby(grp.values).transform("first")
    lp0 = np.log(first_open.where(first_j == 0))

    def at_slot(k: int) -> pd.Series:
        """log close of the bar at slot k of this session, known from that bar on."""
        v = lc.where(j == k)
        return v.groupby(grp.values).ffill()

    # Active iff bar t+1 opens in [E - L_min, E).
    nxt = pd.Series(idx + _BAR, index=idx)
    active = inside & (nxt >= e - pd.Timedelta(minutes=L_min)).to_numpy() & (nxt < e).to_numpy()

    def zscore(r: pd.Series) -> pd.Series:
        r = r.where(pd.Series(inside, index=idx))
        s_r = np.sqrt(_prev_sessions(r * r, slot, "mean"))
        return r / s_r.replace(0.0, np.nan)

    f_bars = int(F_min) // 5
    if mode == "rest":
        z = zscore(lc - lp0)
    elif mode == "first":
        z = zscore(at_slot(f_bars - 1) - lp0)
    else:
        sess_len = ((e - a) / _BAR).round()
        l_bars = int(L_min) // 5
        k_end = (sess_len - l_bars - 1).fillna(-1).astype(int)
        lc_end = lc.where(j == k_end).groupby(grp.values).ffill()
        lc_mid = lc.where(j == k_end - 6).groupby(grp.values).ffill()
        z = (zscore(at_slot(5) - lp0) + zscore(lc_end - lc_mid)) / np.sqrt(2.0)

    r1 = (lc - lc.shift(1)).where(j >= 1)
    rv = np.sqrt((r1 * r1).fillna(0.0).groupby(grp.values).cumsum())
    rv = rv.where(pd.Series(inside, index=idx))
    hv = (rv > _prev_sessions(rv, slot, "median")).astype(float)

    score = np.tanh(c * z) * (1.0 + delta * hv) / (1.0 + delta)
    out = score.where(pd.Series(active, index=idx), 0.0).fillna(0.0).clip(-1.0, 1.0)
    return out.astype(float)
