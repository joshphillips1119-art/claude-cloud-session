# 5m Scalp Playbook (living document)

This file changes every day. `improve.py` writes the evidence to `reports/` and
`state/scores.json`, and each day's adjustments are added to the changelog
below. Hit rate means: did the rule call the next 5m candle's direction
correctly (close vs open). Fees and slippage are not included.

## Current rules (as of 2026-10-13)

1. **Base edge is mean reversion, not momentum.** Over the last 7 days, the
   one-bar reversal, Bollinger 2sd fade, 3-bar streak fade and taker-exhaustion
   fade all scored z > 2.3. One-bar momentum and following taker flow both
   scored worse than a coin flip (z about -2.9).
2. **NEW: only fade with the 4h trend.** On 10/12 (BTC -2.3%, ETH -3.5%,
   SOL -5.0%, steady trend down), the ungated fades lost: VWAP 3σ reversion hit
   44.5%, and the ensemble hit 45-48% on ETH and SOL. Gating the fade so it
   only fires in the 4h trend direction (price vs EMA48 with EMA48 slope)
   lifted the one-bar fade from 50.6% to 54.5% (n=330). The gate is not proven
   yet: across the 7-day training window it was only 50.6%. Watch it.
3. **On a trend day, stand aside from VWAP reversion.** If price stays on one
   side of VWAP and the 4h trend is clean, VWAP 3σ reversion is the
   worst-performing rule.
4. **Don't trust wick rejection.** It hit 40.6% on 10/12 and was negative in
   training too. It stays benched.
5. **Watch list:** RSI14 extreme fade (63% on n=38), hour-of-day bias (64% on
   n=84, fit on the trailing week). Both samples are too small. Keep logging
   them and promote one only after its decayed history passes z ≥ 2.

## Daily changelog

### 2026-10-13 (reviewed 2026-10-12)
- Built the self-improvement loop (`improve.py`): 7-day train, then a
  walk-forward test on yesterday, with decayed history in `state/scores.json`.
- Added `trend_gated_fade` and `trend_gated_bb_fade` after the trend-day
  failure of the ungated fades.
- Ideas to test next: a sizing filter based on realized volatility, a
  session-open (00:00 / 08:00 / 13:30 UTC) breakout rule, and funding/basis as
  a bias filter.
