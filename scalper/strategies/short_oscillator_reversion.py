"""Short-oscillator and close-location reversion with a trend filter (research/backlog.md item 11).

Connors' RSI(2) / ConnorsRSI and Pagonidis' internal bar strength (IBS) effect say that
extreme readings of a very short oscillator, or a close pinned at the bar's high or low,
mark temporary aggressor pressure that partly reverts next bar, preferably when the fade
agrees with the longer trend. The variants share one scale, raw in [-1, 1], + = up:

  rsi2      s_osc  = clip((Lo - RSI_2)/Lo, 0, 1) - clip((RSI_2 - (100 - Lo))/Lo, 0, 1)
  crsi      same with X = (RSI_3(close) + RSI_2(streak) + pctrank_100(r)) / 3
  ibs       s_loc  = clip((band - IBS)/band, 0, 1) - clip((IBS - (1 - band))/band, 0, 1)
  cmf       s_cmf  = -tanh(CMF_n / 0.5),  CMF_n = sum CLV*V / sum V,  CLV = 2*IBS - 1
  rsi2_ibs  clip(0.6*s_osc + 0.4*s_loc, -1, 1)

Trend filter: tr = sign(close - SMA_trend_len(close)); the fade keeps full weight when it
points with tr and is scaled by ctw when it points against it (ctw 1 = no filter).
The framework's ``_sign`` plays the backlog's d (+1 fade, -1 continuation).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


def _ibs(df: pd.DataFrame, min_range_bps: float) -> pd.Series:
    rng = df["high"] - df["low"]
    ibs = (df["close"] - df["low"]) / rng.replace(0.0, np.nan)
    too_small = rng < (min_range_bps * 1e-4) * df["close"]
    return ibs.where(~too_small, 0.5).fillna(0.5)


def _two_sided(x: pd.Series, lo: float, hi: float, width: float) -> pd.Series:
    """+1 when x is at/below lo, -1 when at/above hi, linear ramp of ``width`` in between."""
    return ((lo - x) / width).clip(0.0, 1.0) - ((x - hi) / width).clip(0.0, 1.0)


def _streak(close: pd.Series) -> pd.Series:
    s = np.sign(close.diff()).fillna(0.0)
    block = (s != s.shift()).cumsum()
    run = s.groupby(block).cumcount() + 1
    return (s * run).where(s != 0.0, 0.0)


def _connors_rsi(close: pd.Series) -> pd.Series:
    r = close.pct_change()
    rsi3 = ind.rsi(close, 3)
    rsi_streak = ind.rsi(_streak(close), 2)
    pct_rank = r.rolling(100, min_periods=100).rank(pct=True) * 100.0
    return (rsi3 + rsi_streak + pct_rank) / 3.0


@register(
    "short_oscillator_reversion",
    defaults={"variant": "rsi2", "Lo": 10.0, "ctw": 0.5, "trend_len": 100,
              "band": 0.2, "n": 3, "min_range_bps": 2.0},
    grid={"variant": ["rsi2", "crsi", "ibs", "cmf", "rsi2_ibs"], "Lo": [10.0, 25.0],
          "ctw": [0.0, 0.5, 1.0]},
    category="mean_reversion",
    description="Fade extreme RSI(2)/ConnorsRSI readings or closes pinned at the bar's high/low "
                "(IBS, Chaikin money flow), at full weight only with the SMA trend; follow with _sign -1.",
    requires=("open", "high", "low", "close", "volume"),
    source="https://arxiv.org/abs/2306.12434",
)
def short_oscillator_reversion(df, variant, Lo, ctw, trend_len, band, n, min_range_bps):
    close = df["close"].astype(float)
    ibs = _ibs(df, min_range_bps)

    if variant in ("rsi2", "rsi2_ibs", "crsi"):
        x = _connors_rsi(close) if variant == "crsi" else ind.rsi(close, 2)
        s_osc = _two_sided(x, Lo, 100.0 - Lo, Lo)
    else:
        s_osc = None

    if variant == "rsi2" or variant == "crsi":
        raw = s_osc
    elif variant == "ibs":
        raw = _two_sided(ibs, band, 1.0 - band, band)
    elif variant == "cmf":
        vol = df["volume"].astype(float)
        clv = 2.0 * ibs - 1.0
        v_n = vol.rolling(n, min_periods=n).sum()
        cmf = (clv * vol).rolling(n, min_periods=n).sum() / v_n.replace(0.0, np.nan)
        raw = -np.tanh(cmf / 0.5)
        raw = raw.where(v_n > 0, 0.0)
    elif variant == "rsi2_ibs":
        raw = (0.6 * s_osc + 0.4 * _two_sided(ibs, band, 1.0 - band, band)).clip(-1.0, 1.0)
    else:
        raise ValueError(f"unknown variant {variant!r}")

    trend = np.sign(close - ind.sma(close, int(trend_len)))
    with_trend = (raw == 0.0) | (np.sign(raw) == trend)
    weight = pd.Series(np.where(with_trend, 1.0, float(ctw)), index=df.index)
    score = raw * weight

    # NaN only while warming up (oscillator / money flow / trend SMA), 0 otherwise.
    warm = raw.notna() & trend.notna()
    return score.fillna(0.0).where(warm, np.nan)
