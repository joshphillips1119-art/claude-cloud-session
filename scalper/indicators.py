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


def slot_index(index: pd.DatetimeIndex, minutes: int = 5) -> pd.Series:
    """Time-of-day slot of each bar (0..287 for 5-minute bars, UTC)."""
    return pd.Series((index.hour * 60 + index.minute) // minutes, index=index)


def same_slot(x: pd.Series, n_days: int, stat: str = "median", min_days: int | None = None) -> pd.Series:
    """``stat`` of ``x`` at the same time-of-day slot over the previous ``n_days``
    occurrences (strictly earlier days, so causal). The building block for
    de-seasonalising volume, volatility and trade counts."""
    slot = slot_index(x.index)
    k = min_days or max(2, n_days // 2)
    return x.groupby(slot.values, group_keys=False).transform(
        lambda s: getattr(s.shift(1).rolling(n_days, min_periods=k), stat)())


def seasonal_vol_factor(close: pd.Series, n_days: int = 10) -> pd.Series:
    """Typical |return| at this time of day relative to the all-day typical |return|.
    Divide a raw return by (vol * factor) to remove the intraday volatility smile."""
    a = log_returns(close).abs()
    slot_level = same_slot(a, n_days, "mean")
    overall = a.rolling(288 * n_days, min_periods=288).mean().shift(1)
    return (slot_level / overall.replace(0.0, np.nan)).clip(0.25, 4.0)


def norm_cdf(x) -> np.ndarray:
    """Standard normal CDF without scipy (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7)."""
    x = np.asarray(x, dtype=float)
    z = np.abs(x) / np.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * z)
    poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    erf = 1.0 - poly * np.exp(-z * z)
    return 0.5 * (1.0 + np.sign(x) * erf)


def bvc_buy_fraction(close: pd.Series, n: int = 48) -> pd.Series:
    """Bulk volume classification (Easley, Lopez de Prado, O'Hara): estimated share
    of a bar's volume that was buyer-initiated, for venues without taker data."""
    dp = close.diff()
    sd = rolling_std(dp, n).shift(1)
    return pd.Series(norm_cdf(dp / sd.replace(0.0, np.nan)), index=close.index).where(sd.notna())
