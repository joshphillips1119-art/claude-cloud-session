"""Volatility-compression breakout (research/backlog.md item 9).

Compression precedes expansion (Crabel's NR4/NR7, the TTM "squeeze" of
Bollinger Bands inside Keltner Channels). Three setups arm a box:

* ``squeeze``   - Bollinger(n, 2 sd) inside Keltner(n, k_kc ATR) for at least
                  ``min_bars`` consecutive bars; box = [min low, max high] of
                  those bars, extended while the squeeze lasts.
* ``nr``        - the bar's range is the narrowest of the last ``k`` bars
                  (NR4 / NR7); box = that bar's [low, high].
* ``nr_inside`` - ``nr`` plus an inside bar (high <= prior high, low >= prior low).

An armed box expires ``setup_window`` bars after its last qualifying bar. The
first close beyond the box by more than ``buf`` x ATR(14) is the breakout: the
score is the breakout direction, scaled by how far the close cleared the box,
decaying with ``exp(-(t - t_b) / decay_bars)`` for 3 x ``decay_bars`` bars, and
cut to zero as soon as a close falls back inside the box. Every other bar is 0
(no opinion). ``min_bars`` is derived as ``k - 1`` so one grid axis covers
both setup families. The tuner's ``_sign`` turns it into a fade of the
breakout (Bulkowski: NR7 breakouts fail to break even 46% of the time).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


def _box_setups(df: pd.DataFrame, setup: str, n: int, k_kc: float, k: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per bar: qualifying flag, and the low/high of the bar used by the box."""
    h, l, c = (df[x].to_numpy(dtype=float) for x in ("high", "low", "close"))
    if setup == "squeeze":
        mid = ind.sma(df["close"], n)
        sd = ind.rolling_std(df["close"], n)
        kc_mid = ind.ema(df["close"], n)
        kc_w = k_kc * ind.atr(df, n)
        sq = ((mid + 2.0 * sd) < (kc_mid + kc_w)) & ((mid - 2.0 * sd) > (kc_mid - kc_w))
        return sq.fillna(False).to_numpy(dtype=bool), l, h
    rng = df["high"] - df["low"]
    narrow = rng <= rng.rolling(k, min_periods=k).min()
    if setup == "nr_inside":
        narrow &= (df["high"] <= df["high"].shift(1)) & (df["low"] >= df["low"].shift(1))
    return narrow.fillna(False).to_numpy(dtype=bool), l, h


@register(
    "compression_breakout",
    defaults={"setup": "squeeze", "n": 20, "k_kc": 1.5, "k": 7, "setup_window": 6, "buf": 0.0, "decay_bars": 3},
    grid={"setup": ["squeeze", "nr", "nr_inside"], "k": [4, 7], "buf": [0.0, 0.25], "decay_bars": [1, 3, 6]},
    category="volatility",
    description="After a volatility squeeze or narrowest-range bar, follow the first close out of the box "
                "(decaying); _sign=-1 fades it.",
    source="https://thepatternsite.com/nr7.html; https://arxiv.org/abs/1812.02527; "
           "https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/"
           "technical-indicators/ttm-squeeze",
)
def compression_breakout(df, setup, n, k_kc, k, setup_window, buf, decay_bars):
    c = df["close"].to_numpy(dtype=float)
    qual, lo, hi = _box_setups(df, setup, n, k_kc, k)
    atr14 = ind.atr(df, 14).to_numpy(dtype=float)
    min_bars = max(1, k - 1)
    n_bars = len(c)
    warm = 3 * n
    score = np.zeros(n_bars)
    score[: min(warm, n_bars)] = np.nan

    run = 0                      # consecutive qualifying bars (squeeze)
    armed_until = -1             # last bar on which the box can still break
    box_lo = box_hi = np.nan
    bo_dir, bo_t, bo_mag = 0, -1, 0.0
    horizon = 3 * decay_bars
    for t in range(warm, n_bars):
        if not np.isfinite(atr14[t]):
            score[t] = np.nan
            continue
        # An active breakout runs until it decays, or a close falls back inside the box.
        if bo_dir != 0:
            if t - bo_t >= horizon or (box_lo <= c[t] <= box_hi):
                bo_dir = 0
                run = 0
                armed_until = -1
            else:
                score[t] = bo_dir * bo_mag * math.exp(-(t - bo_t) / decay_bars)
                continue
        # Setup detection on bar t (uses only bar t and earlier).
        if setup == "squeeze":
            if qual[t]:
                run += 1
                if run == 1:
                    box_lo, box_hi = lo[t], hi[t]
                else:
                    box_lo, box_hi = min(box_lo, lo[t]), max(box_hi, hi[t])
                if run >= min_bars:
                    armed_until = t + setup_window
                continue  # no breakout while the squeeze is still on
            run = 0
        elif qual[t]:
            box_lo, box_hi = lo[t], hi[t]
            armed_until = t + setup_window
            continue  # the arming bar itself cannot break its own box
        if t > armed_until or not np.isfinite(box_lo):
            continue
        width = max(box_hi - box_lo, 1e-12)
        pad = buf * atr14[t]
        if c[t] > box_hi + pad:
            bo_dir, bo_t = 1, t
            bo_mag = min(1.0, 0.5 + (c[t] - box_hi) / width)
        elif c[t] < box_lo - pad:
            bo_dir, bo_t = -1, t
            bo_mag = min(1.0, 0.5 + (box_lo - c[t]) / width)
        else:
            continue
        armed_until = -1
        score[t] = bo_dir * bo_mag
    return pd.Series(score, index=df.index)
