"""Causal indicator helpers.

Every function here must be *prefix-stable*: the value at bar t may depend only
on rows <= t, so computing on ``df.iloc[:k+1]`` gives the same values as
computing on the full frame and slicing. ``tests/test_causality.py`` enforces
this for every registered strategy.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def log_returns(close: pd.Series) -> pd.Series:
    return np.log(close).diff()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False, min_periods=span).mean()


def wilder(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def rolling_std(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).std(ddof=0)


def zscore(s: pd.Series, n: int) -> pd.Series:
    sd = rolling_std(s, n)
    return (s - sma(s, n)) / sd.replace(0.0, np.nan)


def rsi(close: pd.Series, n: int) -> pd.Series:
    delta = close.diff()
    up = wilder(delta.clip(lower=0.0), n)
    dn = wilder((-delta).clip(lower=0.0), n)
    rs = up / dn.replace(0.0, np.nan)
    out = 100.0 - 100.0 / (1.0 + rs)
    # dn == 0 with up > 0 means only gains in the window.
    return out.where(dn != 0.0, 100.0).where(up.notna())


def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift(1)
    return pd.concat(
        [df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()],
        axis=1,
    ).max(axis=1, skipna=True)


def atr(df: pd.DataFrame, n: int) -> pd.Series:
    return wilder(true_range(df), n)


def session_key(index: pd.DatetimeIndex, session_hours: int = 24) -> pd.Series:
    """Session id per bar: UTC day by default (crypto trades 24/7)."""
    if session_hours == 24:
        return pd.Series(index.floor("D"), index=index)
    return pd.Series(index.floor(f"{session_hours}h"), index=index)


def session_vwap(df: pd.DataFrame, session_hours: int = 24) -> pd.Series:
    typical = (df["high"] + df["low"] + df["close"]) / 3.0
    key = session_key(df.index, session_hours)
    pv = (typical * df["volume"]).groupby(key).cumsum()
    v = df["volume"].groupby(key).cumsum()
    return (pv / v.replace(0.0, np.nan)).fillna(typical)


def realized_vol(close: pd.Series, n: int) -> pd.Series:
    """Rolling std of 1-bar log returns (per-bar units)."""
    return rolling_std(log_returns(close), n)


def squash(x: pd.Series, scale: float = 1.0) -> pd.Series:
    """Map an unbounded z-like quantity into [-1, 1]."""
    return np.tanh(x / scale)


def rolling_autocorr(r: pd.Series, n: int, lag: int = 1) -> pd.Series:
    return r.rolling(n, min_periods=n).corr(r.shift(lag))
