"""Trend-state momentum: SuperTrend or Heikin-Ashi state and flip (research/backlog.md item 8).

An ATR trailing band (SuperTrend) or smoothed Heikin-Ashi candles define a
short-term trend state. ``mode='state'`` bets on continuation in the direction
of the state (stronger the further price is from the band / the longer the
streak); ``mode='flip'`` bets only right after a flip, decaying with time.
Optionally halve the score when the same variant on completed 1-hour bars
disagrees. Labels are always real closes; HA prices are only a feature.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


def _supertrend(df: pd.DataFrame, atr_len: int, mult: float):
    """Return (dir, stop, atr) arrays; dir in {+1, -1}."""
    h, l, c = (df[k].to_numpy(dtype=float) for k in ("high", "low", "close"))
    a = ind.atr(df, atr_len).to_numpy(dtype=float)
    hl2 = (h + l) / 2.0
    n = len(c)
    d = np.ones(n)
    stop = np.full(n, np.nan)
    fub = flb = np.nan
    for t in range(n):
        if not np.isfinite(a[t]):
            continue
        bub, blb = hl2[t] + mult * a[t], hl2[t] - mult * a[t]
        if not np.isfinite(fub):
            fub, flb, d[t] = bub, blb, 1.0
        else:
            prev_c = c[t - 1]
            pub, plb = fub, flb
            fub = bub if (bub < pub or prev_c > pub) else pub
            flb = blb if (blb > plb or prev_c < plb) else plb
            d[t] = 1.0 if c[t] > pub else (-1.0 if c[t] < plb else d[t - 1])
        stop[t] = flb if d[t] > 0 else fub
    return d, stop, a


def _heikin_ashi(df: pd.DataFrame, pre_smooth: int):
    """Return (color, streak, strong) arrays."""
    o, h, l, c = (df[k] if pre_smooth <= 1 else ind.ema(df[k], pre_smooth)
                  for k in ("open", "high", "low", "close"))
    o, h, l, c = (x.to_numpy(dtype=float) for x in (o, h, l, c))
    a14 = ind.atr(df, 14).to_numpy(dtype=float)
    hac = (o + h + l + c) / 4.0
    n = len(c)
    hao = np.empty(n)
    hao[0] = (o[0] + c[0]) / 2.0
    for t in range(1, n):
        hao[t] = (hao[t - 1] + hac[t - 1]) / 2.0
    hah = np.maximum(np.maximum(h, hao), hac)
    hal = np.minimum(np.minimum(l, hao), hac)
    color = np.sign(hac - hao)
    streak = np.zeros(n)
    for t in range(n):
        streak[t] = streak[t - 1] + 1 if t > 0 and color[t] == color[t - 1] and color[t] != 0 else 1
    with np.errstate(invalid="ignore"):
        strong = np.where(color > 0, (hao - hal) <= 0.05 * a14, (hah - hao) <= 0.05 * a14).astype(float)
    return color, streak, strong


def _direction(df, variant, atr_len, mult, pre_smooth):
    if variant == "supertrend":
        return _supertrend(df, atr_len, mult)[0]
    return _heikin_ashi(df, pre_smooth)[0]


def _htf_direction(df, variant, atr_len, mult, pre_smooth) -> np.ndarray:
    """Direction of the last 1h bar that closed at or before each 5m bar's close."""
    h1 = df.resample("1h", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last"}).dropna()
    if len(h1) < 3:
        return np.full(len(df), np.nan)
    d1 = pd.Series(_direction(h1, variant, atr_len, mult, pre_smooth), index=h1.index)
    bar = pd.Timedelta(df.index.to_series().diff().median())
    key = (df.index + bar).floor("1h") - pd.Timedelta("1h")
    return d1.reindex(key).to_numpy(dtype=float)


@register(
    "trend_state_momentum",
    defaults={"variant": "supertrend", "mode": "state", "atr_len": 10, "mult": 3.0,
              "beta": 0.3, "flip_decay": 6.0, "pre_smooth": 3, "n_sat": 3, "htf_confirm": "none"},
    grid={"variant": ["supertrend", "heikin_ashi"], "mode": ["state", "flip"],
          "atr_len": [10, 20], "mult": [2.0, 3.0], "htf_confirm": ["none", "1h"]},
    category="momentum",
    description="Follow the SuperTrend / Heikin-Ashi trend state (or a fresh flip), "
                "optionally confirmed by the completed 1h state.",
    source="https://www.liberatedstocktrader.com/supertrend-indicator/",
)
def trend_state_momentum(df, variant, mode, atr_len, mult, beta, flip_decay, pre_smooth, n_sat, htf_confirm):
    c = df["close"].to_numpy(dtype=float)
    n = len(c)
    if variant == "supertrend":
        d, stop, a = _supertrend(df, atr_len, mult)
        if mode == "state":
            with np.errstate(invalid="ignore", divide="ignore"):
                dist = np.abs(c - stop) / (mult * a)
            score = d * (beta + (1.0 - beta) * np.tanh(dist))
        else:
            since = np.zeros(n)
            for t in range(1, n):
                since[t] = 0 if d[t] != d[t - 1] else since[t - 1] + 1
            score = d * np.exp(-since / flip_decay)
    else:
        color, streak, strong = _heikin_ashi(df, pre_smooth)
        if mode == "state":
            score = color * np.minimum(1.0, streak / n_sat) * (0.5 + 0.5 * strong)
        else:
            score = color * np.exp(-(streak - 1) / n_sat)

    if htf_confirm == "1h":
        d1 = _htf_direction(df, variant, atr_len, mult, pre_smooth)
        score = np.where(np.isfinite(d1) & (d1 * np.sign(score) < 0), 0.5 * score, score)

    out = pd.Series(np.clip(score, -1.0, 1.0), index=df.index)
    warm = max(3 * atr_len, 50)
    out.iloc[:warm] = np.nan
    return out
