"""Noise-area intraday momentum with a VWAP trailing stop (research/backlog.md item 2).

Zarattini, Aziz & Barbon, 'Beat the Market' (SFI WP 24-97): a close outside a
time-of-day noise band around the session open, confirmed by session VWAP,
signals an imbalance that tends to persist; the band and VWAP trail the position.
For crypto the session anchor is conventional, so it is tuned (00:00 UTC or the
09:30 New York open, both as 24h sessions). There is no overnight gap, so
Cprev ~= O_s and the band is centred on the session open.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

_BAR = pd.Timedelta(minutes=5)


def _session_start(index: pd.DatetimeIndex, anchor: str) -> pd.DatetimeIndex:
    if anchor == "us_open_ny":
        ny = index.tz_convert("America/New_York")  # bars are tz-aware UTC
        shifted = ny - pd.Timedelta(hours=9, minutes=30)
        start = shifted.tz_localize(None).floor("D") + pd.Timedelta(hours=9, minutes=30)
        start = start.tz_localize("America/New_York", ambiguous="NaT", nonexistent="shift_forward")
        return start.tz_convert(index.tz)
    return index.floor("D")


@register(
    "noise_area_breakout",
    defaults={"variant": "noise_area", "anchor": "us_open_ny", "D": 14, "mult": 1.0,
              "check_every": 6, "vwap_stop": True, "m_min": 0.3, "g": 3.0,
              "deadzone_atr": 0.25},
    grid={"variant": ["noise_area", "vwap_only"], "anchor": ["00:00UTC", "us_open_ny"],
          "mult": [0.75, 1.0, 1.5], "check_every": [1, 6]},
    category="breakout",
    description="Hold the side of a close outside the time-of-day noise band around the "
                "session open (VWAP-confirmed, band/VWAP trailing stop); or the side of session VWAP.",
    source="https://www.sfi.ch/de/publications/n-24-97-beat-the-market-an-effective-intraday-momentum-strategy-for-s-p500-etf-spy",
)
def noise_area_breakout(df, variant, anchor, D, mult, check_every, vwap_stop, m_min, g, deadzone_atr):
    idx = df.index
    close = df["close"].to_numpy(dtype=float)
    start = _session_start(idx, anchor)
    key = pd.Series(start, index=idx)
    j = pd.Series(((idx - start) / _BAR), index=idx).round().astype("Int64")

    typical = (df["high"] + df["low"] + df["close"]) / 3.0
    pv = (typical * df["volume"]).groupby(key.values).cumsum()
    vv = df["volume"].groupby(key.values).cumsum()
    vwap = (pv / vv.replace(0.0, np.nan)).fillna(typical).to_numpy(dtype=float)

    # Session open: the open of the anchor bar itself; partial sessions (data starts
    # mid-session or the anchor bar is missing) have no O_s and stay flat.
    first_open = df["open"].groupby(key.values).transform("first")
    first_j = j.groupby(key.values).transform("first")
    o_s = first_open.where(first_j == 0)

    # Noise width per slot j: mean |C/O_s - 1| over the D previous sessions at that slot.
    dev = (df["close"] / o_s - 1.0).abs()
    min_n = max(1, math.ceil(0.7 * D))
    sig = dev.groupby(j.values, group_keys=False).transform(
        lambda s: s.shift(1).rolling(D, min_periods=min_n).mean())
    o_s_a = o_s.to_numpy(dtype=float)
    sig_a = sig.to_numpy(dtype=float)
    j_a = j.fillna(-1).to_numpy(dtype=np.int64)
    key_a = key.to_numpy()

    n = len(df)
    score = np.zeros(n)
    pos = 0
    if variant == "vwap_only":
        atr = ind.atr(df, 14).to_numpy(dtype=float)
        for t in range(n):
            if t == 0 or key_a[t] != key_a[t - 1]:
                pos = 0
            a = atr[t]
            if j_a[t] < 6 or not np.isfinite(a) or a <= 0:
                continue
            d = close[t] - vwap[t]
            if abs(d) > deadzone_atr * a:
                pos = int(np.sign(d))
            score[t] = pos * min(1.0, abs(d) / a)
    else:
        for t in range(n):
            if t == 0 or key_a[t] != key_a[t - 1]:
                pos = 0
            o, s = o_s_a[t], sig_a[t]
            if not (np.isfinite(o) and np.isfinite(s) and s > 0):
                pos = 0
                continue
            ub, lb, c, v = o * (1 + mult * s), o * (1 - mult * s), close[t], vwap[t]
            if pos == 1 and c < (max(ub, v) if vwap_stop else ub):
                pos = 0
            elif pos == -1 and c > (min(lb, v) if vwap_stop else lb):
                pos = 0
            if (j_a[t] + 1) % check_every == 0:
                if c > ub and c > v:
                    pos = 1
                elif c < lb and c < v:
                    pos = -1
            if pos:
                e = max(0.0, (c - ub) if pos == 1 else (lb - c)) / (o * s)
                score[t] = pos * min(1.0, max(0.0, m_min + g * e))
    return pd.Series(score, index=idx)
