"""Combining strategies and learning their weights online."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .evaluate import metrics


NULL = "_null"

# Strategy category -> family, for weight caps (correlated methods share a budget).
FAMILY = {
    "momentum": "trend", "breakout": "trend", "volatility": "trend",
    "mean_reversion": "reversal", "regime": "reversal",
    "order_flow": "flow", "seasonality": "seasonal",
}


def combine(scores: dict[str, pd.Series], weights: dict[str, float]) -> pd.Series:
    """Weighted average of strategy scores, ignoring strategies still warming up.
    The null expert (key ``_null``) always says 0, so its weight shrinks the
    ensemble toward abstention when the real strategies are not trusted."""
    names = [k for k in scores if weights.get(k, 0.0) > 0]
    if not names:
        idx = next(iter(scores.values())).index if scores else pd.DatetimeIndex([])
        return pd.Series(np.nan, index=idx)
    null = weights.get(NULL, 0.0)
    num = sum(weights[k] * scores[k].fillna(0.0) for k in names)
    den = sum(weights[k] * scores[k].notna().astype(float) for k in names)
    out = num / (den + null * (den > 0)).replace(0.0, np.nan)
    return out.clip(-1.0, 1.0)


def effective_weights(learned: dict[str, float], families: dict[str, str], equal_blend: float,
                      max_method: float, max_family: float) -> dict[str, float]:
    """Weights actually used to combine: learned (Hedge) weights shrunk toward
    equal weights, then capped per method and per family. Capped-off mass goes
    to the null expert. ``learned`` may include ``_null``."""
    learned = normalise(learned)
    k = len(learned)
    w = {n: (1 - equal_blend) * v + equal_blend / k for n, v in learned.items()}
    null = w.pop(NULL, 0.0)
    excess = 0.0
    for n in w:
        if w[n] > max_method:
            excess += w[n] - max_method
            w[n] = max_method
    for fam in set(families.get(n, n) for n in w):
        members = [n for n in w if families.get(n, n) == fam]
        tot = sum(w[n] for n in members)
        if tot > max_family:
            excess += tot - max_family
            for n in members:
                w[n] *= max_family / tot
    if null or excess:
        w[NULL] = null + excess
    return {n: round(v, 6) for n, v in w.items()}


def hedge_update(weights: dict[str, float], gains: dict[str, float], eta: float,
                 share: float, clip: float = 3.0) -> dict[str, float]:
    """Fixed-share Hedge (Herbster & Warmuth): multiplicative update on each
    expert's daily gain, then mix a little uniform mass back in so a strategy
    that was down-weighted in one regime can recover in the next."""
    if not weights:
        return {}
    w = {k: v * math.exp(eta * max(-clip, min(clip, gains.get(k, 0.0)))) for k, v in weights.items()}
    total = sum(w.values()) or 1.0
    n = len(w)
    return {k: round((1 - share) * v / total + share / n, 6) for k, v in w.items()}


def normalise(weights: dict[str, float]) -> dict[str, float]:
    total = sum(weights.values())
    if total <= 0:
        return {k: 1.0 / len(weights) for k in weights} if weights else {}
    return {k: v / total for k, v in weights.items()}


def tune_threshold(ens: pd.Series, fwd: pd.Series, grid: list[float], current: float,
                   min_coverage: float, min_gain: float) -> dict:
    """Pick the abstention threshold that maximises the hit-rate z-score subject
    to a minimum coverage; only move off ``current`` for a material gain."""
    rows = []
    for t in sorted(set(grid) | {current}):
        m = metrics(ens, fwd, threshold=t)
        rows.append((t, m))
    eligible = [(t, m) for t, m in rows if m["coverage"] >= min_coverage]
    cur = dict(rows)[current]
    if not eligible:
        return {"threshold": current, "changed": False, "current": cur, "best": cur, "table": rows}
    best_t, best = max(eligible, key=lambda r: r[1]["z"])
    changed = best_t != current and best["z"] - cur["z"] >= min_gain
    return {
        "threshold": best_t if changed else current,
        "changed": changed,
        "current": cur,
        "best": {"threshold": best_t, **best},
        "table": rows,
    }
