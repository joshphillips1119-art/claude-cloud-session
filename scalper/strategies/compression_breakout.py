"""Volatility-compression breakout: TTM squeeze / NR-k / NR-k inside bar (research/backlog.md item 9).

A compression setup (Bollinger Bands inside Keltner Channels for ``min_bars``
bars, or the narrowest range of the last ``k`` bars, optionally also an inside
bar) arms a box [low, high]. The first close beyond the box (plus ``buf`` x
ATR14) within ``setup_window`` bars of the last qualifying bar gives a
direction, which decays over ``decay_bars`` and is cancelled if price closes
back inside the box. Everything is computed from bars <= t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


def _setup(df: pd.DataFrame, setup: str, n: int, k_kc: float, min_bars: int, k: int):
    """Return (armed, box_hi, box_lo) arrays: whether bar i qualifies, and its box."""
    h, l, c = (df[x].to_numpy(dtype=float) for x in ("high", "low", "close"))
    m = len(c)
    if setup == "squeeze":
        cs = df["close"]
        mid = ind.sma(cs, n)
        sd = cs.rolling(n, min_periods=n).std(ddof=0)
        kcm = ind.ema(cs, n)
        a = ind.atr(df, n)
        sq = ((mid + 2 * sd) < (kcm + k_kc * a)) & ((mid - 2 * sd) > (kcm - k_kc * a))
        sq = sq.to_numpy(dtype=bool)
        armed = np.zeros(m, dtype=bool)
        hi = np.full(m, np.nan)
        lo = np.full(m, np.nan)
        run = 0
        for i in range(m):
            run = run + 1 if sq[i] else 0
            if run >= min_bars:
                armed[i] = True
                hi[i] = h[i - run + 1:i + 1].max()
                lo[i] = l[i - run + 1:i + 1].min()
        return armed, hi, lo
    r = pd.Series(h - l, index=df.index)
    armed = (r <= r.rolling(k, min_periods=k).min()).to_numpy(dtype=bool)
    if setup == "nr_inside":
        inside = np.zeros(m, dtype=bool)
        inside[1:] = (h[1:] <= h[:-1]) & (l[1:] >= l[:-1])
        armed = armed & inside
    return armed, h.copy(), l.copy()


@register(
    "compression_breakout",
    defaults={"setup": "squeeze", "n": 20, "k_kc": 1.5, "min_bars": 6, "k": 7,
              "setup_window": 6, "buf": 0.0, "decay_bars": 3},
    grid={"setup": ["squeeze", "nr", "nr_inside"], "k": [4, 7], "buf": [0.0, 0.25],
          "decay_bars": [1, 3, 6]},
    category="volatility",
    description="Trade the first close out of a volatility-compression box (TTM squeeze, NR-k, "
                "NR-k inside bar), decaying over a few bars.",
    source="https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/"
           "technical-indicators/ttm-squeeze",
)
def compression_breakout(df, setup, n, k_kc, min_bars, k, setup_window, buf, decay_bars):
    c = df["close"].to_numpy(dtype=float)
    a14 = ind.atr(df, 14).to_numpy(dtype=float)
    armed, bh, bl = _setup(df, setup, n, k_kc, min_bars, k)
    m = len(c)
    score = np.zeros(m)
    box_hi = box_lo = np.nan
    last_q = -10 ** 9
    sig_dir, sig_mag, t_b = 0.0, 0.0, -10 ** 9
    for t in range(m):
        # Active breakout: decay, stop on a close back inside the box, expire after 3*decay.
        if sig_dir != 0:
            if t - t_b >= 3 * decay_bars or (box_lo <= c[t] <= box_hi and t > t_b):
                sig_dir = 0.0
            else:
                score[t] = sig_dir * sig_mag * np.exp(-(t - t_b) / decay_bars)
        # Look for a breakout of the armed box (box from bars < t).
        if sig_dir == 0 and np.isfinite(box_hi) and t - last_q <= setup_window and np.isfinite(a14[t]):
            width = max(box_hi - box_lo, 1e-12)
            if c[t] > box_hi + buf * a14[t]:
                sig_dir, edge = 1.0, box_hi
            elif c[t] < box_lo - buf * a14[t]:
                sig_dir, edge = -1.0, box_lo
            if sig_dir != 0:
                t_b = t
                sig_mag = min(1.0, 0.5 + abs(c[t] - edge) / width)
                score[t] = sig_dir * sig_mag
                last_q = -10 ** 9  # one breakout per setup
        # Bar t qualifying arms (or refreshes) the box for later bars.
        if armed[t]:
            box_hi, box_lo, last_q = bh[t], bl[t], t
            if sig_dir != 0 and t > t_b:
                sig_dir = 0.0
    out = pd.Series(np.clip(score, -1.0, 1.0), index=df.index)
    out.iloc[:max(3 * n, 3 * k, 50)] = np.nan
    return out
