# claude-cloud-session: self-improving 5-minute scalp predictor

A daily Claude Code routine uses this repo to predict the direction of the next
5-minute candle (default BTC/USDT). Every day it:

1. **Scores yesterday out-of-sample** with the parameters that were live,
   against naive baselines (always-up, persistence, anti-persistence).
2. **Analyses yesterday's market**: volatility vs. its 7-day median, lag-1
   autocorrelation and variance ratio (trending vs mean-reverting), active
   hours, and whether the big bars continued or reversed.
3. **Re-weights strategies** with fixed-share Hedge, so the ensemble leans
   toward what is working without permanently abandoning what isn't.
4. **Re-tunes each strategy** on a 14-day walk-forward window. A change is
   adopted only if it beats the incumbent on training by a margin *and* is no
   worse on the 3 most recent held-out days.
5. **Tests one new method a day** from `research/backlog.md`. It is enabled
   only if it clears a stricter gate and does not hurt the ensemble.
6. **Tunes the abstention threshold**, so the ensemble only calls bars when it
   is confident, with a minimum coverage.
7. **Guardrail:** if the live ensemble is significantly wrong over 5 days,
   the weights reset and the system becomes more selective.

Everything is versioned in git: `state/` (params, weights, the out-of-sample
scoreboard, the change log), `journal/` (a daily report), `data/` (cached
bars).

## Quick start

```bash
pip install -r requirements.txt
python -m scalper init
python -m scalper daily                 # yesterday, UTC
python -m scalper status
python -m pytest -q
```

Offline demo on synthetic data:

```bash
python -m scalper --symbol SYNTH synth --days 20 --phi 0.12 --flow-beta 0.15
python -m scalper --symbol SYNTH backtest --start 2026-09-10 --end 2026-09-18 --fresh --no-fetch
```

## Choosing the market

Edit `config.json`:

| market | settings |
|---|---|
| BTC/USDT spot (default) | `"symbol": "BTCUSDT"` |
| ETH | `"symbol": "ETHUSDT"`, `symbol_map` → `ETH-USD` / `XETHZUSD` / `ETH-USDT` |
| Prediction-market 5m up/down (e.g. Polymarket) | add `"label_mode": "open_to_close"`, `"cost_bps_round_trip": 0` |
| SPY / ES via Yahoo | `"symbol": "SPY"`, `"sources": ["yahoo"]`, `"symbol_map": {"yahoo": "SPY"}` |

## Network access

The routine's cloud environment must be allowed to reach the data hosts.
Set the environment's network access to **Custom** (or Full) and allow at least
one of `api.binance.com`, `data-api.binance.vision`, `api.binance.us`,
`api.bybit.com`, `www.okx.com`, `api.exchange.coinbase.com`, `api.kraken.com`,
or `query1.finance.yahoo.com`. With the default policy every daily run stops at
`DATA_UNAVAILABLE`, and the routine notifies you instead of guessing.

## Reading the numbers

At a 5-minute horizon, direction is close to a coin flip. A sustained 52-55%
out-of-sample hit rate is a real edge. Fees and slippage of ~10 bps round
trip are often as large as the average 5-minute move, so the journal always
shows net-of-cost figures next to hit rates. Only the out-of-sample
scoreboard (`state/scoreboard.jsonl`) counts as a track record.

This is research tooling, not financial advice. It places no orders.
