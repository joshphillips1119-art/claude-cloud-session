"""Baseline strategy set. Each returns a causal score in [-1, 1] for the next bar."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register


@register(
    "momentum",
    defaults={"n": 3, "scale": 1.0, "vol_n": 48},
    grid={"n": [1, 2, 3, 6, 12], "scale": [0.5, 1.0, 2.0]},
    category="momentum",
    description="Vol-normalised n-bar return; follow it (or fade with _sign=-1).",
)
def momentum(df, n, scale, vol_n):
    r = np.log(df["close"] / df["close"].shift(n))
    vol = ind.realized_vol(df["close"], vol_n) * np.sqrt(n)
    return ind.squash(r / vol.replace(0.0, np.nan), scale)


@register(
    "rsi_reversion",
    defaults={"n": 14, "band": 20.0},
    grid={"n": [2, 3, 5, 7, 14], "band": [10.0, 20.0, 30.0]},
    category="mean_reversion",
    description="Fade RSI distance from 50 (Connors-style for small n).",
)
def rsi_reversion(df, n, band):
    return -ind.squash(ind.rsi(df["close"], n) - 50.0, band)


@register(
    "bollinger_reversion",
    defaults={"n": 20, "k": 2.0},
    grid={"n": [10, 20, 40], "k": [1.0, 1.5, 2.0, 3.0]},
    category="mean_reversion",
    description="Fade the close's z-score versus its n-bar SMA.",
)
def bollinger_reversion(df, n, k):
    return -ind.squash(ind.zscore(df["close"], n), k)


@register(
    "vwap_reversion",
    defaults={"n": 48, "k": 1.0},
    grid={"n": [24, 48, 96], "k": [0.5, 1.0, 2.0]},
    category="mean_reversion",
    description="Fade the log distance from the session (UTC day) VWAP, scaled by its rolling std.",
)
def vwap_reversion(df, n, k):
    d = np.log(df["close"] / ind.session_vwap(df))
    sd = ind.rolling_std(d, n)
    return -ind.squash(d / sd.replace(0.0, np.nan), k)


@register(
    "ema_trend",
    defaults={"fast": 8, "slow": 34, "atr_n": 14},
    grid={"fast": [3, 5, 8, 12], "slow": [21, 34, 55]},
    category="momentum",
    description="EMA(fast) - EMA(slow) in ATR units; follow the trend.",
)
def ema_trend(df, fast, slow, atr_n):
    if fast >= slow:
        return pd.Series(np.nan, index=df.index)
    diff = ind.ema(df["close"], fast) - ind.ema(df["close"], slow)
    return ind.squash(diff / ind.atr(df, atr_n).replace(0.0, np.nan), 1.0)


@register(
    "donchian_breakout",
    defaults={"n": 24},
    grid={"n": [6, 12, 24, 48]},
    category="breakout",
    description="+1 when the close breaks the prior n-bar high, -1 below the prior n-bar low, else 0.",
)
def donchian_breakout(df, n):
    hh = df["high"].rolling(n, min_periods=n).max().shift(1)
    ll = df["low"].rolling(n, min_periods=n).min().shift(1)
    out = pd.Series(0.0, index=df.index)
    out[df["close"] > hh] = 1.0
    out[df["close"] < ll] = -1.0
    return out.where(hh.notna())


@register(
    "shock_reversal",
    defaults={"k": 3.0, "vol_n": 96},
    grid={"k": [2.0, 2.5, 3.0, 4.0]},
    category="mean_reversion",
    description="After a bar whose return exceeds k sigma, fade it; otherwise no opinion (0).",
)
def shock_reversal(df, k, vol_n):
    r = ind.log_returns(df["close"])
    z = r / ind.realized_vol(df["close"], vol_n).shift(1).replace(0.0, np.nan)
    mag = ((z.abs() - k) / k + 0.5).clip(upper=1.0)
    return (-np.sign(z) * mag).where(z.abs() >= k, 0.0).where(z.notna())


@register(
    "autocorr_adaptive",
    defaults={"n": 96, "gain": 5.0, "vol_n": 48},
    grid={"n": [48, 96, 288], "gain": [2.0, 5.0, 10.0]},
    category="regime",
    description="Rolling lag-1 return autocorrelation decides follow vs fade of the last bar's move.",
)
def autocorr_adaptive(df, n, gain, vol_n):
    r = ind.log_returns(df["close"])
    rho = ind.rolling_autocorr(r, n)
    zlast = r / ind.realized_vol(df["close"], vol_n).replace(0.0, np.nan)
    return ind.squash(gain * rho * zlast.clip(-3, 3), 1.0)


@register(
    "taker_flow",
    defaults={"n": 3, "z_n": 288, "scale": 1.0},
    grid={"n": [1, 3, 6], "z_n": [96, 288], "scale": [1.0, 2.0]},
    category="order_flow",
    description="Taker buy-sell imbalance over n bars, z-scored; follow aggressive flow.",
    requires=("close", "volume", "taker_buy_volume"),
)
def taker_flow(df, n, z_n, scale):
    signed = 2.0 * df["taker_buy_volume"] - df["volume"]
    imb = signed.rolling(n, min_periods=n).sum() / df["volume"].rolling(n, min_periods=n).sum().replace(0.0, np.nan)
    return ind.squash(ind.zscore(imb, z_n), scale)


@register(
    "close_location",
    defaults={"n": 1, "scale": 0.5},
    grid={"n": [1, 3, 6], "scale": [0.25, 0.5, 1.0]},
    category="order_flow",
    description="Average close location value ((c-l)-(h-c))/(h-l) over n bars; follow buying/selling pressure.",
)
def close_location(df, n, scale):
    rng = (df["high"] - df["low"]).replace(0.0, np.nan)
    clv = ((df["close"] - df["low"]) - (df["high"] - df["close"])) / rng
    return ind.squash(clv.fillna(0.0).rolling(n, min_periods=n).mean(), scale)
