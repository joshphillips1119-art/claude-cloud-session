"""Command line: ``python -m scalper <command>``."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import strategies as S
from .config import ROOT, load
from .data import Store, import_csv
from .journal import render
from .pipeline import backtest, run_day, strategy_table, summarise_board, window_days
from .state import StateStore, initial_state

EXIT_DATA_UNAVAILABLE = 2


def clean(obj):
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def yesterday() -> str:
    return (pd.Timestamp.now(tz="UTC").floor("D") - pd.Timedelta(days=1)).strftime("%Y-%m-%d")


def next_day(day: str) -> str:
    return (pd.Timestamp(day) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")


def cmd_init(args, cfg):
    ss = StateStore(cfg)
    if ss.exists() and not args.force:
        print(f"state already exists at {ss.params_path}; use --force to reset")
        return 0
    ss.save(initial_state())
    print(f"initialised {ss.params_path}")
    return 0


def cmd_fetch(args, cfg):
    end = args.end or yesterday()
    days = window_days(end, args.days)
    rep = Store(cfg).ensure(days)
    print(json.dumps(clean(rep), indent=1))
    return EXIT_DATA_UNAVAILABLE if rep["errors"].get("missing_days") else 0


def _data_days(cfg, day):
    return window_days(day, cfg.lookback_days + cfg.warmup_days) + [next_day(day)]


def cmd_daily(args, cfg):
    day = args.date or yesterday()
    ss, store = StateStore(cfg), Store(cfg)
    state = ss.load() if ss.exists() else initial_state()
    board = ss.scoreboard()
    if state.get("last_run") and state["last_run"] >= day:
        if not args.force:
            print(f"already ran for {state['last_run']} (>= {day}); use --force to redo {day}")
            return 0
        snap = ss.load_snapshot(day)
        if snap is None:
            print(f"no snapshot for {day}; cannot safely redo")
            return 1
        state = snap
        board = [r for r in board if r["date"] < day]
    ss.snapshot_before(day, state)

    days = _data_days(cfg, day)
    fetch_rep = {"skipped": True}
    if not args.no_fetch:
        fetch_rep = store.ensure(days)
    df = store.load(days[0], days[-1])
    lo = pd.Timestamp(day, tz="UTC")
    if df.empty or not ((df.index >= lo) & (df.index < lo + pd.Timedelta(days=1))).any():
        msg = {"status": "DATA_UNAVAILABLE", "day": day, "symbol": cfg.symbol,
               "errors": fetch_rep.get("errors"), "hint": "check the environment's network access policy "
               "allows the hosts in config.sources, or import a CSV with `python -m scalper import-csv`"}
        print(json.dumps(clean(msg), indent=1))
        return EXIT_DATA_UNAVAILABLE

    new_state, report = run_day(df, state, cfg, day, board)
    report["data"] = {"provenance": {d: store.manifest.get(d) for d in days}, "fetch": fetch_rep}
    board.append(report["oos"])
    summary = summarise_board(board)

    ss.save(new_state)
    ss.write_scoreboard([clean(r) for r in board])
    ss.append_changes(clean(report["changes"]))
    jdir = ROOT / cfg.journal_dir
    jdir.mkdir(parents=True, exist_ok=True)
    (jdir / f"{day}.md").write_text(render(clean(report), cfg.to_dict(), summary))
    slim = {k: v for k, v in report.items() if k != "tuning"}
    slim["tuning"] = {n: {k: t[k] for k in ("adopted", "params", "incumbent", "target", "proposal", "hurdle",
                                             "rejected_because", "flip_day_frac", "n_candidates")}
                      for n, t in report["tuning"].items()}
    (jdir / f"{day}.json").write_text(json.dumps(clean(slim), indent=1) + "\n")

    e = report["oos"]["ensemble"]
    print(json.dumps(clean({
        "status": "OK", "day": day, "regime": report["analysis"].get("regime"),
        "ensemble_oos": e, "baselines": {k: v["acc"] for k, v in report["oos"]["baselines"].items()},
        "changes": len(report["changes"]),
        "enabled_new": [c["strategy"] for c in report["changes"] if c["kind"] == "enable"],
        "guardrail": report["guardrail"], "state_version": new_state["version"],
        "journal": str((jdir / f"{day}.md").relative_to(ROOT)), "track_record": summary,
    }), indent=1))
    return 0


def cmd_backtest(args, cfg):
    days = window_days(args.end, (pd.Timestamp(args.end) - pd.Timestamp(args.start)).days + 1)
    store = Store(cfg)
    first = window_days(days[0], cfg.lookback_days + cfg.warmup_days)[0]
    if not args.no_fetch:
        store.ensure(window_days(next_day(days[-1]), len(days) + cfg.lookback_days + cfg.warmup_days + 1))
    df = store.load(first, next_day(days[-1]))
    state = initial_state() if args.fresh or not StateStore(cfg).exists() else StateStore(cfg).load()
    final, board, reports = backtest(df, state, cfg, days, log=print, do_trials=not args.no_trials)
    summary = summarise_board(board)
    print(json.dumps(clean(summary), indent=1))
    if args.out:
        Path(args.out).write_text(json.dumps(clean({"summary": summary, "board": board,
                                                    "final_state": final}), indent=1) + "\n")
    return 0


def cmd_trial(args, cfg):
    """Trial one (or every untested) registered strategy against the latest window now,
    instead of waiting for the next daily run. Records the result; enables on --adopt."""
    from .evaluate import forward_returns, window_mask
    from .pipeline import run_trials, slice_for

    ss, store = StateStore(cfg), Store(cfg)
    state = ss.load() if ss.exists() else initial_state()
    day = args.date or state.get("as_of") or yesterday()
    days = _data_days(cfg, day)
    if not args.no_fetch:
        store.ensure(days)
    df = slice_for(store.load(days[0], days[-1]), day, cfg)
    if df.empty:
        print(json.dumps({"status": "DATA_UNAVAILABLE", "day": day}))
        return EXIT_DATA_UNAVAILABLE
    reg = S.load_all()
    names = [n for n in reg if n not in state["strategies"]] if args.name == "all-new" else [args.name]
    for n in names:
        if n not in reg:
            print(f"unknown strategy {n!r}; registered: {sorted(reg)}")
            return 1
        if n in state["strategies"]:
            print(f"{n} is already in the live ensemble")
            return 1
    trial_state = json.loads(json.dumps(state))
    # Only the requested names, and ignore the 7-day re-trial cooldown.
    trial_state["candidates"] = {k: v for k, v in trial_state.get("candidates", {}).items() if k not in names}
    hidden = {k: reg.pop(k) for k in list(reg) if k not in names and k not in state["strategies"]}
    try:
        bar = pd.Timedelta(minutes=cfg.interval_minutes)
        fwd = forward_returns(df, cfg.horizon_bars, cfg.label_mode, bar)
        wd = window_days(day, cfg.lookback_days)
        train = window_mask(df.index, wd[:-cfg.validation_days], embargo_bars=cfg.horizon_bars, bar=bar)
        val = window_mask(df.index, wd[-cfg.validation_days:])
        changes = []
        results = run_trials(df, trial_state, cfg, day, fwd, train, val, changes)
    finally:
        reg.update(hidden)
    log = ROOT / "research" / "trials.jsonl"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as f:
        for n, r in results.items():
            f.write(json.dumps(clean({"name": n, "window_end": day, **r})) + "\n")
    if args.adopt:
        state.setdefault("candidates", {}).update(trial_state["candidates"])
        for c in changes:
            if c["kind"] == "enable":
                state["strategies"][c["strategy"]] = trial_state["strategies"][c["strategy"]]
        if changes:
            state["version"] += 1
            ss.append_changes(clean(changes))
        # Save rejections too, so the 7-day re-trial cooldown applies to them.
        ss.save(state)
    print(json.dumps(clean({"window_end": day, "results": results,
                            "adopted": [c["strategy"] for c in changes] if args.adopt else [],
                            "would_adopt": [c["strategy"] for c in changes]}), indent=1))
    return 0


def cmd_status(args, cfg):
    ss = StateStore(cfg)
    if not ss.exists():
        print("no state yet; run `python -m scalper init`")
        return 0
    st = ss.load()
    board = ss.scoreboard()
    print(json.dumps(clean({
        "version": st["version"], "as_of": st["as_of"], "threshold": st["ensemble"]["threshold"],
        "strategies": {n: {"w": s["weight"], "enabled": s["enabled"], "params": s["params"]}
                       for n, s in st["strategies"].items()},
        "candidates": st.get("candidates", {}),
        "last_days": [{"date": r["date"], "acc": r["ensemble"]["acc"], "n": r["ensemble"]["n"],
                       "z": r["ensemble"]["z"], "regime": r.get("regime")} for r in board[-7:]],
        "track_record": summarise_board(board) if board else None,
        "registered": sorted(S.load_all()),
    }), indent=1))
    return 0


def cmd_report(args, cfg):
    """Out-of-sample summary of the last N scored days (for the weekly check-in)."""
    board = StateStore(cfg).scoreboard()
    if not board:
        print(json.dumps({"status": "NO_HISTORY"}))
        return 0
    last = board[-args.days:]
    regimes: dict[str, int] = {}
    for r in last:
        regimes[r.get("regime") or "unknown"] = regimes.get(r.get("regime") or "unknown", 0) + 1
    print(json.dumps(clean({
        "window": [last[0]["date"], last[-1]["date"]],
        "summary": summarise_board(last),
        "all_time": summarise_board(board),
        "strategies": strategy_table(last),
        "regimes": regimes,
        "daily": [{"date": r["date"], "acc": r["ensemble"]["acc"], "n": r["ensemble"]["n"],
                   "acc_all": r["ensemble_all"]["acc"], "threshold": r.get("threshold")} for r in last],
    }), indent=1))
    return 0


def cmd_import_csv(args, cfg):
    days = import_csv(cfg, Path(args.path), args.source)
    print(f"imported {len(days)} days: {days[0]}..{days[-1]}" if days else "nothing imported")
    return 0


def cmd_synth(args, cfg):
    from .synthetic import generate

    cfg.symbol = args.symbol
    df = generate(args.days, start=args.start, seed=args.seed, phi=args.phi, flow_beta=args.flow_beta)
    store = Store(cfg)
    for d in sorted(set(df.index.strftime("%Y-%m-%d"))):
        lo = pd.Timestamp(d, tz="UTC")
        store.save_day(d, df[(df.index >= lo) & (df.index < lo + pd.Timedelta(days=1))], "synthetic", True)
    print(f"wrote {args.days} synthetic days to {store.dir}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="scalper", description=__doc__)
    p.add_argument("--config", type=Path, default=None)
    p.add_argument("--symbol", default=None, help="override config symbol")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init"); s.add_argument("--force", action="store_true")
    s = sub.add_parser("fetch"); s.add_argument("--days", type=int, default=16); s.add_argument("--end")
    s = sub.add_parser("daily", help="score yesterday, analyse, re-tune, trial, journal")
    s.add_argument("--date"); s.add_argument("--force", action="store_true"); s.add_argument("--no-fetch", action="store_true")
    s = sub.add_parser("backtest", help="replay the daily loop over past days (out-of-sample)")
    s.add_argument("--start", required=True); s.add_argument("--end", required=True)
    s.add_argument("--fresh", action="store_true"); s.add_argument("--no-fetch", action="store_true")
    s.add_argument("--no-trials", action="store_true"); s.add_argument("--out")
    s = sub.add_parser("trial", help="trial a new strategy now (name or 'all-new')")
    s.add_argument("name"); s.add_argument("--date"); s.add_argument("--adopt", action="store_true")
    s.add_argument("--no-fetch", action="store_true")
    sub.add_parser("status")
    s = sub.add_parser("report", help="out-of-sample summary of the last N days"); s.add_argument("--days", type=int, default=7)
    s = sub.add_parser("import-csv"); s.add_argument("path"); s.add_argument("--source", default="manual")
    s = sub.add_parser("synth"); s.add_argument("--days", type=int, default=20); s.add_argument("--start", default="2026-09-01")
    s.add_argument("--seed", type=int, default=0); s.add_argument("--phi", type=float, default=0.0)
    s.add_argument("--flow-beta", type=float, default=0.0); s.add_argument("--symbol", default="SYNTH")

    args = p.parse_args(argv)
    cfg = load(args.config)
    if args.symbol and args.cmd != "synth":
        cfg.symbol = args.symbol
    return {
        "init": cmd_init, "fetch": cmd_fetch, "daily": cmd_daily, "backtest": cmd_backtest,
        "status": cmd_status, "report": cmd_report, "trial": cmd_trial, "import-csv": cmd_import_csv, "synth": cmd_synth,
    }[args.cmd](args, cfg)


if __name__ == "__main__":
    sys.exit(main())
