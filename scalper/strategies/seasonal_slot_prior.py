"""Calendar-slot return prior (research/backlog.md item 7).

The next bar's open time is known now, so its calendar key (time-of-day slot,
clock hour, or quarter-hour class) is too. The score is the trailing evidence
that returns sharing that key drift up or down: a mean t-stat (``stat="mean"``)
or a shrunk up-rate test (``stat="sign"``), optionally measured against all
returns from the same days (``demean=1``) so a plain trend is not mistaken for
seasonality. Only returns of bars that have already closed are used.

Deviations from the backlog spec (history is ~40 days): UTC only, no
day-of-week key and no weekend split (too few samples), and the hour-open
imbalance add-on is left out because its evidence is for 4-12 hour horizons.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

BAR = pd.Timedelta(minutes=5)
MIN_N = 10


def _keys(times: pd.DatetimeIndex, key: str) -> np.ndarray:
    if key == "slot_day":
        return (times.hour * 60 + times.minute).to_numpy() // 5
    if key == "hour":
        return times.hour.to_numpy()
    if key == "qh_class":  # 0 = top of the hour, 1 = :15/:30/:45, 2 = any other 5-minute mark
        m = times.minute.to_numpy()
        return np.where(m == 0, 0, np.where(m % 15 == 0, 1, 2))
    raise ValueError(f"unknown key {key!r}")


def _window_sums(t_ns: np.ndarray, x: np.ndarray, win_ns: int):
    """Inclusive trailing-time-window sums of x, x^2, count and up-count at each row."""
    c1 = np.concatenate([[0.0], np.cumsum(x)])
    c2 = np.concatenate([[0.0], np.cumsum(x * x)])
    cu = np.concatenate([[0.0], np.cumsum(x > 0)])
    cnz = np.concatenate([[0.0], np.cumsum(x != 0)])
    lo = np.searchsorted(t_ns, t_ns - win_ns, side="right")
    hi = np.arange(1, len(x) + 1)
    return c1[hi] - c1[lo], c2[hi] - c2[lo], hi - lo, cu[hi] - cu[lo], cnz[hi] - cnz[lo]


@register(
    "seasonal_slot_prior",
    defaults={"key": "slot_day", "D_days": 28, "stat": "mean", "demean": 1, "c": 3.0},
    grid={"key": ["slot_day", "hour", "qh_class"], "D_days": [14, 28], "stat": ["mean", "sign"],
          "demean": [0, 1], "c": [2.0, 4.0]},
    category="seasonality",
    description="Trailing t-stat of returns that share the next bar's calendar key "
                "(time-of-day slot, clock hour or quarter-hour class).",
    requires=("close",),
    source="https://k33.com/research/archive/articles/all-minutes-are-not-equal-for-bitcoin-traders",
)
def seasonal_slot_prior(df, key, D_days, stat, demean, c):
    r = ind.log_returns(df["close"]).fillna(0.0)
    times = df.index
    t_ns = times.as_unit("ns").asi8
    win_ns = int(pd.Timedelta(days=D_days).value)
    vals = r.to_numpy()

    # Same-day baseline Y: every return in the trailing window.
    yS, yS2, yN, yU, yNZ = _window_sums(t_ns, vals, win_ns)

    # Per-key trailing stats, recorded at each row s for key(s).
    k_now = _keys(times, key)
    n = len(vals)
    xS = np.zeros(n); xS2 = np.zeros(n); xN = np.zeros(n); xU = np.zeros(n); xNZ = np.zeros(n)
    for k in np.unique(k_now):
        idx = np.flatnonzero(k_now == k)
        s, s2, cnt, up, nz = _window_sums(t_ns[idx], vals[idx], win_ns)
        xS[idx], xS2[idx], xN[idx], xU[idx], xNZ[idx] = s, s2, cnt, up, nz

    # At bar t, read the latest row s <= t whose key equals key(t+1).
    k_next = _keys(times + BAR, key)
    last = {}
    src = np.full(n, -1)
    for t in range(n):
        last[k_now[t]] = t
        src[t] = last.get(k_next[t], -1)
    ok = src >= 0
    j = np.where(ok, src, 0)
    nX = np.where(ok, xN[j], 0.0)

    with np.errstate(divide="ignore", invalid="ignore"):
        if stat == "mean":
            mX = xS[j] / nX
            sdX = np.sqrt(np.maximum(xS2[j] / nX - mX * mX, 0.0) * nX / np.maximum(nX - 1, 1))
            mY = yS / np.maximum(yN, 1)
            z = (mX - demean * mY) / (sdX / np.sqrt(nX))
        else:
            nzX = np.where(ok, xNZ[j], 0.0)
            p = (xU[j] + 20.0) / (nzX + 40.0)
            p0 = (yU + 20.0) / (yNZ + 40.0) if demean else np.full(n, 0.5)
            z = (p - p0) / np.sqrt(p0 * (1 - p0) / np.maximum(nzX, 1))
            nX = nzX

    score = np.where(ok & (nX >= MIN_N) & np.isfinite(z), np.tanh(z / c), 0.0)
    out = pd.Series(score, index=df.index)
    warm = t_ns - t_ns[0] < pd.Timedelta(days=1).value
    return out.mask(warm)
