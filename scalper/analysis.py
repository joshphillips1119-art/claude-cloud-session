"""Descriptive analysis of one trading day versus its trailing history.

The statistics here are the ones that matter for 5-minute direction calls:
whether returns trended or mean-reverted (lag-1 autocorrelation, variance
ratio, efficiency ratio), how volatile the day was relative to costs, and
which hours carried the activity.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def _autocorr(r: pd.Series, lag: int = 1) -> float:
    r = r.dropna()
    if len(r) < lag + 10:
        return float("nan")
    return float(r.autocorr(lag))


def _variance_ratio(r: pd.Series, q: int) -> float:
    r = r.dropna()
    if len(r) < q * 10:
        return float("nan")
    var1 = r.var(ddof=1)
    rq = r.rolling(q).sum().dropna()
    return float(rq.var(ddof=1) / (q * var1)) if var1 > 0 else float("nan")


def _efficiency(close: pd.Series) -> float:
    path = close.diff().abs().sum()
    return float(abs(close.iloc[-1] - close.iloc[0]) / path) if path > 0 else float("nan")


def day_stats(day_df: pd.DataFrame) -> dict:
    c = day_df["close"]
    r = np.log(c).diff()
    out = {
        "bars": int(len(day_df)),
        "open": float(day_df["open"].iloc[0]),
        "close": float(c.iloc[-1]),
        "high": float(day_df["high"].max()),
        "low": float(day_df["low"].min()),
        "return_pct": round(float((c.iloc[-1] / day_df["open"].iloc[0] - 1) * 100), 3),
        "range_pct": round(float((day_df["high"].max() / day_df["low"].min() - 1) * 100), 3),
        "bar_vol_bps": round(float(r.std(ddof=1) * 1e4), 2),
        "mean_abs_move_bps": round(float(r.abs().mean() * 1e4), 2),
        "autocorr_lag1": round(_autocorr(r, 1), 4),
        "autocorr_lag2": round(_autocorr(r, 2), 4),
        "variance_ratio_6": round(_variance_ratio(r, 6), 3),
        "efficiency_ratio": round(_efficiency(c), 4),
        "up_bar_frac": round(float((r > 0).sum() / max(1, r.notna().sum())), 4),
        "volume": float(day_df["volume"].sum()),
    }
    if day_df["taker_buy_volume"].notna().any():
        out["taker_buy_ratio"] = round(float(day_df["taker_buy_volume"].sum() / day_df["volume"].sum()), 4)
    return out


def regime_label(stats: dict, trailing: dict) -> str:
    vol = stats["bar_vol_bps"]
    tvol = trailing.get("bar_vol_bps_median") or vol
    vol_tag = "high-vol" if vol > 1.3 * tvol else "low-vol" if vol < 0.75 * tvol else "normal-vol"
    ac, vr = stats["autocorr_lag1"], stats["variance_ratio_6"]
    if (not math.isnan(ac) and ac > 0.05) or (not math.isnan(vr) and vr > 1.15):
        shape = "trending (momentum-friendly)"
    elif (not math.isnan(ac) and ac < -0.05) or (not math.isnan(vr) and vr < 0.85):
        shape = "mean-reverting (fade-friendly)"
    else:
        shape = "random-walk-like"
    return f"{vol_tag}, {shape}"


def analyse_day(df: pd.DataFrame, day: str, trailing_days: int = 7, cost_bps: float = 0.0) -> dict:
    lo = pd.Timestamp(day, tz="UTC")
    hi = lo + pd.Timedelta(days=1)
    day_df = df[(df.index >= lo) & (df.index < hi)]
    if day_df.empty:
        return {"day": day, "error": "no bars"}
    stats = day_stats(day_df)

    hist = []
    for k in range(1, trailing_days + 1):
        d0 = lo - pd.Timedelta(days=k)
        part = df[(df.index >= d0) & (df.index < d0 + pd.Timedelta(days=1))]
        if len(part) > 50:
            hist.append(day_stats(part))
    trailing = {}
    if hist:
        for key in ("bar_vol_bps", "autocorr_lag1", "variance_ratio_6", "efficiency_ratio", "volume", "range_pct"):
            vals = [h[key] for h in hist if not (isinstance(h[key], float) and math.isnan(h[key]))]
            if vals:
                trailing[f"{key}_median"] = round(float(np.median(vals)), 4)
        trailing["days"] = len(hist)

    r = np.log(day_df["close"]).diff()
    by_hour = pd.DataFrame({"abs_bps": r.abs() * 1e4, "ret_bps": r * 1e4, "volume": day_df["volume"]})
    by_hour = by_hour.groupby(day_df.index.hour).agg({"abs_bps": "mean", "ret_bps": "sum", "volume": "sum"})
    top_hours = by_hour.sort_values("abs_bps", ascending=False).head(4)

    # Biggest bars and what the next bar did (continuation vs reversal).
    full_r = np.log(df["close"]).diff()
    nxt = full_r.shift(-1)
    big = r.abs().sort_values(ascending=False).head(8).index
    shocks = []
    for t in big:
        shocks.append({
            "time": t.strftime("%H:%M"),
            "move_bps": round(float(r[t] * 1e4), 1),
            "next_bps": round(float(nxt.get(t, np.nan) * 1e4), 1) if not np.isnan(nxt.get(t, np.nan)) else None,
        })
    follow = [s for s in shocks if s["next_bps"] is not None]
    cont = sum(1 for s in follow if np.sign(s["move_bps"]) == np.sign(s["next_bps"]))

    return {
        "day": day,
        "stats": stats,
        "trailing": trailing,
        "regime": regime_label(stats, trailing),
        "cost_vs_move": round(cost_bps / stats["mean_abs_move_bps"], 3) if stats["mean_abs_move_bps"] else None,
        "top_hours_utc": [
            {"hour": int(h), "mean_abs_bps": round(float(row.abs_bps), 2), "net_bps": round(float(row.ret_bps), 1)}
            for h, row in top_hours.iterrows()
        ],
        "shocks": shocks,
        "shock_continuation": f"{cont}/{len(follow)}",
    }
