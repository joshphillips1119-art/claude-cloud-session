"""Walk-forward parameter selection with an anti-overfitting gate.

For each strategy we score a bounded candidate set (current params, their
grid neighbours, and a deterministic sample of the grid) on a training window
and on a held-out validation window made of the most recent days. Params only
change when the best candidate beats the incumbent on training by a margin
*and* is no worse on validation. Otherwise the incumbent stays.
"""
from __future__ import annotations

import pandas as pd

from . import strategies as S
from .config import Config
from .evaluate import metrics


def _key(p: dict) -> tuple:
    return tuple(sorted(p.items()))


def optimise_strategy(name: str, df: pd.DataFrame, fwd: pd.Series, train: pd.Series, val: pd.Series,
                      current: dict, cfg: Config, seed_key: str) -> dict:
    strat = S.get(name)
    cur = S.canonical(strat, current)
    rows = []
    for p in S.candidates(strat, cur, cfg.max_candidates, seed_key):
        s = S.compute(name, df, p)
        mt = metrics(s[train], fwd[train])
        mv = metrics(s[val], fwd[val])
        rows.append({"params": p, "train": mt, "val": mv})
    inc = next(r for r in rows if _key(r["params"]) == _key(cur))
    eligible = [r for r in rows if r["train"]["n"] >= cfg.min_signals]
    best = max(eligible, key=lambda r: r["train"]["wz"]) if eligible else inc
    adopt = (
        best is not inc
        and best["train"]["wz"] - inc["train"]["wz"] >= cfg.adopt_min_gain
        and best["val"]["n"] >= cfg.min_val_signals
        and best["val"]["wz"] >= inc["val"]["wz"]
    )
    top = sorted(eligible, key=lambda r: r["train"]["wz"], reverse=True)[:5]
    return {
        "strategy": name,
        "adopted": adopt,
        "params": best["params"] if adopt else cur,
        "incumbent": inc,
        "best": best,
        "top": top,
        "n_candidates": len(rows),
    }
