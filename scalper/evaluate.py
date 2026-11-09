"""Labels and scoring.

Prediction made at the close of bar t is scored against the move of the next
``horizon`` bars. Bars whose forward move is exactly zero are excluded from
hit-rate statistics (neither a hit nor a miss) but still count toward coverage
denominators.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

BAR = pd.Timedelta(minutes=5)


def forward_returns(df: pd.DataFrame, horizon: int = 1, mode: str = "close_to_close",
                    bar: pd.Timedelta = BAR) -> pd.Series:
    """Log return realised after bar t. NaN where the next bars are missing."""
    if mode == "close_to_close":
        fwd = np.log(df["close"].shift(-horizon) / df["close"])
    elif mode == "open_to_close":
        # Prediction-market style: next window's close vs next window's open.
        fwd = np.log(df["close"].shift(-horizon) / df["open"].shift(-1))
    else:
        raise ValueError(f"unknown label mode {mode!r}")
    ts = df.index.to_series()
    contiguous = (ts.shift(-horizon) - ts) == horizon * bar
    return fwd.where(contiguous)


def wilson(hits: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = hits / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (centre - half, centre + half)


def metrics(score: pd.Series, fwd: pd.Series, threshold: float = 0.0,
            cost_bps: float = 0.0, min_abs: float = 1e-12) -> dict:
    """Hit-rate and edge statistics for one score series against forward returns.

    * ``z``  - binomial z of hits vs 50% over the bars where a call was made.
    * ``wz`` - confidence-weighted z: sum(s*y)/sqrt(sum(s^2)), y = sign(fwd).
      Under the null (direction independent of the score) it is ~N(0, 1), so it
      rewards being right when confident. Used as the tuning objective.
    """
    s = score.reindex(fwd.index)
    valid = fwd.notna() & (fwd != 0.0)
    called = valid & s.notna() & (s.abs() >= max(threshold, min_abs))
    n_valid = int(valid.sum())
    sc = s[called]
    y = np.sign(fwd[called])
    pred = np.sign(sc)
    n = int(called.sum())
    hits = int((pred == y).sum())
    acc = hits / n if n else float("nan")
    lo, hi = wilson(hits, n)
    z = (hits - n / 2) / math.sqrt(n / 4) if n else 0.0
    ss = float((sc * sc).sum())
    wz = float((sc * y).sum()) / math.sqrt(ss) if ss > 0 else 0.0
    gross = float((pred * fwd[called]).mean() * 1e4) if n else 0.0
    return {
        "n": n,
        "hits": hits,
        "acc": round(acc, 4) if n else None,
        "acc_lo": round(lo, 4),
        "acc_hi": round(hi, 4),
        "z": round(z, 3),
        "wz": round(wz, 3),
        "coverage": round(n / n_valid, 4) if n_valid else 0.0,
        "gross_bps": round(gross, 3),
        "net_bps": round(gross - cost_bps, 3) if n else 0.0,
    }


def day_of(index: pd.DatetimeIndex) -> pd.Series:
    return pd.Series(index.floor("D").strftime("%Y-%m-%d"), index=index)


def window_mask(index: pd.DatetimeIndex, days: list[str], embargo_bars: int = 0,
                bar: pd.Timedelta = BAR) -> pd.Series:
    """Bars belonging to ``days``; optionally drop the last ``embargo_bars`` of the
    window so training labels never peek into the bars that follow it."""
    d = day_of(index)
    mask = d.isin(set(days))
    if embargo_bars and mask.any():
        end = pd.Timestamp(max(days), tz=index.tz) + pd.Timedelta(days=1)
        mask &= pd.Series(index < end - embargo_bars * bar, index=index)
    return mask


def baselines(df: pd.DataFrame, fwd: pd.Series, mask: pd.Series, cost_bps: float = 0.0) -> dict:
    """Naive predictors every model must beat to claim an edge."""
    r = np.log(df["close"]).diff()
    return {
        "always_up": metrics(pd.Series(1.0, index=df.index)[mask], fwd[mask], 0.0, cost_bps),
        "persistence": metrics(np.sign(r)[mask], fwd[mask], 0.0, cost_bps),
        "anti_persistence": metrics(-np.sign(r)[mask], fwd[mask], 0.0, cost_bps),
    }
