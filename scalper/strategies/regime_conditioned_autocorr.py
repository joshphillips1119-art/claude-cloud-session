"""Regime-conditioned lag-1 autocorrelation (research/backlog.md item 4).

Once a day, at 00:00 UTC, estimate the lag-1 coefficient of standardised
returns separately in each regime bin (volatility, volume, session, weekend
terciles/flags) from the trailing ``W_days`` of completed bars, shrink each
coefficient toward 0, and use the coefficient of bar t's own bin to predict
bar t+1 from bar t. The data chooses momentum or reversal per regime.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

BARS_PER_DAY = 288
MIN_DAYS = 3  # expanding window until W_days of history exist


def _features(df: pd.DataFrame, r: pd.Series, s_slot: pd.Series, sigma: pd.Series) -> dict:
    idx = df.index
    pk = (np.log(df["high"] / df["low"]) ** 2) / (4 * np.log(2)) / s_slot**2
    short = pk.rolling(12, min_periods=12).mean()
    long_ = pk.rolling(2016, min_periods=BARS_PER_DAY).mean()
    lv = np.log1p(df["volume"])
    med = ind.same_slot(lv, 20, "median", min_days=2)
    mad = ind.same_slot((lv - med).abs(), 20, "median", min_days=2)
    ny = idx.tz_convert("America/New_York")
    ny_min = ny.hour * 60 + ny.minute
    utc_h = idx.hour
    us = (ny_min >= 570) & (ny_min < 960)
    asia = ~us & (utc_h < 7)
    eu = ~us & ~asia & (utc_h >= 7) & (ny_min < 570)
    session = np.select([us, asia, eu], [0, 1, 2], 3).astype(float)
    return {
        "vol_level": sigma,
        "vol_ratio": np.sqrt(short / long_.replace(0.0, np.nan)),
        "volume": (lv - med) / (1.4826 * mad.replace(0.0, np.nan)),
        "session": pd.Series(session, index=idx),
        "weekend": pd.Series((idx.dayofweek >= 5).astype(float), index=idx),
    }


@register(
    "regime_conditioned_autocorr",
    defaults={"W_days": 20, "bins": "vol3", "vol_feat": "ratio", "mode": "sign",
              "n0": 1000, "cl": 3.0, "q_ref": 0.05},
    grid={"W_days": [10, 20], "bins": ["vol3", "volume3", "vol3_x_session", "vol3_x_volume3"],
          "mode": ["sign", "slope"], "n0": [300, 1500]},
    category="regime",
    description="Lag-1 autocorrelation of standardised returns estimated per volatility/volume/"
                "session regime bin (daily refit, shrunk to 0); predict next bar from this bar.",
    invertible=False,
    source="https://ideas.repec.org/a/ucp/jnlbus/v65y1992i2p199-219.html",
)
def regime_conditioned_autocorr(df, W_days, bins, vol_feat, mode, n0, cl, q_ref):
    close = df["close"]
    r = ind.log_returns(close)
    s_slot = ind.seasonal_vol_factor(close).fillna(1.0)
    a = 1.0 - 0.5 ** (1.0 / BARS_PER_DAY)
    sigma = np.sqrt((r / s_slot).pow(2).ewm(alpha=a, adjust=False, min_periods=BARS_PER_DAY).mean())
    rt = (r / (s_slot * sigma.shift(1).replace(0.0, np.nan))).clip(-10, 10)
    x = rt.clip(-cl, cl)

    feats = _features(df, r, s_slot, sigma)
    parts = []
    for name in bins.split("_x_"):
        if name == "vol3":
            parts.append(("q", feats["vol_level" if vol_feat == "level" else "vol_ratio"]))
        elif name == "volume3":
            parts.append(("q", feats["volume"]))
        elif name == "illiq3":
            amihud = (r.abs() / (close * df["volume"].clip(lower=1e-9))).rolling(12, min_periods=12).mean()
            parts.append(("q", amihud))
        elif name == "session":
            parts.append(("c", feats["session"]))
        elif name == "weekend":
            parts.append(("c", feats["weekend"]))
        else:
            raise ValueError(f"unknown bin feature {name!r}")

    day = close.index.floor("1D")
    days = day.unique()
    # Pairs (s, s+1) indexed by the time of s+1: x_prev is x_s, y is x_{s+1}.
    x_prev = x.shift(1)
    phi_prev = np.sign(x_prev) if mode == "sign" else x_prev
    yv = np.sign(x) if mode == "sign" else x
    out = pd.Series(0.0, index=close.index)
    for i, d in enumerate(days):
        if i < MIN_DAYS:
            continue
        start = days[max(0, i - W_days)]
        hist = (close.index >= start) & (close.index < d)
        today = day == d
        codes_hist = np.zeros(hist.sum(), dtype=int)
        codes_today = np.zeros(today.sum(), dtype=int)
        mult = 1
        valid_hist = np.ones(hist.sum(), dtype=bool)
        valid_today = np.ones(today.sum(), dtype=bool)
        for kind, f in parts:
            fh = f.shift(1)[hist].to_numpy()  # feature of bar s for pair (s, s+1)
            ft = f[today].to_numpy()          # feature of bar t (predicting t+1)
            if kind == "q":
                ref = f[hist].dropna().to_numpy()
                if len(ref) < BARS_PER_DAY:
                    valid_hist[:] = False
                    valid_today[:] = False
                    break
                cuts = np.quantile(ref, [1 / 3, 2 / 3])
                ch, ct = np.digitize(fh, cuts), np.digitize(ft, cuts)
                valid_hist &= ~np.isnan(fh)
                valid_today &= ~np.isnan(ft)
                k = 3
            else:
                ch = np.nan_to_num(fh, nan=0).astype(int)
                ct = np.nan_to_num(ft, nan=0).astype(int)
                k = 4
            codes_hist += mult * ch
            codes_today += mult * ct
            mult *= k
        if not valid_today.any():
            continue
        xp = phi_prev[hist].to_numpy()
        yy = yv[hist].to_numpy()
        ok = valid_hist & ~np.isnan(xp) & ~np.isnan(yy)
        if mode == "sign":
            ok &= (xp != 0) & (yy != 0)
            num = np.bincount(codes_hist[ok], weights=xp[ok] * yy[ok], minlength=mult)
            n_b = np.bincount(codes_hist[ok], minlength=mult).astype(float)
            rho = np.divide(num, n_b, out=np.zeros(mult), where=n_b > 0)
        else:
            num = np.bincount(codes_hist[ok], weights=xp[ok] * yy[ok], minlength=mult)
            den = np.bincount(codes_hist[ok], weights=xp[ok] ** 2, minlength=mult)
            n_b = np.bincount(codes_hist[ok], minlength=mult).astype(float)
            rho = np.divide(num, den, out=np.zeros(mult), where=den > 0)
        rho_s = rho * n_b / (n_b + n0)
        xt = x[today].to_numpy()
        sig_t = np.sign(xt) if mode == "sign" else xt
        yhat = rho_s[codes_today] * np.nan_to_num(sig_t, nan=0.0)
        out[today] = np.where(valid_today, np.tanh(yhat / q_ref), 0.0)
    return out.clip(-1.0, 1.0)
