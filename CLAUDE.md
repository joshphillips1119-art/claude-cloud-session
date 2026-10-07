# 5-minute scalp predictor: operating manual

This repo is a self-improving system that predicts the direction of the next
5-minute candle (default: BTC/USDT, see `config.json`). It runs once a day
from a scheduled Claude Code routine. The routine prompt is roughly *"run the
self-improvement mechanism, analyse yesterday's market, adjust the 5-min
scalps, find a new method every day"*. This file says exactly how.

## Daily routine (do these in order)

1. **Sync yesterday's learning state.** Each run starts from a fresh clone, and
   the learned state lives on `claude/scalper-live`:
   ```bash
   scripts/sync_state.sh
   ```
   If it reports a code conflict, stop and notify the user.

2. **Run the cycle for yesterday (UTC):**
   ```bash
   python -m scalper daily
   ```
   This fetches bars, scores yesterday's live predictions out-of-sample, analyses
   the day, updates ensemble weights (fixed-share Hedge), re-tunes each
   strategy's params with walk-forward validation, trials any new strategy,
   tunes the abstention threshold, applies the guardrail, then writes
   `journal/<day>.md` + `.json` and updates `state/`.
   * Exit code **2 / `DATA_UNAVAILABLE`**: the data hosts are blocked or down.
     Do **not** invent market data or results. Notify the user with the
     `errors` from the output (usually the environment's network policy must
     allow the hosts in `config.json` → `sources`) and stop.
   * "already ran": the state is already up to date. Continue at step 4.

3. **Read the journal** (`journal/<day>.md`) and append a short `## 6. Notes`
   section in your own words: what the regime was, which strategies
   worked or failed and the likely reason, and what changed. You may web-search
   for that day's catalysts (macro prints, ETF flows, liquidations) to explain
   outliers, with sources. Never edit the numbers.

4. **Find and test one new method.** This is the "new strategy every day" part:
   1. Open `research/backlog.md`. Take the highest-priority item with status
      `idea`. If none are left, research one: search the web for evidence on
      5-minute / intraday predictability and add 1-3 items with sources first.
   2. Implement it as `scalper/strategies/<slug>.py` with `@register(...)`
      (see the contract below and `scalper/strategies/core.py` for examples).
   3. `python -m pytest -q tests/test_causality.py`. It **must** pass. It
      catches lookahead mechanically.
   4. `python -m scalper trial <slug> --adopt --no-fetch`. This tunes it on
      the trailing window and enables it only if it clears the gate (train
      wz >= 2, positive validation wz, and it does not hurt the ensemble on
      validation).
   5. Update the backlog item's status to `adopted` or `rejected` with the
      trial numbers and the date. Rejected strategies stay registered. The
      daily run re-trials them every 7 days, because regimes change.

5. **Run all tests:** `python -m pytest -q`. Fix anything red before publishing.

6. **Publish:**
   ```bash
   scripts/publish_state.sh "scalper: <day> daily cycle (<one-line summary>)"
   ```
   It commits `state/ data/ journal/ research/` plus any new strategy code, and
   pushes both the session branch and `claude/scalper-live`.

7. **Notify the user only if something needs them:** `DATA_UNAVAILABLE`, the
   guardrail tripped, a test you could not fix, or a sync conflict. Also
   notify once a week (Mondays) with the 7-day out-of-sample hit rate vs the
   baselines. Lead with the number.

## Honesty rules (non-negotiable)

* The only performance figures that count are in `state/scoreboard.jsonl`:
  each day scored with params chosen **before** that day. Never quote
  training/tuning numbers as accuracy.
* Always compare against the baselines in the journal (always-up,
  persistence, anti-persistence) and quote the 95% interval. At 5 minutes,
  52-55% is a real edge and 60%+ on a few hundred calls is usually luck.
* Report net-of-cost figures next to hit rates. `cost_vs_move` in the journal
  shows how much of an average 5-minute move fees eat.
* Do not loosen the gates (`adopt_min_gain`, `trial_min_train_wz`,
  `min_signals`, guardrail) to make something pass. If you think a gate is
  wrong, write the case in the journal notes and leave it for the user.
* Never relax causality: no centred windows, `shift(-k)`, or full-sample
  normalisation in strategies.

## Strategy contract

```python
from .. import indicators as ind
from . import register

@register("my_slug",
          defaults={"n": 12, "k": 1.0},
          grid={"n": [6, 12, 24], "k": [0.5, 1.0, 2.0]},   # keep total combos <= ~60
          category="momentum",          # momentum | mean_reversion | breakout | order_flow | volatility | seasonality | regime | other
          description="One line: what it predicts and why.",
          requires=("open", "high", "low", "close", "volume"),   # add "taker_buy_volume" / "trades" if used
          source="https://... (paper or write-up that motivated it)")
def my_slug(df, n, k):
    ...                 # use only rows <= t; prefer helpers in scalper/indicators.py
    return score        # pd.Series aligned to df.index, in [-1, 1], + = up, NaN while warming up
```

The framework adds `_sign` in {+1, -1} so the tuner can flip momentum and
reversal. Set `invertible=False` only when the flip is meaningless.

Causal helpers in `scalper/indicators.py`: `ema`, `wilder`, `rsi`, `atr`,
`zscore`, `realized_vol`, `session_vwap`, `rolling_autocorr`, `same_slot`
(same time-of-day statistic over previous days), `seasonal_vol_factor`
(removes the intraday volatility smile), `bvc_buy_fraction` (buy-volume share
estimate for venues without taker data), and `squash` (tanh into [-1, 1]).

## Layout

| path | what |
|---|---|
| `scalper/pipeline.py` | `run_day`, the daily cycle; `backtest` replays it over history |
| `scalper/strategies/` | one module per family, auto-discovered |
| `scalper/optimize.py` | walk-forward tuning with the adoption gate |
| `scalper/ensemble.py` | weighted combination, fixed-share Hedge, threshold tuning |
| `scalper/evaluate.py` | labels, hit rate, Wilson CI, z / weighted z, baselines |
| `scalper/data.py` | Binance / Bybit / OKX / Coinbase / Kraken / Yahoo adapters + per-day CSV cache |
| `state/` | live params + weights, out-of-sample scoreboard, change log, snapshots |
| `journal/` | one report per day |
| `research/` | backlog of methods to try, methodology notes, trial log |

Useful commands: `python -m scalper status`, `python -m scalper backtest
--start 2026-09-01 --end 2026-09-30 --fresh --out /tmp/bt.json` (judge a change
to the *mechanism* by replaying it out-of-sample), `python -m scalper
daily --date YYYY-MM-DD --force` (redo a day from its snapshot).
