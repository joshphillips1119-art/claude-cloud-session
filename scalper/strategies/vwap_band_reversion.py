"""Session-VWAP standard-deviation band reversion (research/backlog.md item 12).

The common "fade the 2-sigma VWAP band" scalp. Over the current session the
volume-weighted mean of the typical price and its volume-weighted standard
deviation are accumulated causally; when the close sits k_entry or more of those
standard deviations away from VWAP the score fades the stretch, ramping from 0 at
k_entry to full size one sigma further out:

  TP_i   = (H_i + L_i + C_i) / 3
  VWAP_t = sum V_i TP_i / sum V_i                      over i in [s0, t]
  sd_t   = sqrt(max(sum V_i TP_i^2 / sum V_i - VWAP_t^2, 0)),  sd*_t = max(sd_t, 0.25 ATR14_t)
  z_t    = (C_t - VWAP_t) / sd*_t
  base_t = -sign(z_t) clip(|z_t| - k_entry, 0, 1)

Optional rejection filter: keep the fade only if the bar's extreme reached the band
and the wick on that side is at least 40% of the bar's range. Trend damping: when
the VWAP itself drifts in the direction of the stretch (slope over 6 bars, in ATR
units), the fade is scaled by 1 / (1 + lambda_trend |slope|).

Anchors: "utc0" = 00:00 UTC day, "us_open_ny" = 09:30 America/New_York, and
"rolling_288" = the trailing 288 bars (no benchmark rationale, no session edge).
Scores are 0 for the first min_session_bars of a session, where the band is
degenerate. ``_sign`` -1 turns the fade into VWAP-band continuation.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

_ROLL = 288
_SLOPE_BARS = 6
_WICK_FRAC = 0.4
_SD_FLOOR_ATR = 0.25


def _session_start(index: pd.DatetimeIndex, anchor: str) -> pd.DatetimeIndex:
    if anchor == "us_open_ny":
        ny = index.tz_convert("America/New_York")  # bars are tz-aware UTC
        shifted = ny - pd.Timedelta(hours=9, minutes=30)
        start = shifted.tz_localize(None).floor("D") + pd.Timedelta(hours=9, minutes=30)
        start = start.tz_localize("America/New_York", ambiguous="NaT", nonexistent="shift_forward")
        return start.tz_convert(index.tz)
    return index.floor("D")


def _session_sums(x: pd.Series, key: pd.Series | None) -> pd.Series:
    """Cumulative sum within the session (or trailing _ROLL bars when key is None)."""
    if key is None:
        return x.rolling(_ROLL, min_periods=_ROLL).sum()
    return x.groupby(key.to_numpy()).cumsum()


@register(
    "vwap_band_reversion",
    defaults={"anchor": "utc0", "k_entry": 2.0, "lambda_trend": 0.5,
              "require_rejection": False, "min_session_bars": 6},
    grid={"anchor": ["utc0", "us_open_ny", "rolling_288"], "k_entry": [1.0, 1.5, 2.0],
          "lambda_trend": [0.0, 1.0], "require_rejection": [False, True]},
    category="mean_reversion",
    description="Fade a close stretched >= k_entry volume-weighted sigmas from the session VWAP, "
                "optionally only on rejection bars, damped when VWAP drifts the same way.",
    requires=("open", "high", "low", "close", "volume"),
    source="https://backtrex.com/en/backtests/vwap-band-fade-dax",
)
def vwap_band_reversion(df, anchor, k_entry, lambda_trend, require_rejection, min_session_bars):
    o = df["open"].astype(float)
    h = df["high"].astype(float)
    lo = df["low"].astype(float)
    c = df["close"].astype(float)
    v = df["volume"].astype(float).clip(lower=0.0)
    tp = (h + lo + c) / 3.0

    if anchor == "rolling_288":
        key = None
        pos = pd.Series(np.arange(len(df), dtype=float), index=df.index)
        age = pos.clip(upper=_ROLL - 1)  # bars available in the window, minus one
        age = age.where(pos >= _ROLL - 1, np.nan)
    else:
        start = _session_start(df.index, anchor)
        key = pd.Series(start, index=df.index)
        age = pd.Series(key.groupby(key.to_numpy()).cumcount().to_numpy(), index=df.index, dtype=float)
        age = age.where(key.notna(), np.nan)

    sum_v = _session_sums(v, key)
    sum_pv = _session_sums(v * tp, key)
    sum_pv2 = _session_sums(v * tp * tp, key)
    denom = sum_v.replace(0.0, np.nan)
    vwap = sum_pv / denom
    var = (sum_pv2 / denom - vwap * vwap).clip(lower=0.0)
    sd = np.sqrt(var)

    atr = ind.atr(df, 14)
    sd_star = np.maximum(sd, _SD_FLOOR_ATR * atr)
    z = (c - vwap) / sd_star.replace(0.0, np.nan)

    base = -np.sign(z) * (z.abs() - float(k_entry)).clip(0.0, 1.0)

    if require_rejection:
        rng = (h - lo).replace(0.0, np.nan)
        upper_wick = (h - np.maximum(o, c)) / rng
        lower_wick = (np.minimum(o, c) - lo) / rng
        band_hi = vwap + float(k_entry) * sd_star
        band_lo = vwap - float(k_entry) * sd_star
        ok_up = (z > 0) & (h >= band_hi) & (upper_wick >= _WICK_FRAC)
        ok_dn = (z < 0) & (lo <= band_lo) & (lower_wick >= _WICK_FRAC)
        base = base.where(ok_up | ok_dn, 0.0)

    # VWAP drift over the last _SLOPE_BARS bars of the same session, in ATR units.
    slope = (vwap - vwap.shift(_SLOPE_BARS)) / atr.replace(0.0, np.nan)
    slope = slope.where(age >= _SLOPE_BARS, 0.0).fillna(0.0)
    against = np.sign(slope) == np.sign(z)
    damp = pd.Series(np.where(against, 1.0 / (1.0 + float(lambda_trend) * slope.abs()), 1.0),
                     index=df.index)
    score = (base * damp).clip(-1.0, 1.0)

    # Young sessions have a degenerate band: no opinion rather than a guess.
    score = score.where(age >= float(min_session_bars) - 1.0, 0.0)

    warm = atr.notna() & age.notna() & vwap.notna()
    return score.fillna(0.0).where(warm, np.nan)
