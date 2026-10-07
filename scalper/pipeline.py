"""The daily self-improvement cycle.

``run_day`` is pure: it takes bars, the current state and the scoreboard, and
returns the next state plus a report. IO lives in ``cli.py``. ``backtest``
replays ``run_day`` over historical days to measure the *mechanism itself*:
the scoreboard it produces is strictly out-of-sample because each day is
scored with params chosen before that day.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import strategies as S
from .analysis import analyse_day
from .config import Config
from .ensemble import FAMILY, NULL, combine, effective_weights, hedge_update, normalise, tune_threshold
from .evaluate import baselines, forward_returns, metrics, window_mask
from .optimize import optimise_strategy
from .state import clone


def _bar(cfg: Config) -> pd.Timedelta:
    return pd.Timedelta(minutes=cfg.interval_minutes)


def window_days(day: str, n: int) -> list[str]:
    end = pd.Timestamp(day)
    return [(end - pd.Timedelta(days=k)).strftime("%Y-%m-%d") for k in range(n - 1, -1, -1)]


def slice_for(df: pd.DataFrame, day: str, cfg: Config) -> pd.DataFrame:
    start = pd.Timestamp(day, tz="UTC") - pd.Timedelta(days=cfg.lookback_days + cfg.warmup_days)
    end = pd.Timestamp(day, tz="UTC") + pd.Timedelta(days=2)
    return df[(df.index >= start) & (df.index < end)]


def active(state: dict, df: pd.DataFrame) -> list[str]:
    reg = S.load_all()
    return [n for n, s in state["strategies"].items()
            if s.get("enabled") and n in reg and S.has_inputs(reg[n], df)]


def score_all(df: pd.DataFrame, state: dict, names: list[str]) -> dict[str, pd.Series]:
    return {n: S.compute(n, df, state["strategies"][n]["params"]) for n in names}


def learned_weights(state: dict, names: list[str], cfg: Config) -> dict[str, float]:
    w = {n: state["strategies"][n]["weight"] for n in names}
    if cfg.null_expert:
        w[NULL] = state["ensemble"].get("null_weight", sum(w.values()) / max(1, len(w)))
    return w


def weights_of(state: dict, names: list[str], cfg: Config) -> dict[str, float]:
    """Effective combination weights (learned, blended toward equal, capped)."""
    reg = S.load_all()
    fams = {n: FAMILY.get(reg[n].category, reg[n].category) for n in names}
    return effective_weights(learned_weights(state, names, cfg), fams, cfg.equal_blend,
                             cfg.max_method_weight, cfg.max_family_weight)


def pooled_z(rows: list[dict], key: str = "ensemble") -> tuple[int, int, float]:
    n = sum(r[key]["n"] for r in rows if r.get(key))
    hits = sum(r[key]["hits"] for r in rows if r.get(key))
    z = (hits - n / 2) / math.sqrt(n / 4) if n else 0.0
    return n, hits, z


def run_day(df_all: pd.DataFrame, state: dict, cfg: Config, day: str,
            scoreboard: list[dict] | None = None, do_trials: bool = True) -> tuple[dict, dict]:
    scoreboard = list(scoreboard or [])
    bar = _bar(cfg)
    df = slice_for(df_all, day, cfg)
    day_mask = window_mask(df.index, [day])
    n_day = int(day_mask.sum())
    if n_day == 0:
        raise ValueError(f"no bars for {day}")
    fwd = forward_returns(df, cfg.horizon_bars, cfg.label_mode, bar)
    new = clone(state)
    changes: list[dict] = []
    report: dict = {"day": day, "params_version_scored": state["version"], "bars": n_day,
                    "expected_bars": 24 * 60 // cfg.interval_minutes}

    # 1. Out-of-sample score of yesterday with the params that were live.
    names = active(state, df)
    if not names:
        raise ValueError("no active strategies have the inputs they need in this data")
    scores = score_all(df, state, names)
    w = weights_of(state, names, cfg)
    ens = combine(scores, w)
    thr = state["ensemble"]["threshold"]
    oos = {
        "date": day,
        "version": state["version"],
        "threshold": thr,
        "ensemble": metrics(ens[day_mask], fwd[day_mask], thr, cfg.cost_bps_round_trip),
        "ensemble_all": metrics(ens[day_mask], fwd[day_mask], 0.0, cfg.cost_bps_round_trip),
        "strategies": {n: metrics(scores[n][day_mask], fwd[day_mask], 0.0, cfg.cost_bps_round_trip) for n in names},
        "baselines": baselines(df, fwd, day_mask, cfg.cost_bps_round_trip),
    }
    report["oos"] = oos

    # 2. Market analysis of the day.
    report["analysis"] = analyse_day(df, day, cost_bps=cfg.cost_bps_round_trip)
    oos["regime"] = report["analysis"].get("regime")

    # 3. Online weights: fixed-share Hedge on each strategy's confidence-weighted z.
    gains = {n: oos["strategies"][n]["wz"] for n in names}
    gains[NULL] = 0.0
    hw = hedge_update(learned_weights(state, names, cfg), gains, cfg.hedge_eta, cfg.hedge_share)
    if NULL in hw:
        new["ensemble"]["null_weight"] = hw[NULL]
    for n in names:
        old = state["strategies"][n]["weight"]
        new["strategies"][n]["weight"] = hw[n]
        if abs(hw[n] - old) > 1e-6:
            changes.append({"date": day, "kind": "weight", "strategy": n, "from": old, "to": hw[n],
                            "gain_wz": gains[n]})

    # 4. Walk-forward re-tuning with a validation gate.
    days = window_days(day, cfg.lookback_days)
    val_days = days[-cfg.validation_days:]
    train_days = days[:-cfg.validation_days]
    train = window_mask(df.index, train_days, embargo_bars=cfg.horizon_bars, bar=bar)
    val = window_mask(df.index, val_days)
    tuning = {}
    for n in names:
        res = optimise_strategy(n, df, fwd, train, val, state["strategies"][n]["params"], cfg, seed_key=day)
        tuning[n] = res
        if res["adopted"]:
            old = state["strategies"][n]["params"]
            new["strategies"][n]["params"] = res["params"]
            changes.append({"date": day, "kind": "params", "strategy": n, "from": old, "to": res["params"],
                            "train_wz": [res["incumbent"]["train"]["wz"], res["best"]["train"]["wz"]],
                            "val_wz": [res["incumbent"]["val"]["wz"], res["best"]["val"]["wz"]]})
    report["tuning"] = tuning

    # 5. New strategies: trial anything registered but not yet evaluated (or due a re-trial).
    if do_trials:
        report["trials"] = run_trials(df, new, cfg, day, fwd, train, val, changes)

    # 6. Abstention threshold on the tuned ensemble.
    names2 = active(new, df)
    scores2 = score_all(df, new, names2)
    ens2 = combine(scores2, weights_of(new, names2, cfg))
    win = window_mask(df.index, days)
    th = tune_threshold(ens2[win], fwd[win], cfg.threshold_grid, thr, cfg.min_coverage, cfg.threshold_min_gain)
    if th["changed"]:
        new["ensemble"]["threshold"] = th["threshold"]
        changes.append({"date": day, "kind": "threshold", "from": thr, "to": th["threshold"]})
    report["threshold"] = {k: v for k, v in th.items() if k != "table"}
    report["threshold_table"] = [{"threshold": t, **m} for t, m in th["table"]]

    # 7. Guardrail: if the live ensemble has been significantly wrong lately,
    #    stop trusting the learned weights and become more selective.
    recent = [r for r in scoreboard if r["date"] < day][-(cfg.guardrail_days - 1):] + [oos]
    n_r, hits_r, z_r = pooled_z(recent)
    report["guardrail"] = {"days": len(recent), "n": n_r, "hits": hits_r, "z": round(z_r, 3), "tripped": False}
    if len(recent) >= cfg.guardrail_days and z_r <= cfg.guardrail_z:
        report["guardrail"]["tripped"] = True
        uni = round(1.0 / (len(names2) + (1 if cfg.null_expert else 0)), 6)
        for n in names2:
            new["strategies"][n]["weight"] = uni
        if cfg.null_expert:
            new["ensemble"]["null_weight"] = uni
        raised = min(max(cfg.threshold_grid), new["ensemble"]["threshold"] + 0.1)
        new["ensemble"]["threshold"] = raised
        changes.append({"date": day, "kind": "guardrail", "z": round(z_r, 3), "threshold": raised})

    new["version"] = state["version"] + 1
    new["as_of"] = day
    new["last_run"] = day
    report["changes"] = changes
    report["weights"] = weights_of(new, names2, cfg)
    report["state_version"] = new["version"]
    return new, report


def run_trials(df, state, cfg, day, fwd, train, val, changes) -> dict:
    """Trial registered strategies that are not in the live ensemble yet.

    The gate is stricter than for re-tuning an existing strategy: the best
    plateau config must clear max(trial_min_train_wz, luck hurdle) on training,
    be positive on validation, and not make the ensemble worse on validation
    when added at an average weight."""
    reg = S.load_all()
    cands = state.setdefault("candidates", {})
    out = {}
    names = active(state, df)
    base_scores = score_all(df, state, names)
    base_learned = learned_weights(state, names, cfg)
    fams = {n: FAMILY.get(reg[n].category, reg[n].category) for n in reg}
    base_w = effective_weights(base_learned, fams, cfg.equal_blend, cfg.max_method_weight, cfg.max_family_weight)
    base_val = metrics(combine(base_scores, base_w)[val], fwd[val])
    for n, strat in sorted(reg.items()):
        if n in state["strategies"] or n.startswith("_"):
            continue
        info = cands.get(n, {})
        last = info.get("last_trial")
        if last and (pd.Timestamp(day) - pd.Timestamp(last)).days < 7:
            continue
        if not S.has_inputs(strat, df):
            out[n] = {"status": "skipped", "reason": "missing inputs"}
            continue
        res = optimise_strategy(n, df, fwd, train, val, S.canonical(strat, strat.defaults), cfg, seed_key=day)
        best = res["target"]
        p = best["params"]
        s_new = S.compute(n, df, p)
        mean_w = float(np.mean([v for k, v in base_learned.items() if k != NULL])) if base_learned else 1.0
        with_w = effective_weights({**base_learned, n: mean_w}, fams, cfg.equal_blend,
                                   cfg.max_method_weight, cfg.max_family_weight)
        with_val = metrics(combine({**base_scores, n: s_new}, with_w)[val], fwd[val])
        bar_ = max(cfg.trial_min_train_wz, res["hurdle"] or 0.0)
        passed = (
            best["train"]["n"] >= cfg.min_signals
            and best["train"]["wz"] >= bar_
            and best["val"]["wz"] > 0
            and with_val["wz"] >= base_val["wz"]
        )
        rec = {
            "status": "enabled" if passed else "rejected",
            "last_trial": day,
            "params": p,
            "train": best["train"],
            "val": best["val"],
            "bar": round(bar_, 3),
            "n_configs": res["n_candidates"],
            "ensemble_val_wz": [base_val["wz"], with_val["wz"]],
            "trials": info.get("trials", 0) + 1,
        }
        cands[n] = rec
        out[n] = rec
        if passed:
            weights = [s["weight"] for s in state["strategies"].values() if s.get("enabled")]
            start_w = round(min(weights) if weights else 0.1, 6)
            state["strategies"][n] = {"params": p, "weight": start_w, "enabled": True, "added": day}
            changes.append({"date": day, "kind": "enable", "strategy": n, "params": p,
                            "train_wz": best["train"]["wz"], "val_wz": best["val"]["wz"]})
    return out


def backtest(df_all: pd.DataFrame, state: dict, cfg: Config, days: list[str], log=None,
             do_trials: bool = True) -> tuple[dict, list[dict], list[dict]]:
    board, reports = [], []
    for d in days:
        state, rep = run_day(df_all, state, cfg, d, board, do_trials=do_trials)
        board.append(rep["oos"])
        reports.append(rep)
        if log:
            e = rep["oos"]["ensemble"]
            log(f"{d}: n={e['n']} acc={e['acc']} z={e['z']} changes={len(rep['changes'])}")
    return state, board, reports


def edge_evidence(hits: int, n: int, lam: float = 0.04) -> dict:
    """Anytime-valid evidence that the hit rate beats 50% (betting martingale).

    Betting a fraction ``lam`` on every call being right turns 1 unit of wealth
    into K = (1+lam)^hits * (1-lam)^misses. Under a true 50% hit rate K is a
    martingale, so by Ville's inequality P(K ever >= 20) <= 5%, however often it
    is checked. This is the right statistic to watch daily; repeated z-tests are
    not (a daily 5% z-test "finds" an edge in ~24% of 30-day coin-flip runs).
    lam = 0.04 is tuned for a true rate near 52%."""
    misses = n - hits
    log_k = hits * math.log1p(lam) + misses * math.log1p(-lam)
    log_k_against = hits * math.log1p(-lam) + misses * math.log1p(lam)
    return {
        "log10_K": round(log_k / math.log(10), 3),
        "edge_confirmed": log_k >= math.log(20),
        "worse_than_coin_confirmed": log_k_against >= math.log(20),
    }


def summarise_board(board: list[dict]) -> dict:
    n, hits, z = pooled_z(board)
    n_all, hits_all, z_all = pooled_z(board, "ensemble_all")
    out = {
        "days": len(board),
        "ensemble": {"n": n, "hits": hits, "acc": round(hits / n, 4) if n else None, "z": round(z, 3)},
        "ensemble_all": {"n": n_all, "hits": hits_all, "acc": round(hits_all / n_all, 4) if n_all else None,
                         "z": round(z_all, 3)},
        "baselines": {},
    }
    for b in ("always_up", "persistence", "anti_persistence"):
        nb = sum(r["baselines"][b]["n"] for r in board)
        hb = sum(r["baselines"][b]["hits"] for r in board)
        out["baselines"][b] = {"n": nb, "acc": round(hb / nb, 4) if nb else None}
    net = [r["ensemble"]["net_bps"] * r["ensemble"]["n"] for r in board if r["ensemble"]["n"]]
    gross = [r["ensemble"]["gross_bps"] * r["ensemble"]["n"] for r in board if r["ensemble"]["n"]]
    out["ensemble"]["gross_bps_per_call"] = round(sum(gross) / n, 3) if n else None
    out["ensemble"]["net_bps_per_call"] = round(sum(net) / n, 3) if n else None
    out["ensemble"]["evidence"] = edge_evidence(hits, n)
    out["ensemble_all"]["evidence"] = edge_evidence(hits_all, n_all)
    return out


def strategy_table(board: list[dict]) -> dict:
    """Pooled out-of-sample record of each strategy across the given days."""
    agg: dict[str, dict] = {}
    for r in board:
        for name, m in r.get("strategies", {}).items():
            a = agg.setdefault(name, {"days": 0, "n": 0, "hits": 0, "wz_sum": 0.0})
            a["days"] += 1
            a["n"] += m["n"]
            a["hits"] += m["hits"]
            a["wz_sum"] += m["wz"]
    for a in agg.values():
        a["acc"] = round(a["hits"] / a["n"], 4) if a["n"] else None
        a["z"] = round((a["hits"] - a["n"] / 2) / math.sqrt(a["n"] / 4), 3) if a["n"] else 0.0
        a["mean_daily_wz"] = round(a.pop("wz_sum") / a["days"], 3)
    return dict(sorted(agg.items(), key=lambda kv: -kv[1]["z"]))
