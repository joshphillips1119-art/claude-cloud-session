"""Walk-forward parameter selection with anti-overfitting gates.

Each day, for each strategy:

1. Score a bounded candidate set (current params, their grid neighbours, a
   deterministic sample of the grid) on the training window and on the held-out
   validation window (the most recent days).
2. Rank by a *plateau* score: the mean training wz of a config and its grid
   neighbours, so isolated lucky peaks lose to robust regions.
3. Require the best config to clear a *luck hurdle*, the expected maximum of N
   null z-scores (N = configs tried), so trying more configs raises the bar.
4. Move the live params only *one grid step* per axis toward that target, and
   only if the step itself beats the incumbent on training by a margin and is
   no worse on validation.
5. A momentum <-> reversal flip (``_sign``) additionally needs the flipped
   config to win on most individual training days.
"""
from __future__ import annotations

import math
from statistics import NormalDist

import pandas as pd

from . import strategies as S
from .config import Config
from .evaluate import day_of, metrics

_EULER = 0.5772156649015329


def expected_max_z(n: int) -> float:
    """E[max of n iid N(0,1)] (Bailey & Lopez de Prado's approximation):
    about 1.57 for n=10, 2.25 for n=50 and 2.53 for n=100."""
    if n <= 1:
        return 0.0
    inv = NormalDist().inv_cdf
    return (1 - _EULER) * inv(1 - 1 / n) + _EULER * inv(1 - 1 / (n * math.e))


def _key(p: dict) -> tuple:
    return tuple(sorted(p.items()))


def _ordered(vals: list) -> bool:
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals)


def step_toward(strat: S.Strategy, cur: dict, target: dict) -> dict:
    """One grid step from ``cur`` toward ``target`` on every axis that differs.
    Categorical axes (strings, bools) jump straight to the target value."""
    out = dict(cur)
    for k, vals in strat.grid.items():
        if target[k] == cur[k]:
            continue
        if _ordered(vals) and cur[k] in vals and target[k] in vals:
            i, j = vals.index(cur[k]), vals.index(target[k])
            out[k] = vals[i + (1 if j > i else -1)]
        else:
            out[k] = target[k]
    if strat.invertible:
        out["_sign"] = target["_sign"]
    return out


def daily_win_fraction(score: pd.Series, fwd: pd.Series, mask: pd.Series, min_calls: int = 20) -> float:
    days = day_of(score.index)
    wins = total = 0
    for d in sorted(set(days[mask])):
        m = mask & (days == d)
        r = metrics(score[m], fwd[m])
        if r["n"] >= min_calls:
            total += 1
            wins += r["wz"] > 0
    return wins / total if total else 0.0


def optimise_strategy(name: str, df: pd.DataFrame, fwd: pd.Series, train: pd.Series, val: pd.Series,
                      current: dict, cfg: Config, seed_key: str) -> dict:
    strat = S.get(name)
    cur = S.canonical(strat, current)
    rows: dict[tuple, dict] = {}
    scores: dict[tuple, pd.Series] = {}

    def evaluate(p: dict) -> dict:
        k = _key(p)
        if k not in rows:
            s = S.compute(name, df, p)
            scores[k] = s
            rows[k] = {"params": p, "train": metrics(s[train], fwd[train]), "val": metrics(s[val], fwd[val])}
        return rows[k]

    for p in S.candidates(strat, cur, cfg.max_candidates, seed_key):
        evaluate(p)
    inc = rows[_key(cur)]

    def same_sign_neighbours(p: dict) -> list[dict]:
        return [q for q in S.neighbours(strat, p) if q.get("_sign") == p.get("_sign")]

    eligible = [r for r in rows.values() if r["train"]["n"] >= cfg.min_signals]
    if cfg.plateau and eligible:
        # Make sure the leading configs have every neighbour scored before judging plateaus.
        lead = sorted(eligible, key=lambda r: r["train"]["wz"], reverse=True)[:5] + [inc]
        for r in lead:
            for q in same_sign_neighbours(r["params"]):
                evaluate(q)
        for r in lead:
            neigh = [rows[_key(q)]["train"]["wz"] for q in same_sign_neighbours(r["params"])]
            r["plateau"] = round(sum([r["train"]["wz"], *neigh]) / (1 + len(neigh)), 3)
        pool = [r for r in lead if r["train"]["n"] >= cfg.min_signals]
        target = max(pool, key=lambda r: r["plateau"]) if pool else inc
    else:
        target = max(eligible, key=lambda r: r["train"]["wz"]) if eligible else inc

    n_tried = len(rows)
    hurdle = expected_max_z(n_tried) if cfg.luck_hurdle else float("-inf")
    proposal = evaluate(step_toward(strat, cur, target["params"]) if cfg.one_step else target["params"])

    reasons = []
    if _key(proposal["params"]) == _key(cur):
        reasons.append("already at the best region")
    else:
        if target["train"]["wz"] < hurdle:
            reasons.append(f"best train wz {target['train']['wz']:+.2f} below luck hurdle {hurdle:.2f} (N={n_tried})")
        if proposal["train"]["n"] < cfg.min_signals:
            reasons.append("too few training calls")
        if proposal["train"]["wz"] - inc["train"]["wz"] < cfg.adopt_min_gain:
            reasons.append("training gain below margin")
        if proposal["val"]["n"] < cfg.min_val_signals:
            reasons.append("too few validation calls")
        if proposal["val"]["wz"] < inc["val"]["wz"]:
            reasons.append("worse on validation")
    flip_frac = None
    if strat.invertible and proposal["params"]["_sign"] != cur["_sign"] and not reasons:
        flip_frac = daily_win_fraction(scores[_key(proposal["params"])], fwd, train)
        if flip_frac < cfg.sign_flip_min_day_frac:
            reasons.append(f"sign flip wins only {flip_frac:.0%} of training days")
    adopt = not reasons

    top = sorted(eligible, key=lambda r: r["train"]["wz"], reverse=True)[:5]
    return {
        "strategy": name,
        "adopted": adopt,
        "params": proposal["params"] if adopt else cur,
        "incumbent": inc,
        "target": target,
        "proposal": proposal,
        "best": proposal if adopt else target,
        "hurdle": round(hurdle, 3) if hurdle != float("-inf") else None,
        "rejected_because": reasons,
        "flip_day_frac": flip_frac,
        "top": top,
        "n_candidates": n_tried,
    }
