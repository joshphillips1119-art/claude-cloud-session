"""End-to-end checks of the learning loop on synthetic markets with known truth.

These are the tests that matter most: the loop must NOT invent an edge on a
random walk, and it MUST find and track a real one when it exists.
"""
import copy

import pandas as pd
import pytest

from scalper.config import Config
from scalper.pipeline import backtest, run_day, summarise_board, window_days
from scalper.state import initial_state
from scalper.synthetic import generate

CFG = Config(lookback_days=8, validation_days=2, warmup_days=1, min_signals=100, min_val_signals=30)


def _days(df, n):
    last = df.index[-1].strftime("%Y-%m-%d")
    # last calendar day has no next-day bar for its final label; score the days before it
    end = (pd.Timestamp(last) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    return window_days(end, n)


@pytest.fixture(scope="module")
def random_walk():
    return generate(22, seed=11, phi=0.0, flow_beta=0.0)


def test_no_false_edge_on_random_walk(random_walk):
    _, board, reports = backtest(random_walk, initial_state(), CFG, _days(random_walk, 10), do_trials=False)
    s = summarise_board(board)
    assert abs(s["ensemble_all"]["z"]) < 3.0, s
    assert 0.46 <= s["ensemble_all"]["acc"] <= 0.54, s
    adopted = sum(1 for r in reports for c in r["changes"] if c["kind"] == "params")
    # 10 strategies x 10 days = 100 opportunities to overfit; the gate should block most.
    assert adopted <= 30, f"too many param changes on pure noise: {adopted}"


def test_finds_momentum_edge():
    df = generate(20, seed=3, phi=0.2)
    _, board, _ = backtest(df, initial_state(), CFG, _days(df, 8), do_trials=False)
    s = summarise_board(board)
    assert s["ensemble"]["acc"] > 0.54 and s["ensemble"]["z"] > 3, s


def test_adapts_to_regime_flip():
    # Momentum for 14 days, then mean reversion: the loop must flip within days.
    df = generate(26, seed=5, phi=lambda d: 0.25 if d < 14 else -0.25)
    _, board, _ = backtest(df, initial_state(), CFG, _days(df, 16), do_trials=False)
    late = [r for r in board if r["date"] >= "2026-09-20"]
    s = summarise_board(late)
    assert s["ensemble"]["acc"] > 0.53, s


def test_learns_order_flow_weight():
    df = generate(20, seed=9, phi=0.0, flow_beta=0.35)
    state, board, _ = backtest(df, initial_state(), CFG, _days(df, 8), do_trials=False)
    w = {n: s["weight"] for n, s in state["strategies"].items()}
    assert max(w, key=w.get) == "taker_flow", w
    assert summarise_board(board)["ensemble"]["acc"] > 0.53


def test_run_day_is_pure_and_versioned():
    df = generate(12, seed=1, phi=0.1)
    st = initial_state()
    before = copy.deepcopy(st)
    new, rep = run_day(df, st, CFG, "2026-09-10", [])
    assert st == before, "run_day must not mutate its input state"
    assert new["version"] == 1 and new["as_of"] == "2026-09-10"
    assert rep["oos"]["version"] == 0, "yesterday must be scored with the params live before the run"
    assert abs(sum(rep["weights"].values()) - 1) < 1e-6


def test_guardrail_trips_on_persistent_losses():
    df = generate(12, seed=1, phi=0.1)
    bad = [{"date": f"2026-09-0{i}", "ensemble": {"n": 200, "hits": 70}} for i in range(5, 9)]
    cfg = Config(**{**CFG.to_dict(), "guardrail_days": 5, "guardrail_z": -2.0})
    new, rep = run_day(df, initial_state(), cfg, "2026-09-10", bad)
    assert rep["guardrail"]["tripped"]
    ws = [s["weight"] for s in new["strategies"].values() if s["enabled"]]
    assert max(ws) - min(ws) < 1e-6


def test_trial_rejects_noise_strategy(monkeypatch):
    from scalper import strategies as S
    import numpy as np

    @S.register("_coinflip_test", defaults={"seed": 0}, grid={"seed": [0, 1, 2]}, category="other",
                description="random scores for testing", invertible=False)
    def coinflip(df, seed):
        return pd.Series(np.random.default_rng(seed).uniform(-1, 1, len(df)), index=df.index)

    try:
        df = generate(12, seed=2)
        new, rep = run_day(df, initial_state(), CFG, "2026-09-10", [])
        assert rep["trials"]["_coinflip_test"]["status"] == "rejected"
        assert "_coinflip_test" not in new["strategies"]
        assert new["candidates"]["_coinflip_test"]["last_trial"] == "2026-09-10"
    finally:
        S.REGISTRY.pop("_coinflip_test", None)
