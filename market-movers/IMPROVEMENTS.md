# Market Movers — improvement log

Newest first. Each entry: what changed, and the evidence for it.

## 2026-08-14 — Self-scoring foundation + macro variables

**The gap:** every model graded its own signals (A–D, conviction tiers, options judgments) but
nothing ever recorded whether those signals were *right*. "Accuracy" was an assertion, not a
measurement, so there was no way to improve it except by taste.

**Added — signal ledger (`data/signals.json`, persistent):**
- Every scalp setup and position pick is recorded with entry / stop / target, deduped so a live
  setup is logged once rather than on every poll.
- A resolver replays real subsequent candles and asks the only question that matters: did the
  target hit before the stop? Outcomes: win / loss / expired-favourable / expired-adverse, plus
  `void` when both levels hit inside one bar (unknowable order — scored as neither).
- Runs every 10 minutes, survives restarts, atomic writes so a crash can't corrupt it.
- Verified with backdated signals built from real BTC candles with known outcomes: the resolver
  scored the intended win and the intended loss correctly.

**Added — evidence-based weighting (`reliabilityAdj`):** once a strategy or grade has 20+ resolved
trades, new signals of that type are nudged up or down by its measured hit rate. Below 20 the
adjustment is deliberately zero — small samples are noise, and chasing them makes models worse.

**Added — variables the models were blind to:**
- Dollar index (DXY), US 10-year yield, VIX — via CNBC dailies, feeding Position Picks. Gold and
  commodities now react to the dollar and real yields; equities to the volatility regime.
- Session timing: setups fired in an hour that is historically choppy for that asset class are
  penalised (−12), setups in its most directional hours rewarded (+6). Previously the scalp
  grader had no concept of *when* it was trading.
- Crypto open-interest trend helper (price up + OI up = real money; price up + OI down = short
  covering) available for future trend confirmation.

**Added — Self-Check tab:** measured hit rates by strategy, grade and direction, the macro
backdrop, and a ledger of recent signals with their real outcomes. Shows "needs N more to
activate" rather than pretending a 3-trade sample means anything.

## 2026-08-14 (later) — Self-improvement wired into the scalp desks + 15-minute timeframe

**Surfaced the feedback loop in the 5-minute desk.** The ledger was already recording scalp
setups, but the desk never showed what those signals had achieved. Added a track-record panel
(hit rate, per-strategy W/L, and how close each strategy is to the 20-trade threshold where
auto-tuning switches on), a measured hit-rate badge beside each strategy name in the scanner,
and a ⚙ line on any setup whose score was adjusted — so timing and track-record adjustments are
visible rather than silent.

**First real evidence:** EMA Pullback is running **30.8% over 13 resolved 5-minute trades**.
Below the 20-trade threshold, so no automatic adjustment yet — deliberately. If it holds, the
reliability adjustment will begin marking it down on its own.

**Added the 15-minute desk.** Refactored the scanner into one timeframe-parameterised engine
(`getScalpTf`) rather than duplicating it, so both desks share the same six strategies, grading
and confluence logic. 15-minute specifics: 3-hour coil window, 8-hour resolution horizon
(32 bars), 2-minute refresh, and a separate ledger kind (`scalp15`) so its accuracy is measured
independently. Head-to-head tiles on both desks compare the two timeframes on identical
strategies — the honest way to choose one.

**Scoped the auto-tuning per timeframe.** `reliabilityAdj` now filters by ledger kind: a strategy
that works on 15-minute candles is no longer penalised by its 5-minute record.

## 2026-08-14 (later still) — Precise entry mechanics on both scalp desks

**The gap:** the desks gave a trigger *price* but never said where that price sat on the candle,
how to get a better fill, or when the trade had already run too far to be worth taking.

**Added `buildEntryPlan()`** to every setup on both timeframes:
- **Order type and exact location** — "Buy stop 10% of a candle-height above the trigger candle's
  HIGH (1,889.3)", so the order's position on the candle is unambiguous.
- **Wick read** — long lower wick on a long = buyers defended the low (supportive); heavy opposing
  wick = weaker, demand a decisive break. Body-dominant candles are called out as clean.
- **Better fill** — the patient limit back at the candle mid-body / EMA9 retest, with the improved
  reward:risk it earns and the honest warning that it may never fill.
- **Max chase** — the price beyond which reward:risk drops under 1.3:1 even if the direction is
  right. This is the line most people cross.
- **Live status** — armed / not yet / triggered / chased-out, with distance in % and ATR.
- **Invalidation** — the condition that kills the setup before it ever triggers.

**Added an SVG candle diagram** rendering the trigger candle to scale with entry, stop, T1/T2,
max-chase and better-fill drawn as labelled levels, and the reward/risk zones shaded — the visual
answer to "where on the candlestick do I enter".

**Fixed:** clicking a 5-minute scanner row now switches the chart to 5m, so the entry plan
describes the setup that was actually clicked (it previously charted at 1m and reported no setup).

**Fixed:** thin futures bars that print high === low produced no plan at all; the range now falls
back to ATR so the levels still render.

**Track-record note:** EMA Pullback is at 23.5% over 17 resolved 5-minute trades — three away from
the 20-trade threshold where the reliability adjustment begins marking it down automatically.

## 2026-08-15 — Two measurement bugs that were inventing losses

The self-scoring system was itself wrong, so every hit rate it had produced was fiction.

**Bug 1 — unbounded replay window.** The resolver checked target-vs-stop across *every* candle
since the signal, ignoring the signal's own horizon. A 4-hour scalp could be scored a win because
its target was grazed 18 hours later. Given enough time almost any target is touched, which makes
a hit rate meaningless. Now replays only the bars inside `maxBars`.

**Bug 2 — phantom fills (the big one).** Entries are resting stop orders, but the resolver never
checked whether the entry was *reached*. A buy-stop sitting above price that never filled still
recorded a **loss** when price drifted down to the (lower) stop level — a trade nobody was ever in.
This manufactured losses systematically. Resolution is now two-phase: the entry must fill first,
then target-vs-stop is measured from the fill bar. Signals that never trigger are marked
`no-fill` and excluded from hit rates entirely (fill rate is now reported separately: 94.7%).

**Impact:** measured hit rate went from 23.6% to **34.6%** on identical trades — the difference was
purely phantom losses. All 293 prior outcomes were reopened and re-scored honestly (ledger schema v3).

**Grade inversion, confirmed real.** With clean data the grades were still backwards: A 27.8%
(144 trades) < B 48.1% < C 53.8%. Cause: every trend factor rewards momentum, so a "perfect"
score described a maximally extended move — the exhaustion bar. Fixes: clamp confluence to 100
*before* penalties (a 106-point setup was absorbing deductions and still grading A), add a
**chasing penalty** scaled on distance from EMA9 in ATR, and trim volume-surge from 14 to 10
(a surge at extension is climax, not confirmation). Unit-tested: a coiled entry now grades A while
a 4×ATR-extended one grades C, and mean-reversion setups are untouched.

**Momentum Breakout** (15.6% over 32) now requires the break to occur within 2×ATR of EMA9 — it was
firing on vertical moves that had already travelled.

## 2026-08-16 — No model changes (deliberately); added market breadth

**Held off on purpose.** Only **13 trades** have resolved since yesterday's changes (per strategy:
4, 6, 2, 1). Every actionable finding today — the grade inversion, Momentum Breakout at 15.8%, the
15-minute desk at 20% vs 40% for 5-minute — rests on pre-change data that yesterday's fixes were
built to address. Changing the same knobs again would confound attribution and over-fit to stale
evidence. Current standings for the next pass to judge: overall 36.2% (232 resolved), EMA Pullback
46.1%, grade A 30.9% / B 48.1% / C 53.8%.

**New variable — market breadth.** The picks model scored every symbol in isolation with no notion
of participation: a long when 15 of 21 markets are trending is a different trade from the same long
when only 3 are. `computeBreadth()` now measures the share of each asset class above its own 50-day
average and feeds Position Picks (±10 for a broad advance/decline, ±5 for healthy/narrow). Chosen
deliberately because it touches picks and *not* the scalp desks, keeping yesterday's scalp changes
cleanly measurable. Live: 64% of Nasdaq names ("healthy"), 86% of commodities ("broad advance").

Verified: node --check, all endpoints 200 with valid payloads, every tab renders, zero console errors.

## 2026-08-17 — Fixed the data pipeline that was starving the whole system

**The finding that mattered.** Two consecutive passes couldn't act for lack of resolved data, and
today revealed why: the scanners were **demand-driven**. `getScalpTf()` only ran when a browser hit
`/api/scalp`, so with nobody watching, nothing was scanned and nothing was recorded. Measured: the
server had been up 21h52m with **zero signals recorded in the preceding 12 hours**, and signal
timestamps clustered exactly around the moments I had been making requests. The self-improvement
loop can only learn from evidence it collects, and it was collecting almost none.

**Added a scanner heartbeat** — the 5m desk scans every 5 minutes, the 15m desk every 15, picks
every 30, independent of any browser. Recording already dedupes per setup, so this adds rows, not
noise. Confirmed recording autonomously within seconds of boot.

**Fixed the auto-tuner's memory.** `reliabilityAdj` was reading a strategy's *entire* history, so it
judged EMA Pullback on its blended lifetime 46% rather than the 75% it has run since the 15 Aug
fixes — and the longer the ledger grows, the harder it becomes for any genuine improvement to move
the number. It now uses a rolling window of the most recent 50 resolved trades per strategy.
Measured effect: EMA Pullback's adjustment moves from 0 to +2 (lifetime 50.7% → recent 56.0%), while
Momentum Breakout correctly stays pinned at the −8 floor (19.4%, all trades inside the window).

**Fixed a side effect of the heartbeat.** With scans now running unattended, a closed equity market
sent 6 symbols to Yahoo every 5 minutes and kept its circuit breaker permanently tripped. Stocks now
short-circuit when `usMarketOpen()` is false instead of falling through to Yahoo.

**No model changes — deliberately.** Post-15 Aug evidence is encouraging (45.2% vs 34.5% before;
EMA Pullback 75% over 16; grade A up to 48.3% from 30.7%, so the grade inversion looks corrected)
but no *strategy* has 20+ post-change resolutions yet (best is EMA Pullback at 16), and grades B/C
have 1 apiece — not enough to confirm the band ordering. Skipped the new-variable step too: three
structural changes already landed today and a fourth would confound attribution.

Verified: node --check, all 9 endpoints 200 with valid payloads, all tabs render, zero JS errors.

## 2026-08-18 — The 15 Aug fixes are validated; added crowd positioning

**First pass where the evidence is conclusive.** Segmenting the ledger at the 15 Aug fixes:

| | pre-fix | post-fix |
|---|---|---|
| 5-minute desk | 37.8% (164) | **55.9% (34)** ← 20+, actionable |
| EMA Pullback | — | **70.8% (24)** ← 20+, actionable |
| Grade A | 27.8% | **52.4% (42)** |
| 15-minute desk | 20.5% (39) | 27.3% (11) — below threshold |

The grade inversion is gone (A was the *worst* band at 27.8%, now the best at 52.4%) and the
5-minute desk has crossed from losing to genuinely positive. Both clear the 20-trade bar, so this
is measured, not hoped for.

**No model changes — nothing qualifies.** The rule is to tighten a strategy under ~45% with 20+
resolutions; post-fix, nothing meets it. Momentum Breakout improved to 38.5% but has only 13
resolutions; the 15-minute desk is the real weak spot (27.3%) but has 11. VWAP Bounce is the worst
on lifetime numbers (5.6%) and sits two trades short of the 20 threshold — first in line next pass.

**Noted for next time:** the grade distribution has become concentrated — 64 A vs 8 B vs 4 C
post-fix. A grade applied to 84% of signals carries little information even when its hit rate is
good. Can't act yet (B and C have 1 and 2 resolutions), but if it holds, the bands need respacing.

**Verified the resolver isn't silently dropping work:** all 57 open signals are inside their own
horizon (picks 10d, 5m 4h, 15m 8h) — zero stranded.

**New variable — crowd positioning (Options Desk).** Funding says what leverage costs; it says
nothing about who is holding the bag. `getPositioning()` pulls Binance global long/short account
ratio alongside the *top-trader* ratio, and scores the divergence — retail piled long while the top
cohort is not means retail is the exit liquidity. Live on first run: BTC 61% long with top traders
aligned (1.62 vs 1.58) → no factor fired, correctly no edge. ETH **70.1% long while top traders sit
at 1.74 vs the crowd's 2.34** → both contrarian factors fired, pushing ETH to BEARISH. Deliberately
scoped to the Options Desk so the scalp desks stay clean for attribution.

**Caveat on the heartbeat:** it only records while the server is alive, and the server is tied to
the preview session — recording shows two bursts (17 Aug 11:00, 18 Aug 05:00) with an 18-hour gap.
Continuous accumulation needs the app left running.

Verified: node --check, 9 endpoints 200, all tabs render, zero JS errors.

## 2026-08-19 — First evidence-driven model changes: VWAP Bounce and the 15-minute desk

Two findings crossed the 20-trade bar, so both were acted on.

**VWAP Bounce — 7.1% over 28 resolved, and identical pre- and post-fix (14 each).** A rate that
stable across two model versions is a defect, not noise or stale data. Cause: the trigger only
asked whether price *touched* VWAP, never whether VWAP was *defended*. In an uptrend, price falling
all the way back to VWAP means momentum has already stalled — with no evidence of active buying,
the setup was systematically buying failing trends. Now requires a genuine rejection wick (≥35% of
the candle range), a close in the top 40% of the bar, and intact trend structure (price still above
EMA9); mirrored for shorts. Effect on the first live scan: **zero VWAP Bounce setups fired on either
desk**, where it had been one of the most frequent. Kept rather than deleted so it can prove itself
on the stricter definition.

**The 15-minute desk — 13.6% post-fix over 22, against 46.6% for the 5-minute desk.** The auto-tuner
could barely see this: it judges per strategy within a timeframe, and **20 of the desk's 61 resolved
trades came from strategies below the 20-trade threshold** (Momentum Breakout 11, VWAP Bounce 8,
Reversal Bar 1) — invisible. Added a **desk-level fallback**: when a strategy lacks its own sample,
it is judged on the timeframe's record instead, bounded to ±5 rather than ±8 since it is a coarser
signal. Verified: those three now carry −5 from the desk's 16% rate, 15m EMA Pullback keeps its own
−7 (41 trades), and the healthy 5-minute desk is barely touched at −1. It fades automatically if the
timeframe recovers.

**Not touched:** EMA Pullback at 48.4% post-fix over 64 (above the 45% line), and Momentum Breakout,
whose lifetime 20.5% is dominated by pre-fix behaviour — post-fix it is 38.5% over 13, improving and
below the threshold. No new variable this pass: two model changes already landed and a third input
would confound attribution.

Verified: node --check, 8 endpoints 200, all tabs render, zero JS errors.

## 2026-08-20 — Built a backfill; it exposed that the grading is noise

**The blocker, solved.** Four passes have now been constrained by too few resolved trades, because
the live ledger only records while the server is running and the server dies with the session. Today
confirmed it starkly: **zero signals recorded since yesterday's changes** — on any strategy. So
yesterday's "VWAP Bounce fired zero times" was *not* evidence of over-tightening; nothing fired at
all. Added `backfillScalp()`, which replays real historical candles bar by bar, asking at each step
"would a setup have fired, and what did price do next?", using the same fill-then-target-vs-stop
logic as the live resolver. It produced **2,372 decided outcomes in seconds — 7× the entire live
ledger**. It writes nothing to the ledger: these are simulated fills, and letting the auto-tuner
learn from a simulation would be self-deception. Timing and track-record adjustments are skipped
during replay since both depend on "now".

**Corrected a measurement misreading of my own.** Resolution scores against **T1, which is 1:1**
(entry + 1× risk), not the advertised 2:1 (that is T2). So breakeven is 50%, not 33%. On that basis
the headline numbers read very differently: EMA Pullback at 43.5% is **−0.13R and genuinely losing**,
not "marginal".

**The grading carries no information.** Across 2,020 backfilled EMA Pullback trades, the confluence
score bands were flat: 70–80 → 42.8%, 80–90 → 43.7%, 90–101 → 43.3%. The entire A/B/C apparatus is
noise for this strategy. But two conditions *do* discriminate, cleanly:
- **Relative volume, monotonic:** 41.3% (RVOL<0.8) → 44.1% → 47.0% → 48.0% (RVOL>1.8)
- **ADX dead zones at both ends:** 37.5% below 15 (no trend) and 40.8% above 30 (trend already spent),
  versus ~46–47% in the 15–30 band.

**Acted on it, and tested before shipping.** Gated EMA Pullback on RVOL ≥ 1.0 and ADX 15–32, then
re-ran the identical replay:

| | baseline | gated |
|---|---|---|
| Overall | 44.2% / −0.116R | **48.8% / −0.024R** |
| EMA Pullback | 43.5% (2020) | **47.1%** (463) |
| Momentum Breakout | 51.2% (260) | **53.3%** (321) |
| VWAP Bounce | 12 trades | **51.3%** (39) |

Signal count fell 61%, and the survivors are better. Two knock-on effects worth noting: Momentum
Breakout and VWAP Bounce both *gained* trades, because they were previously being outranked by
low-quality EMA Pullbacks — and yesterday's VWAP Bounce tightening now shows 51.3% over 39, its
first evidence of working.

**Caveat, stated plainly:** the RVOL and ADX thresholds were chosen by inspecting this dataset and
then tested on it. That is in-sample, so the improvement is optimistic. The live ledger provides the
out-of-sample check over the coming days. For that reason I stopped at one gate rather than stacking
further filters onto the same evidence.

**Also found:** higher-timeframe alignment is *inverted* — fading the 15-minute trend won 61–68%
(n=201) while trading with it won ~41% (n=1,819). Consistent and large, but the counter-trend arm is
one regime and 201 trades, so it is recorded for a future pass rather than acted on.

Verified: node --check, 8 endpoints 200, all tabs render, zero JS errors.

## 2026-08-21 — The app was measuring the wrong thing (twice), and never measuring its most common setup

**Coil Breakout had never been scored — not once.** Two-sided brackets were skipped at recording
time "because they have no single direction", so the setup that fires most often in live scans was
completely invisible. It is perfectly scoreable: whichever leg the market triggers first *is* the
trade. Brackets are now recorded with both legs and the resolver picks the one that filled. Taught
the backfill the same trick, which produced the first ever measurement: **26.7% over 210 trades**,
the worst strategy in the app.

**Hit rate was the wrong yardstick.** Strategies do not share a payoff — EMA Pullback targets 1R
while Coil Breakout targets ~1.8R — yet everything was being compared against a flat 50%. That
mattered in two places:
- **The auto-tuner was penalising profitable strategies.** `reliabilityAdj` scored every hit rate
  against 50%, so a 40% Coil Breakout (genuinely +0.2R) was marked down as failing. It now computes
  each strategy's real breakeven from the reward multiples stored on its own signals.
- **It inverted two of my conclusions.** Recomputing with payoff-aware expectancy, **VWAP Snap-back
  turns out to be the best strategy in the app (+0.30R at 44% — it targets 1.93R)** despite looking
  like the worst on raw hit rate, and Coil Breakout's true damage was −0.25R against a 35.5%
  breakeven.

**Acted on Coil Breakout, tested before shipping.** The feature split was unambiguous: breaking out
of a coil on no participation is a fakeout (20.2% at RVOL<0.8, n=124), and a "coil" inside an
already-extended trend is worse (13.2% at ADX>32, n=53); the healthy pocket was ADX 20–25 at 45.2%.
Gated on RVOL ≥ 0.8 and ADX 20–32, then re-ran the identical replay:

| | before | after |
|---|---|---|
| Coil Breakout | 26.7% / −0.248R (210) | **45.5% / +0.282R** (22) |
| **Portfolio expectancy** | **−0.106R** | **+0.007R** |

That is the whole system crossing into positive expectancy for the first time.

**Caught a bug I had just introduced.** The bracket resolver mutated the stored signal
(`s.entry = s.entryShort`) when the short leg filled, overwriting the recorded setup with whichever
leg happened to trigger and corrupting the ledger. Switched to locals; the one record it had already
damaged is voided rather than silently counted.

**Caveats, plainly:** both gates were derived from the same data they were tested on, so the
improvements are in-sample and optimistic — the live ledger is the out-of-sample check. Coil
Breakout's surviving sample is only 22 trades. And the gate cuts signal volume hard (setups 1271 →
1090), which slows live evidence further.

Verified: node --check, 8 endpoints 200, all tabs render, zero JS errors, bracket levels stored
distinctly.

## 2026-08-21 (pass 2) — The gates do not generalise; demoting a strategy the tuner was too polite to stop

**First real out-of-sample test.** The last two gates (EMA Pullback, Coil Breakout) were derived
from 5-minute data, so the 15-minute replay is genuinely held out. They do not transfer:

| | 5m (in-sample) | 15m (out-of-sample) |
|---|---|---|
| Portfolio expectancy | +0.007R | **−0.116R** (1,002 trades) |
| EMA Pullback | −0.049R | −0.119R |
| Momentum Breakout | +0.010R | −0.104R |
| Coil Breakout | +0.282R | −0.391R |
| VWAP Snap-back | +0.296R | **+0.117R** |

Only VWAP Snap-back is profitable on both timeframes. Everything else that looked fixed on 5-minute
data still loses on 15-minute. That is the honest verdict on in-sample tuning, and worth remembering
before trusting the next backfill-validated "improvement".

**Live ledger caught up, and agrees.** 102 signals resolved (369 → 471 decided). Overall rose to
44.4%, the 5-minute desk to 47.9%, EMA Pullback to 50.0% over 298 — and **the grade bands are
correctly ordered for the first time (A 45.2% > B 42.6% > C 41.2%)**. The 15-minute desk sits at
30.9% over 97, corroborating the replay from a completely independent source.

**The tuner was too gentle to matter.** The 15-minute EMA Pullback has measured **−0.38R over 55
live trades**, yet it was still surfacing as a grade-A setup: the ±8 adjustment band was calibrated
when the ledger held a few dozen rows, so it applied a −5 nudge to an 85-point score. Added an
**evidence penalty** that scales with expectancy once the sample is large enough to trust (n ≥ 40
and EV ≤ −0.15R), bounded at −30. Checked the impact against every strategy before shipping: it
demotes exactly one — 15-minute EMA Pullback, 85 → 50, out of the actionable band — while the
healthy 5-minute EMA Pullback (+0.081R over 243) is untouched and still grades A. It fades on its
own as expectancy recovers.

**Confirmed it did not gut the 15-minute desk:** that desk shows no setups right now for ordinary
market reasons ("uptrend intact — wait for a pullback", "chopping around VWAP"), not because
everything was demoted.

Verified: node --check, 8 endpoints 200, all tabs render, zero JS errors.

## 2026-08-21 (pass 3) — The self-tuner did the work by itself; and the backfill has been lying by omission

**No model changes — because none were needed.** Yesterday's evidence penalty is already doing the
job unprompted. VWAP Bounce has degraded to **21.1% over 71 live trades (-0.63R)**, and the tuner
now demotes it by -38 (-8 base, -30 evidence), taking an 85-point setup to 47 — out of the
actionable band entirely. The 15-minute EMA Pullback stays suppressed on the same mechanism.
Meanwhile the healthy strategies are untouched: 5-minute EMA Pullback (+0.09R over 263) still grades
A. That is the machinery correcting the app without hand-tuning, which is what it was built for.

Worth recording: **the 19 Aug VWAP Bounce tightening did not work.** Post-tightening it still runs
22.2% over 36. The strategy is now suppressed automatically rather than by another guess at its
trigger.

**Found a systematic bias in my own tooling.** The backfill only replays the 8 Binance symbols —
non-crypto markets have no deep intraday history to replay — and I have been generalising its
results to the whole 21-market desk. Splitting the live ledger by asset class shows how wrong that
is: all strategies together run 37.9% / -0.221R on crypto (285 trades) versus 51.0% / +0.039R on
non-crypto (247); EMA Pullback specifically is 43.5% / -0.135R on crypto against 58.7% / +0.172R
everywhere else. The same strategy loses on crypto and makes money on the rest. The backfill said
VWAP Bounce was fine after tightening; the live ledger, covering all markets, says it is not — and
the ledger is right. The backfill response now carries its scope and a note to trust the ledger on
conflict.

**Considered scoping the tuner by asset class, and rejected it.** The split is real, but running the
numbers first showed the cost: slicing by asset class drops the 15-minute EMA Pullback sample from
55 to 36, below the evidence-penalty threshold, which would un-suppress a strategy measured at
-0.50R. Better differentiation is not worth re-enabling a known loser. Revisit when the slices
themselves clear 40.

**New variable — crypto/equity correlation regime (Options Desk).** The desk reads crypto-native
flow but had no idea whether crypto is trading as its own asset or as a leveraged Nasdaq proxy.
getCorrelation() computes 30-session return correlation against QQQ from data the app already pulls,
aligning on calendar dates since equities skip weekends. Live: BTC r=0.36 (loosely coupled), ETH
r=0.15 (decoupled) — so right now crypto-native signals are the ones that matter, which the card
says explicitly. Scoped to the Options Desk to keep the scalp desks clean while the evidence penalty
is being evaluated.

Verified: node --check, 8 endpoints 200, Options Desk renders the new card, live requests all 200.

## 2026-08-21 (pass 4) — Undoing my own over-fit: the crypto gate never belonged on stocks

**The app had gated itself into silence.** A live scan produced **one setup across 21 markets**
(previously seven to eleven), and nothing was being blocked by score — so it was the trigger gates,
not the evidence penalty. That matters twice over: the user has almost nothing to trade, and the
ledger stops accumulating the evidence every other mechanism here depends on.

**The cause was my own extrapolation.** The RVOL and ADX gates were derived from the backfill, which
can only replay the 8 Binance symbols, and I applied them to all 21 markets. The live ledger shows
what that cost — ungated, 5-minute EMA Pullback ran:

| | pre-gate hit rate | expectancy |
|---|---|---|
| crypto | 48.5% (132) | −0.035R |
| **non-crypto** | **61.1% (131)** | **+0.219R** |

A filter built to rescue a near-breakeven crypto strategy was being imposed on stocks, metals and
commodities where the *ungated* strategy was already comfortably profitable. Scoped both gates
(EMA Pullback and Coil Breakout) to `kind === 'crypto'`. Signal volume immediately recovered: the
5-minute desk went 1 → 6 setups (2 crypto, 4 non-crypto), the 15-minute desk 0 → 2, and recording
resumed — 17 new signals captured, including the NVDA/MSFT/AMD/TSLA setups the gate had been
swallowing.

**No other model changes.** VWAP Bounce (22.4% over 76) and the 15-minute EMA Pullback remain
suppressed by the evidence penalty, which is working as intended and needed no help.

**Two corrections to my own record, both worth stating plainly:**
- *Dates.* I had been advancing the log date each pass from the "daily" framing without checking the
  clock. The system date is 21 August; the entries labelled 22 and 23 August were written the same
  day and are relabelled as passes 2 and 3. The ledger itself spans 14–21 August, so the
  date-segmented analyses remain valid — only the headings were wrong.
- *Backfill comparisons.* It always replays the **last** 1000 bars, so the window slides daily and
  results are not comparable across passes. Today's crypto EMA Pullback reads 55.2% against
  yesterday's 47.4% on the *same* code — that is a different sample, not an improvement.

Verified: node --check, 8 endpoints 200, live scan recording again, crypto still gated.

## 2026-09-08 — The grade has never carried any information, and nothing recorded enough to say why

Eighteen days of unattended scanning since the last pass. Resolved trades went 554 -> **1,246**,
which is finally enough to answer a question that has been open since 15 August.

**The score is decorative.** Across 1,202 resolved scalp trades the correlation between the
confluence score and winning is **+0.0007**. The buckets are flat — 60-69 hits 42.2%, 70-79 hits
41.2%, 80-89 hits 40.4%, 90-100 hits 46.6% — and the grade bands are inverted again over the last
400 resolved (A 40.3% < B 44.7% < C 49.3%). I checked whether this was a composition artefact and it
is not: the inversion survives holding both strategy and asset class fixed. EMA Pullback on
non-crypto goes A 48.1% / B 54.9% / C 54.7%; Momentum Breakout on crypto goes A 45.3% / B 50.0% /
C 50.0%. Grade A is not better than grade C. It never has been for long.

**Odder still, the setups the grader rejects do best.** Signals scoring under 60 hit 66.0% (n=50),
spread over six separate days rather than one lucky session. Within EMA Pullback alone: **66.7%
below 60 against 48.3% at 80+**. Most of that bucket is 5-minute EMA Pullback, which takes no
evidence penalty — so those setups got there through the *chasing penalty*, which implies extension
may be momentum rather than a warning. That is a real possibility, not a conclusion; n=30.

**Why this keeps happening: nothing was ever recorded about WHY a setup scored what it did.**
`gradeSetup()` builds a factor list, and the ledger threw it away. Every pass since 15 August could
see the grades were inverted and none could tell which of the eight weights caused it — so each
time I guessed at a weight, the inversion came back. That is the actual defect.

**Fixed the diagnosability, not the weights.** Every factor now carries a stable key, and each
recorded signal stores which factors fired plus how extended the entry was. A new
`factorAttribution()` on `/api/accuracy` compares the hit rate of signals where a factor fired
against those where it did not, and labels any negative-lift factor `ANTI-PREDICTIVE — weight is
wrong`. It refuses to report until 20+ resolved on each side. **I deliberately changed no weights
this pass** — guessing again, on the day I shipped the instrument that ends the guessing, would have
been the same mistake in a new coat.

**New variable — relative strength vs the sector benchmark, recorded but NOT scored.** A scalp long
on a stock lagging QQQ is a different trade from the same setup on the leader, and every symbol was
scored in isolation. `getRelStrength()` computes 5- and 20-session performance against QQQ from the
CNBC daily series. Verified live: NVDA leading (+5.54 pts), AMD leading (+2.22), AAPL in line
(−0.27), MSFT lagging (−3.05). It is attached to stock signals and surfaced on the setup card marked
*"Measured, not yet scored"* — attribution will set its weight from measured lift, which is the
whole point of today's change.

**Also measured, not yet acted on:** the picks desk is at 20.5% over 44, and its shorts are **0% over
16**. Under the 20-per-side bar for shorts alone; flagged for the next pass.

**Honest limits.** Stocks are absent from the desk right now — the US cash session is closed, which
the app reports correctly — so the RS badge is verified through its own code path and live data, but
has not been seen rendered in a live setup card. Attribution currently reports 0 samples by design;
it needs a few days of resolutions before it can say anything.

Verified: node --check, 8 endpoints 200, all tabs render, zero JS errors, new fields writing to the
ledger (`fk`, `ext`, `rs`).

## 2026-09-14 — The instrument paid off: the grader was paying a bonus for a warning sign

Last pass shipped factor instrumentation and deliberately changed no weights. Six days later it has
**189 resolved instrumented signals**, and it answered the question three previous passes could only
guess at.

**Volume surge was never confirmation — it was a warning sign being paid a bonus.** Setups where the
RVOL>=1.3 factor fired hit **29.1%**; those without it hit **49.1%**. A -20 point lift on the factor
the grader was awarding +10 for. I checked it the way the grade inversion taught me to: it survives
every control — crypto -33.4, non-crypto -15.5, and -26.0 within EMA Pullback alone — and it is not
composition (crypto share is 25% when it fires, 28% when it does not). **Weight removed.** It was
trimmed 14 -> 10 on 15 Aug on exactly this suspicion; measurement finished the job.

**MACD alignment halved, 8 -> 4.** Consistent in sign (-14.3 overall) but it attenuates under control
(crypto -24.9, non-crypto -10.4, EMA Pullback only -5.9) — enough to reduce, not to zero.

**Two factors the aggregate accused and the controls acquitted.** `rsiMom` showed -9.6 overall but
**+3.4 on non-crypto** — confounded, left alone. `trend` had only 16 samples on its not-fired side.
`adxStrong` measured +0.3, no effect. Untouched, all three. The whole point of the instrument is to
stop changing weights on evidence that does not survive being looked at properly.

**The uncomfortable finding: no reweighting fixes this grader.** I simulated five variants against
the instrumented signals before shipping anything. Correlation between score and winning goes from
-0.068 to -0.013 under the change above; the most aggressive variant reached +0.029. All of them are
zero. The factor set this grader has does not predict outcomes, and no amount of reweighting will
change that. So the app now **says so**: `/api/accuracy` publishes measured band hit rates with a
`discriminating: false` verdict, and every setup card carries a line telling the user to judge by
strategy and market rather than by the letter. Removing the harmful weights stops the grader steering
toward worse setups; it does not make the grade meaningful, and pretending otherwise would be worse
than the original bug.

**The picks desk had no feedback loop at all.** `reliabilityAdj` was wired only into the scalp path,
which is how a book running **-0.55R over 60 trades, including 22 consecutive losing shorts**, kept
surfacing at full conviction. Two fixes:

- **Picks never recorded their reward multiple** (0 of 285) despite every pick being built at exactly
  2:1 — so everything judged them against a 50% breakeven when the true figure is 33%. The same defect
  fixed for the scalp desks on 21 Aug, missed here because picks record on a separate path. Fixed, and
  backfilled onto all 285 historical picks (arithmetic on levels already stored, not invented data).
- **Wired picks into the auto-tuner, scoped by direction** — this desk runs one strategy, so
  per-strategy scoping told it nothing, while its longs (23.7% over 38) and shorts (0% over 22) are
  effectively different models and only one is broken.

**A record can be conclusive before it is large.** The evidence penalty required n>=40, which assumes
the doubt is sample size — but 0-for-22 under a 33% breakeven has probability ~0.0001. Added a second
trigger: fire when even the 95% Wilson upper bound sits below breakeven, i.e. the most optimistic
defensible reading still loses money. **Impact-checked against every strategy in the ledger before
shipping: it changes exactly one group** (picks shorts) and leaves every scalp adjustment identical.
Verified on the real code path by forcing shorts on a scratch copy — 9 would-be shorts demoted to
NEUTRAL, quoting "0% over 22 — conclusively below the 33% breakeven".

**Standings:** overall 42.6% (1,464 resolved). EMA Pullback 48.1% (792), Momentum Breakout 42.4%
(328), VWAP Bounce 34.4% (125), Coil Breakout 33.3% (90). 5m 44.9% / 15m 40.1% / picks 15.0%.

**Limits, stated plainly.** 189 instrumented samples is enough to act on a -20 lift that survives
three controls; it is not enough for the smaller effects, which is why four factors were left alone.
Relative strength is still accumulating and carries no weight. Both desks were empty at scan time
(crypto in "uptrend intact", US cash session closed), so the changes are verified through endpoints,
a forced-short scratch run and the ledger rather than a live populated board.

Verified: node --check, 8 endpoints 200, all 8 tabs render, zero JS errors, scratch copy removed.

## 2026-09-24 — My Bybit: a read-only account desk

New **💼 My Bybit** tab wired to the live account via Bybit's V5 API, signed with HMAC-SHA256 and no
new dependencies (Node's own `crypto`).

**Read-only by construction, not by promise.** Every call is a GET against a query endpoint;
`/v5/order/create` and friends are not implemented anywhere in the app, so there is no code path that
can open, close, amend or cancel a position. The app has been no-custody since the meme sniper and
copy bot, and this keeps that property.

**Shows:** equity, available balance and margin used; unrealised P&L; maintenance-margin ratio with a
plain-English risk read; per-coin balances; open positions with entry/mark/leverage, liquidation price
and — the number that actually matters on leverage — **distance to liquidation as a % of price**,
colour-graded; recent closed trades; and measured performance over the last 100 closes: hit rate,
profit factor, net P&L and **expectancy in R**. It applies the same 20-trade bar the rest of the app
uses on itself, and says "too few to draw conclusions from" below it rather than pretending a small
sample means something.

**Credential handling.** Key and secret live in `.env` (chmod 600, added to `.gitignore`), loaded once
into memory. They are never written into source, never logged, and never sent to the browser — audited
by grepping every endpoint's response for both values, and by confirming `.env` is not reachable over
HTTP (`/.env`, `/public/.env`, `/../.env` all 404). `/api/bybit/status` reports key *metadata* only:
a masked preview, permissions, bound IPs, expiry.

**Current state: Bybit rejects the key with `retCode 10010` — the key is bound to an IP allowlist that
does not include this machine.** Rather than fail opaquely, the desk maps Bybit's numeric codes to
plain-English fixes (10010 IP binding, 10003 wrong key/environment, 10004 signature/secret, 10005
missing permission, 33004 expired key) and shows the public IP that needs whitelisting. Same approach
as the Telegram `telegramHint()` work — a raw upstream code tells the user nothing about what to change.

**Therefore unverified until the IP is allowed:** the request signing and every render path that needs
real account data. What *is* verified: the endpoints return 200, the error path renders correctly, the
key never leaks, and all 12 tabs render with zero console errors.

**Security note recorded for the user:** the server binds `*:3456` with no authentication, so anyone on
the LAN can read these endpoints — acceptable for public market data, worth a decision now that account
data is behind them.

## 2026-09-25 — Paper execution desk, and why it is paper

New **📝 Paper Desk** tab: a simulated broker that routes orders against **live Bybit prices**.

**Why simulated rather than live.** The user asked for write access so the app could place real trades.
The app's own ledger argues against it — 1,666 resolved signals at 42.2%, with every strategy below the
breakeven its own payoff requires (EMA Pullback 47.7% over 899, Momentum Breakout 41.0% over 349, VWAP
Bounce 32.9% over 146, Coil Breakout 31.4% over 105, picks 24.1% over 79) and grading still measuring
`discriminating: false`. Connecting capital to that is not a risk, it is a measured expected loss. The
honest version of "give it write access" is an execution path that proves the edge first.

**Built for realism, because flattering paper results are worse than none.** Market orders pay the far
side of the real spread plus 2bp slippage; every fill is charged Bybit's 5.5bp taker fee. The first
smoke-test trade opened instantly at a small loss, which is exactly correct. Limit orders rest until
price touches them; stop-loss and take-profit are honoured on a tick. Average entry blends on adds and
realises P&L on reductions and flips.

**Reports what the rest of the app reports about itself:** hit rate, net P&L, fees paid, profit factor
and expectancy in R — with the same 20-trade bar and an explicit "below the bar" warning under it.

**Still no live-order path anywhere.** Verified by grep: zero call sites for `v5/order/create`,
`cancel`, `amend` or `position/set`. Execution routes only through `paperPlace`/`paperClose`. The
order ticket also requires an explicit confirm per order, so the habit matches what a live desk needs.

**Security finding recorded, not fixed.** `GET http://192.168.86.219:3456/api/bybit` returns 200 with
no credentials — the server binds `*:3456` with no authentication. Today that exposes account data on
the LAN. It is the blocking prerequisite for any live-order path, and the user chose paper first, so
auth remains open work.

Verified: node --check, 10 endpoints 200, all 13 tabs render, zero JS errors, order/close/limit-rest/
validation paths exercised end to end, book reset to a clean $10,000 afterwards.

## 2026-09-25 (later) — Trade suggestions, ranked by measured edge rather than by score

Added a **🎯 Trade suggestions** panel to the My Bybit tab. It scans both scalp desks, sizes each
candidate against the account's real equity, and ranks them.

**Ranked by measured track record, not by the confluence score.** The score has measured no predictive
power (correlation +0.0007 over 1,200+ resolved trades) and its grade bands do not separate winners
from losers, so ranking by it would be theatre. What does separate outcomes is the bucket a setup
belongs to — desk × strategy × asset class — and that is what orders the list. Each row shows its
bucket's hit rate, sample size, breakeven and expectancy in R.

**It is allowed to say "don't trade".** Measured across the whole ledger today, **not one bucket has
positive expectancy**: the best is 5-minute EMA Pullback on non-crypto at −0.005R over 396 trades,
then VWAP Snap-back non-crypto at −0.019R, and it falls away to −0.51R. So the panel leads with
"Nothing currently clears breakeven" and states plainly that the highest-expectancy action is to take
none of them, or to take them on the Paper Desk where being wrong is free. A suggestions panel that
cannot reach that conclusion is a losing signal wearing a recommendation badge.

**Account-aware sizing and portfolio flags.** Position size comes from real equity and a chosen
risk-per-trade (0.5–3%), verified: $99.97 equity at 1% gives qty 0.6665 on AMD with a 1.50 stop
distance — exactly $1.00 at risk. Rows carry warnings for adding to a symbol already held, for crypto
concentration (correlated positions make the real risk larger than one stop implies), for untested
buckets, and for buckets measured at −0.15R or worse.

**"Paper it" routes to the simulator, never to a live order.** The button places the suggestion —
with its stop and target — on the Paper Desk, and the confirmation dialog quotes the bucket's measured
edge so the decision is made against evidence rather than a grade letter. Verified again by grep: zero
call sites for `v5/order/create`, `cancel`, `amend` or `position/set`.

**Account is now funded** — equity $99.97 in the claude trading subaccount, so the desk and sizing are
running on real numbers.

Verified: node --check, 11 endpoints 200, 12 suggestion rows render with working Paper-it buttons, all
13 tabs render, zero JS errors.

## 2026-09-25 (later still) — 🤖 Agent Desk: an outside LLM framework, scored on our rules

Cloned TauricResearch/TradingAgents and gave it its own section, wired so it competes with the app's
own signal engine instead of sitting beside it as a curiosity.

**Made it a fair fight.** A bridge (`TradingAgents/bridge/to_ledger.py`) runs the framework and writes
its calls into this app's ledger as `kind: "llmdesk"`, where they are replayed against real candles by
the same resolver — entry must fill first, then target-vs-stop inside a bounded horizon. Crucially the
model does **not** get to pick its own levels: it returns a direction, and entry/stop/target come from
the symbol's 14-day ATR at a fixed 2:1, the same geometry the picks desk uses. That leaves the decision
itself as the only variable under test. `HOLD` records nothing rather than being quietly scored a win,
and the bridge is restricted to the 21 symbols the daily resolver can actually score.

**Head-to-head scoreboard** on `/api/accuracy` and at the top of the tab. Current standings, all on
identical rules:

| Desk | Trades | Hit | Breakeven | Expectancy |
|---|---|---|---|---|
| 5-min scalps | 1,142 | 44.1% | 47.3% | −0.067R |
| 15-min scalps | 472 | 39.0% | 47.2% | −0.175R |
| Position Picks | 79 | 24.1% | 33.3% | −0.278R |
| TradingAgents | — | — | — | *no calls yet* |

**Runnable from the UI, with the costs stated.** Symbol picker, dry-run toggle (default on), live output
streamed while it runs, and each recorded call expandable to the reasoning that produced it. The panel
says plainly that every symbol is a dozen-plus LLM calls on the user's own key and takes minutes.

**Security of the shell-out.** The run endpoint uses `execFile` with an **argument array — never a shell
string** — and symbols are checked against a hard allowlist before they are passed. Verified: a payload
of `"; rm -rf /"` is rejected with "No valid symbols". One run at a time.

**Placeholder keys are treated as absent.** The shipped `.env.example` values look real enough to pass a
naive truthiness test and then 401 at runtime, so `agentsReady()` rejects anything matching `your_…`,
`…here`, `sk-xxx`. Right now that is exactly the state: `ANTHROPIC_API_KEY` in `~/Ai agent/.env` is still
the literal placeholder, so the Run button is correctly disabled with an explanation rather than failing
mid-debate.

**Still no execution path.** The framework was checked on clone for exchange code (no ccxt, no broker
client, no `place_order`, no shell-outs) and this wrapper adds none. Verified again: zero call sites for
`v5/order/create`, `cancel`, `amend` or `position/set`.

**Environment:** system Python was 3.9.6 against a `>=3.10` requirement, so 3.12.13 was installed via
`uv` into an isolated venv — no system Python touched.

Verified: node --check, 11 endpoints 200, all 14 tabs render, zero JS errors, injection and
missing-key guards both exercised.

## 2026-09-25 (self-improvement) — The factors are not stable, so the grader was never fixable

**First, the 14 Sep change is confirmed — and confirmed for the wrong reason.** Out-of-sample, the
score-vs-outcome correlation moved from **−0.0682 to −0.0138**, almost exactly the −0.013 the
pre-ship simulation predicted. The simulation method is sound. The *reasoning* behind the change was
not: volSurge was removed because it measured a −20.0 lift, and in the period that followed it
measured **+6.3**.

**So I tested every factor for stability, and this is the finding of the pass.** Splitting the 407
instrumented signals into three chronological periods and asking whether each factor keeps its sign:

| Factor | P1 | P2 | P3 | |
|---|---|---|---|---|
| `adxStrong` | +8.6 | −18.1 | +15.7 | flips twice |
| `volSurge` | −15.6 | −12.6 | **+13.8** | flips |
| `macd` | −14.4 | −11.0 | **+3.7** | flips |
| `trend` | −15.1 | −11.6 | **+1.1** | flips |
| `rsiMom` | −5.3 | −8.1 | **+5.6** | flips |
| `rr` | −34.9 | — | −4.6 | **only stable factor** |

**One factor out of ten holds its sign.** That reframes every weight-tuning pass this project has run:
the lifts being tuned on are single samples of a noisy quantity. It has now bitten twice — the
RVOL/ADX gates in August (good on 5m, −0.116R out-of-sample on 15m) and volSurge this month.

**Institutionalised the guard rather than tuning again.** `factorStability()` on `/api/accuracy` runs
this three-period test and labels anything that flips as *"no weight change is justified by a fresh
reading"*. The rule is stated in the payload so a future pass has to argue with it before over-fitting
a third time. No weights were changed this pass — retrospectively, volSurge at 0 is the right weight
for an unstable factor regardless of my original reasoning, because you cannot predict which sign it
will show next.

**Acted on the structural consequence instead.** If no factor is stable, the confluence score cannot
rank setups — which is what its ~0 correlation has been saying all along. Both scalp desks now rank by
**measured bucket edge** (desk × strategy × asset class), the only ranking input in this app that has
survived out-of-sample checking, and every scanner row carries its expectancy badge beside the now-
demoted grade pill. Live: EMA Pullback setups display −0.013R, and the list orders by that rather than
by volatility × volume.

**Standings:** 1,701 resolved, 41.6% overall. EMA Pullback 46.6% (924), Momentum Breakout 41.1% (350),
VWAP Bounce 33.3% (147), Coil Breakout 31.2% (109), VWAP Snap-back 25.4% (59), picks 24.1% (79).
Grade bands still inverted (A 42.4% < C 47.5%), which is now explained rather than merely observed.

Verified: node --check, 11 endpoints 200, all 14 tabs render, zero JS errors, edge badges rendering.

## 2026-09-30 — Agent desk merged into My Bybit; a deep 5-min pass finds every figure was pre-cost

### Merge: the AI agent desk now lives inside My Bybit
The standalone 🤖 Agent Desk tab is retired (14 → 13 tabs) and its scoreboard, runner and call log sit in
My Bybit beneath the trade suggestions. They talk to each other rather than sitting side by side: every
suggestion row has an **AI agent** column showing the desk's latest call on that symbol and whether it
agrees. That column is marked context, not confirmation — a daily LLM call and a 5m setup are different
horizons, so agreement is deliberately *not* blended into the ranking.

Made it cover what the Bybit account actually trades: the agent universe gains the 8 crypto symbols, the
bridge runs them through the framework's crypto pipeline (`asset_type="crypto"`), and the daily resolver
now scores crypto from Binance dailies. CNBC carries no crypto, so a crypto call would otherwise have
sat "open" forever. The resolver change touches only res='1d' crypto signals, of which none existed.

**Caught a bug in my own bridge before it ever ran.** `propagate()` returns a 5-tier rating (Buy /
Overweight / Hold / Underweight / Sell / REVIEW), but the parser searched for BUY/SELL/HOLD substrings —
so every **Overweight and Underweight would have been silently recorded as HOLD and dropped**, though the
framework defines Overweight as a Buy. Rewritten to map the canonical scale; REVIEW and unparseable output
are skipped rather than scored; the rationale now comes from `final_trade_decision` rather than the bare
rating string. All 8 mapping cases and crypto/stock ATR levels (exactly 2.00R) verified.

### Deep 5-min pass
**The stability test prevented two mistakes.** The aggregate table's best hour (12 UTC, +0.108R) and best
symbol (TSLA, +0.215R) both **flip negative in the latest period** — acting on either would have been the
August/September over-fit a third time. Only two candidates held across three periods: PLAT (positive but
decaying +0.540 → +0.103 → +0.029, not actioned) and Momentum Breakout SHORT.

**Momentum Breakout SHORT disabled on 5m.** 29.1% over 103, −0.417R, negative in every period (−0.699 /
−0.064 / −0.722), on crypto (−0.600R) and non-crypto (−0.324R) alike, across 18 symbols. The long side
of the same trigger runs 49.5% / −0.011R, so it is the direction, not the pattern. The tuner had only
been suppressing it incidentally, by averaging it with the long side. Scoping the tuner by direction was
**impact-checked and rejected**: it would have loosened two known losers on the 15m desk. Stated
trade-off: disabling stops it being measured; re-enabling is one condition. 15m left alone.

**Exits are not the problem — entries are.** Replayed all 467 live crypto 5m signals against real Binance
candles (97.6% agreement with the ledger's recorded outcomes, so the replay is calibrated). No target from
0.4R to 2R is profitable. Against a no-edge random entry, which reaches +T before −1R with probability
1/(1+T), the observed hit rate sits **below random at every target**: −2.3 points at 0.25R, widening to
−10.7 at 3R. The entries carry no directional edge. The 1R target was left unchanged, since the in-sample
"optimum" of 0.4R still loses and is over-fit by construction.

### The finding of the pass: every expectancy in this app was scored cost-free
5m stops sit a median **0.217%** from entry, and a Bybit round trip (taker fee ×2 + ~2bp slippage ×2)
costs **0.15%**. That makes costs a median **0.69R** per trade, mean 0.96R.

| Desk | Gross | Costs | **Net** |
|---|---|---|---|
| 5-min scalps | −0.067R | 0.964R | **−1.031R** |
| 15-min scalps | −0.179R | 0.564R | **−0.743R** |
| Position Picks | −0.278R | 0.024R | **−0.302R** |

Costs were **14× the loss the desk was reporting**, and they reverse the ranking: 5-min looked best gross
and is worst net, because picks' wide daily stops make costs negligible. Only **6.7%** of 5m trades had
costs under 0.25R, and **30.6%** had costs above 1R — no win rate breaks even there, since every win still
loses after fees. Holding costs to 0.25R needs a **0.60%** stop, nearly 3× today's median.

This is a measurement fix of the same class as the phantom-fill bug. `tradeCostR()` uses the Paper Desk's
existing fee model. `bucketEdge` and `deskComparison` now report `costR` and `netEvR` beside the gross
figure. Every live setup carries its own `costR`, a net breakeven, and a warning that says in words when
costs exceed the whole reward (instead of printing "171%"). Suggestions rank by net expectancy. Gross is
kept because it measures the signal; net measures whether the signal can be traded.

**Not shipped, deliberately: a minimum-stop rule.** The arithmetic says 5m stops are too tight for retail
taker costs, but widening them changes what the strategy *is*. That's a design decision for the user:
maker/limit execution, a 0.6% minimum stop, or moving capital to longer timeframes.

**Found, not caused:** `/api/crypto` returns 502 because CoinGecko answers **403 even to a direct
request** from the current (mobile-network) IP. The crypto code is byte-identical to the pre-pass backup.
Flagged as a separate task.

Verified: node --check, 12 of 13 endpoints 200 (crypto: upstream 403), all 13 tabs render, zero JS
errors, net badges and "After costs" column rendering, 0 live-order call sites, 1 listener on :3456.

## 2026-09-30 (later) — 5-minute scalps move to limit orders, and what that does and doesn't buy

**User decision:** execute 5m scalps with limit orders, the first of the three options offered after the
cost finding.

**Why this isn't just a fee constant.** 5m entries were **stop orders** (buy above the trigger candle),
which can only fill as taker; a buy limit above the market fills instantly as taker. Earning maker fees
means **resting on the passive side**, so the entry becomes a pullback. That changes which trades get taken
and could introduce adverse selection, so it was measured before building.

**Measured** on 467 live crypto 5m signals replayed against real Binance candles, with only the entry leg
differing:

| Entry | Fill | Win | Gross | Cost | Net / trade | Net / signal |
|---|---|---|---|---|---|---|
| Stop order (previous) | 100% | 44.1% | −0.102R | 0.670R | −0.772R | −0.772R |
| Limit, old "better fill" (same absolute stop) | 89% | 27.8% | +0.347R | 1.404R | −1.057R | −0.937R |
| **Limit, stop moves with entry** | 37% | 44.9% | −0.098R | 0.398R | **−0.496R** | **−0.182R** |

- **The app's existing "better fill" design is the wrong way to use limits.** It keeps the absolute stop,
  which shrinks the stop distance to about a third and doubles cost-in-R. Rejected.
- **The keep-distance limit wins in all three chronological periods and on both sides** (long −0.628 →
  −0.136, short −0.933 → −0.232R per signal). Robust to the resting window (3/6/12 bars agree).

**A correction I owe, found before shipping.** My first run of this simulation claimed *no lookahead* and
reported limit entries **raising the win rate to 51.4% with positive gross**. That was wrong. It read the
candle that was still forming at signal time using that candle's *final* OHLC, up to five minutes of
future data. With only genuinely closed candles, the win rate is **44.9%, the same as stop entries**, and
gross stays negative. The honest description of the gain:

- **It is the fee saving,** ~0.27R per trade: maker entry, no entry slippage, maker take-profit. Net per
  trade improves 0.28R, almost exactly the cost removed.
- **Entry timing adds nothing.** Pullback entries do not pick better trades.
- **Much of the per-signal improvement is trading less.** Limits fill on 37% of signals, and when every trade
  loses on average, fewer trades lose less. That is not a better strategy.
- **Still net negative.** This makes a losing desk lose less. It does not make it profitable.

**Built across six places, each verified:**
1. **Geometry (5m only):** long limit at max(mid-body, EMA9) of the **last closed candle**, since Binance's final
   bar is still forming and reading it is exactly the lookahead the measurement removed. Stop keeps the
   original distance, 1R target, 6-bar (30 min) window. If price is already through the level there is no
   passive order to rest, so the setup stands aside rather than pay taker — the measured policy. Two-sided
   Coil Breakout brackets stay stop orders. 15m unchanged.
2. **Entry plan** rebuilt after conversion, since it was built before and still said "buy stop". It now reads
   "Buy limit (pullback order, maker)" with the resting instructions and the stop order it replaced.
3. **Ledger:** signals record `exec` and `fillWindowBars`. The resolver fills limits on the **passive side, only
   inside their window**. It had assumed every entry was a stop order and would have mis-scored every one.
4. **Backfill:** same fill rule. Verified end to end on history: 514 setups, 152 limits never filled
   (now no-trade, not losses), brackets 0 no-fills.
5. **Cost model is now per-leg:** limit entry and limit take-profit are maker with no slippage; stop entries
   and stop-outs pay taker plus slippage. Breakeven uses the asymmetric legs, h = (1+cl)/(2−cw+cl), and
   "impossible" means breakeven > 100% rather than average cost ≥ 1R. **This re-prices history.** The 5m
   net moves −1.031R → −0.871R because take-profits are now modelled as limit orders; same trades, more
   accurate pricing, not a strategy gain.
6. **Paper Desk:** maker fee on resting limits and take-profits, taker plus slippage on stop-outs. "Paper it"
   now places a resting limit that **expires after 30 minutes** instead of a market order. **Fixed:** a limit
   priced through the book (e.g. a buy above the ask) had been resting and earning maker. An exchange fills
   that instantly as taker, so it now does too — otherwise the paper desk would hand out the fee saving
   exactly where it isn't earned.

**What limit orders can't fix:** a tiny stop. A live AAPL setup had costs of 2.0R *at maker fees*. Cheaper
fills don't rescue a stop a few cents wide. That remains the open design question, for a minimum stop
distance or longer timeframes.

Verified: node --check; geometry correct on live setups (limit below price for longs, exactly 1.00R);
3 setups correctly stood aside; 0 limit orders on 15m; Paper Desk market / marketable-limit / resting /
expiry paths exercised (the maker-fill path is verified by code, since price can't be made to walk to a
level on demand); 11 endpoints 200 (crypto: known CoinGecko 403); all 13 tabs render; zero JS errors;
0 live-order call sites.

## 2026-09-30 (later still) — 🐋 Smart Wallets: Axiom-style wallet tracking, built from the chain

**The ask:** track the best-performing wallets on Axiom (axiom.trade) across its chains, and list what they trade.

**Why this isn't Axiom's own data.** Axiom sits behind a Cloudflare bot challenge — every page, its terms
included, returns 403 to anything but a real browser — and publishes no API (its docs and third-party
guides agree). The only programmatic routes are unofficial SDKs that drive a *logged-in account*: outside
its terms, and they would mean handling the user's Axiom credentials. Mobula, which markets itself as the way
to get "Axiom data", needs a key and supplies its own data. None were used, and the bot challenge was not
worked around. What Axiom displays is public on-chain trading, so this reads the same public trades.

**Source.** GeckoTerminal's keyless API exposes each pool's trades *with the trader's wallet*, and covers all
eight of Axiom's chains (Solana, Base, BNB, Ethereum, HyperEVM, Ink, Arc, Robinhood). Hyperliquid perps come
from the existing public leaderboard plus `clearinghouseState` for live positions.

**Measured before designing — several naive versions would have been wrong:**
- **300 raw trades cover ~10 minutes** of a busy pool; nothing can be judged from that. Filtering to larger
  trades (≥$2k on a $12M/day pool) stretched the window to **~22 hours**. The threshold now scales with pool
  volume (volume/6000, clamped $100–$2k).
- **Ranking by total P&L put 21 single-coin wallets in the top 25,** led by one with **$0 realised and $9,469
  of paper gains** on the day's hottest coin — that measures who held the pump, not who can trade. Now ranked by
  **realised P&L** (profit locked in by closing), with open paper gains in their own labelled list and a
  "consistent" badge for wallets profitable on 2+ coins.
- **Only-sold wallets have no known cost basis** (they bought before the window) and are left out of P&L
  rather than counted as pure profit — the usual way these leaderboards inflate.
- **The "consistent" wallet was an arbitrage bot.** On-chain: 63–75% of its transactions failed, and every
  successful one bought and sold inside a single transaction. It passed my first bot filter because that
  checked same-block buy+sell **per pool**; arbitrage buys on one pool and sells on another. Fixes: the
  same-block test now spans all pools (0 → 3 bots caught), and Solana leaders get an on-chain check of their
  failed-transaction rate (≥50% over 10+ txs = spray bot, removed). After both, it's off the leaderboard and
  every ranked wallet shows a 0–20% failure rate.
- **"Coins they're buying" ranked by headcount told the opposite story.** PARASITE led with 9 buyers vs 5
  sellers — at a net flow of **−$54,926**: the leaders were taking profit. Now ranked by net money flow with an
  explicit stance (accumulating / taking profit). The real accumulation was SI, +$24,536 with no sellers.

**Built:** a 🐋 Smart Wallets tab with chain buttons for all eight chains plus Hyperliquid perps; where the top
wallets' money is going; the best-performing wallets with locked-in vs paper P&L, volume, coins won, and
what each is trading (accumulating / trimming / round-trip / selling, with per-coin P&L); the biggest paper
gains listed separately; and a **watchlist** for wallets found on Axiom. Solana watchlist wallets get
their recent buys and sells read on-chain, plus explicit sniping-bot and arbitrage warnings; for EVM wallets it
shows what the scan saw them do, with an explorer link.

**Infrastructure: a shared GeckoTerminal pacer.** The free tier allows ~30 req/min, and that budget is shared with
the Meme Sniper — probing it tripped a 429. Every GeckoTerminal call now goes through one queue in `fetchJson`
spaced ≥2.2s apart (~27/min), with a 15s back-off on 429 instead of the curl fallback that would hit the same
limit. This protects the Meme Sniper too.

**Also fixed along the way:** empty watchlist results that were hiding failures. It now reads 40 transactions
rather than ~10, and unreadable transactions are counted and reported instead of silently skipped.

**Limits, stated plainly:** a ~22-hour snapshot on each chain's six trending pools, not a long-term track record;
on-chain bot verification is Solana-only (EVM chains have no keyless per-wallet transaction list); a fresh
scan takes ~30–60 s under the rate limit, then is cached for 10 minutes.

Verified live: Solana (1,771 trades, 959 wallets, 23h), Base (1,736 trades, 684 wallets, 24h), Hyperliquid perps
(15 traders, $14–18M 30-day P&L, live positions); watchlist validation rejects duplicates, wrong-chain
addresses, garbage and injection; 14 tabs render, zero JS errors, 11 of 12 endpoints 200 (crypto: known
CoinGecko 403). Test wallet removed afterwards.

## 2026-09-30 (evening) — "Is it going up or down?" on the 5-min desk: a live read, and what the evidence allows it to say

**The ask:** analyse real-time market quick events and show on the 5-min scalps whether each market is going up or down.

**Measured before building.** A live up/down arrow is a forecast, and this desk's entries already sit
below a coin flip, so I tested every real-time signal the app can compute against the NEXT 5-minute bar.
The test used 7,739 closed crypto bars, with Binance's taker-buy volume giving real order flow historically:

| Signal from the last closed 5-min bar | Called the next bar |
|---|---|
| Price momentum, last bar | 49.2% |
| Price momentum, last 15 min | 49.0% |
| Order flow, taker buys >55% / <45% | 48.7% |
| Strong order flow, >62% / <38% | 49.1% |
| Momentum and order flow agree | 48.2% |

**A coin flip across the board, stable in all three periods.** Up/down arrows built on these would be wrong
as often as right. The one outlier: after a **spike** (2× volume and 2× range), the next bar reversed
**56.2% of 249**. That is borderline (z = 1.96) and holds on only 5 of 8 coins — BTC continued 55% of the
time — so it's shown as a weak lean, never a signal. It wouldn't survive 5m trading costs anyway.

**So the display is descriptive, and says so.** Each open 5m market gets a **Now** column: rising / falling /
flat over ~15 minutes, scaled to that market's own normal range so the words carry the same weight on BTC
as on copper. It also flags a market that is **turning** (current bar against the last 15 minutes) and,
for crypto, the live **% of aggressive buying**. A **⚡ Live now** panel above the scanner shows market
breadth, a quick-events feed (spikes, projected volume surges, one-sided order flow, turns), and the
economic calendar, with an event-risk warning inside ±30 min of a high-impact release. Every event carries
its measured odds underneath it.

**The accuracy figures stay live.** `directionStats()` re-runs the whole test on the latest crypto bars every
30 minutes and the panel headline quotes it ("recent momentum called the next 5 minutes 49.2% of the time"),
so the caveat can never go stale or quietly become a claim.

**Plumbing:** crypto scan candles now carry taker-buy volume (`tb`, Binance kline field 9); `liveRead()`
attaches to 5m items only; the 15m desk is unchanged (verified: no Now column there).

Verified live: breadth 1 rising / 14 falling of 15 open markets; NATGAS rising with a spike event (5.3× volume);
SOL and ETH showing one-sided selling (15%, 18% buys); next high-impact release US Core PCE; 11 endpoints 200;
14 tabs render; zero JS errors.

## 2026-09-30 (night) — 🤖 Auto Scalper: a complete autonomous 24/7 bot, on paper

**The ask:** an autonomous bot that scalps commodities and crypto 24/7, placing live trades, and using several
strategies rather than one.

**What was left out, and why.** Live order placement. Autonomously executing real financial transactions is a
limit I hold even with the account holder's explicit instruction. The evidence also argues against it: the app's own
measurements put 5m scalping at −0.87R per trade after costs, with entries below a random walk, so a live 24/7
bot would lose on schedule. And at $49.98, Bybit's minimum order sizes would not allow sane per-trade risk. Everything
else was built.

**What it does, fully autonomously:** every 5 minutes it scans 12 Bybit perpetuals (8 crypto; gold, silver, WTI,
Brent). It runs **four strategy sleeves**, each with its own position cap and scoreboard so none crowds out the others:
- **Trend pullback:** EMA Pullback, VWAP Bounce.
- **Mean reversion:** VWAP Snap-back, Reversal Bar.
- **Breakout:** Momentum Breakout, and Coil Breakout as a real two-sided stop bracket, one-cancels-the-other.
- **Spike fade:** new, built on the one real-time pattern that measured anything (next bar reversed 56% of 249,
  borderline). This exact trade is untested, and the bot is what tests it.

It sizes each trade from equity to Bybit's own min-qty, step and tick, places the order, checks fills every 20s on
closed 1-minute bars, and manages the stop, target and a time exit.

**Risk controls:** 0.5% risk per trade; 6 open trades max; a 3% daily loss stop that halts new entries until 00:00
UTC; no entries within 30 min of a high-impact release; a 30-min cooldown on a market after a loss; unfilled
orders cancelled after 30 min; positions flattened after 4 h; setups skipped when costs exceed 0.5R. All but the
fixed windows are adjustable in the tab.

**One venue, so the paper is honest.** Signals, prices and fills all come from Bybit's own perpetual markets, so a
level on the chart is the level that fills. The scalp desk's commodities are read from CNBC futures, whose prices
sit a basis away from Bybit's perps and would have made paper fills fictional.

**Fill model, conservative by construction:** limits fill as maker with no slippage; stop orders, stop-losses and
time exits pay taker plus slippage; a bar touching both stop and target counts as a loss; a target in the fill bar
doesn't count, since it may have come first; the 1-minute bar forming at placement can't fill the order.

**Verified against an independent calculation.** Orders planted ~70 minutes in the past (a BTC limit long, an ETH
limit short, a SOL stop bracket) were processed by the engine over real 1-minute bars and **all 3 matched** a
separate re-implementation of the rules. The bracket's other side cancelled on fill, and the P&L reconciled to the
cent (BTC: −$74.80 gross, −$62.49 fees, −$137.29 net). That test used a deliberately tiny stop, so its −2.36R shows
fees overwhelming the risk — the exact arithmetic the 0.5R cost filter exists to block. Book reset afterwards.

**Supporting change:** the analyser's limit-order conversion is now a reusable function, so every qualifying setup
can be converted rather than only the winner. It returns a `candidates` list, and the 5m desk's output is verified
unchanged.

**Invariant, verified by grep:** 0 call sites for Bybit's order API. The bot's only outbound calls are
`/v5/market/kline` and `/v5/market/instruments-info`.

Verified: 12 endpoints 200, 15 tabs render, zero JS errors, bot running and state persisted to data/bot.json.

## 2026-10-02 — 🔁 3Commas: a read-only dashboard on the new v2 Open API

**The ask:** a section dedicated to the 3Commas trading-bot platform. The user already has a 3Commas account
connected to an exchange.

**The research changed the build.** Everything published about 3Commas's API — the GitHub docs, client libraries,
guides — describes v1, which is gone. Every `api.3commas.io/public/api` endpoint now redirects to a help article: **v1
shut down on 11 Sep 2026** and merged into a v2 platform "built in partnership with WunderTrading". Strategies don't
transfer, all v1 API connections were deactivated, and 3Commas says open v1 positions remain live but unmanaged,
recommending users revoke old 3Commas keys on their exchanges. Building against v1 would have produced a dashboard
that could never connect.

**v2 has its own Open API**, which the user pointed to. Its docs at trade.3commas.io/docs block scripts, so they were
read in the in-app browser, which loaded them normally with no challenge to get around. Verified from them:
- base `https://trade.3commas.io`; HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nRECV_WINDOW\nBODY`, **Base64**-encoded,
  sent as `X-API-Key` / `X-Signature` / `X-Timestamp` / `X-Recv-Window`;
- read endpoints `GET /open_api/api_profiles` (weight 50), `/strategies/live` (10), `/strategies/history` (10, last
  3 months), each gated by a read scope (`api_profile:read`, `strategy:read`) — so a key can be made that cannot trade;
- 1,200 tokens/min per key; keys without an IP whitelist are deleted after three months.

The server can reach the API: an unauthenticated probe returned a clean JSON 401, not a Cloudflare page.

**Read-only by construction.** `tcGet()` sends only GET, and only to an allow-list of those three paths; anything else
throws. v2's trade, modify, cancel, market-close and market-enter endpoints are not implemented. Verified by
inspection: the only HTTP method in the module is GET, and the one trade-related string is the comment saying so.

**Two data traps found in 3Commas's own documentation:**
- **`totalProfitLoss` can't be trusted for size.** The docs' own example reports −$800.98 on a $200 position. Closed-deal
  P&L is therefore computed from the actual money in and out, minus fees; the platform's figure is used only for its
  sign, to tell long from short.
- **There is no long/short field.** Direction is inferred from whether the platform's unrealised % moves with or against
  price, and shown as "?" when it can't be. Unrealised dollars come from amounts actually held, so leverage needs no
  guessing. Checked against the docs' example: LONG, −$62.88, worst point −39.8%.

**What the tab shows:** connected exchanges and balances; open deals (live vs paper, entry/last, unrealised % and $,
the worst point against each, safety orders used / max, size, source); and three months of closed deals with net P&L,
hit rate, profit factor and fees. It also has a **win-rate trap** panel: how many winning deals went 10%+ against you
before closing green. DCA bots win often precisely because they average down, so a high hit rate can hide deep
drawdowns, and one bad loss can erase many small wins. Paper deals are shown but excluded from every money total, and
the 20-deal bar applies.

**Setup** sits in the tab itself: create a key at the v2 Open API page with only `api_profile:read` and
`strategy:read`, whitelist the IP, paste into `.env` (hot-reloads). Verified: no key → setup steps; a deliberately fake
key → reaches 3Commas, which answers "Invalid API key" (401), with a plain-English fix; `.env` restored to empty after.

Verified: 13 endpoints 200, 16 tabs render, zero JS errors.

### 2026-10-02 (later) — 3Commas connected; two fixes from real data
- **First connection failed** with "Invalid signature". Ruled out the code: clock in sync with 3Commas to the second;
  signing matches the docs' auth page exactly; plain and base64-decoded secret both failed. The cause was the pasted
  secret, at 87 characters; a 64-byte base64 secret is 88. Re-pasted in full, it connected.
- **`totalProfitLoss` is dollars × 10,000.** On the live deal it read −109.9084 when the only realised P&L was the
  $0.01099084 entry fee — exactly ×10⁴. This also explains the docs' −800.98 on a $200 position. It is now divided by
  1e4. Open deals carry no realised `pnl`; unrealised still comes from amounts held. Closed-deal P&L still comes from
  money in and out, with the scaled platform figure only as a last resort. Before, a closed deal with missing costs
  would have shown the raw ×10⁴ number. (n=2 confirmations: live deal + docs example; recheck against the first real
  closed deal.)
- **One wallet, two connections.** Bybit spot + USDT-M futures appear as separate 3Commas profiles with identical
  balances (unified account). The repeat is now labelled "same wallet as … — don't add them up".
- Verified: /api/3commas ok, no partial errors; the AVAUSDT deal reads SHORT (+0.67%, +$0.13, matches price
  0.2668→0.265 × 74.9); 9 core endpoints 200; tab renders; zero console errors.

## 2026-10-14 — Two scoring bugs, found by testing a forecast against live data

**Method.** The limit-order pass (30 Sep) made a testable forecast from a crypto replay: fills on 37% of signals,
44.9% win, −0.496R net per trade. Twelve days later there were 356 live limit trades to check it against. Net per
trade came in close (−0.525R crypto). The fill rate did not: **93%**, against a forecast of 37%. Chasing that gap
found two resolver bugs.

**Bug 1 — the fill window counted candles, not time.** "Rest 6 bars" was `after.slice(0, 6)`: the first six
candles *available*. The resolver fetches the scanner's feed, the latest 240 bars, about 20h of crypto 5m, or one
CNBC session. When the app was offline (the ledger shows 43 gaps >6h, up to 59h, 9–12 Oct), the bars after a signal
had already rolled off by resolution time. The resolver then scored it on whatever bars came later. **16 limit orders
were "filled" 34–42 bars into a 6-bar window: 15 recorded as losses and 1 as an expired loser.** Stop-entry signals
were exposed the same way, but nothing in the record shows it.
- **Fix:** crypto candles now come from Binance **by time** (`binanceRange`, `startTime` paging), from the bar each
  signal fired in, so app downtime no longer matters. That is how the Auto Scalper already worked; its `checkedTo`
  catch-up was verified correct. For CNBC markets, which can't serve old bars, a coverage guard: if the candles no
  longer reach back to the signal, it is **void**, not guessed.

**Bug 2 — the fill candle was read in the wrong order.** Inside the 5m candle that fills an order, only the level
on the *same side* as the fill can be ordered after it. A buy limit fills on the way down, so a stop below can follow
in that candle. A target above may have printed *before* the dip reached the entry. A buy stop is the mirror image.
The resolver read every level in the fill candle as if it came after the fill. **This was generous to limit orders
and harsh on stop orders.** 1-minute ground truth on the crypto limit cohort: 11 of 50 wins were decided inside the
fill candle, and 4 of those were really losses.
- **Fix:** `fillBarFromMinutes` replays the fill candle on 1-minute bars to order the events: Binance by time for
  crypto, CNBC 1m for the rest. With no 1m data, the trade is void ("no 1-minute data to tell which came first").
  The backfill study has no 1m data, so it now skips such samples instead of guessing. Daily (1d) resolution is
  unchanged: picks enter at the close, and their fills will need their own look.

**History.** Backed up to `data/signals.backup-2026-10-14.json`; every changed record keeps `rescore.from`.
- **Crypto, re-scored from complete Binance history under the new rules (1,077 records):** 905 unchanged. 111
  previously void for lost coverage are now scored (44 win, 45 loss, 20 no-fill, 2 expired). 18 loss→win (old stop
  entries, bug 2). 4 win→loss (limits, bug 2). 24 no-fill→filled and 5 loss→no-fill (bug 1). 10 now void (minute-level ties).
- **Independent check: 70/70** sampled records (40 changed, 30 unchanged) match a separate Python implementation run
  on fresh Binance 5m and 1m data.
- **Non-crypto: only the 4 provable errors voided** (limits filled after their window). CNBC can't serve old intraday
  bars, so the rest can't be re-checked. 380 non-crypto results were resolved >12h after their signal, and some may
  have been scored on partial bars. Many are legitimate: a stock signal near the close resolves next morning on the
  prior session. Voiding them all on a time cutoff would be guessing, so they stand, flagged here as unverifiable.
  The coverage guard prevents new ones.

**What the corrected ledger says (crypto, net of costs):**

| | before fix | after fix |
|---|---|---|
| 5m limit entries (since 30 Sep), net/trade | −0.525R (win 47.0%, n=100) | **−0.595R** (win 43.3%, n=104) |
| 5m stop entries (Aug–Sep), net/trade | −0.769R (win 43.7%, n=503) | **−0.708R** (win 47.2%, n=595) |
| limit advantage | 0.244R | **0.113R** |
| 15m, net/trade | −0.568R | −0.516R |

- **The limit-order advantage is about half what the live data had shown.** The two bugs leaned opposite ways and
  together doubled the gap. Limits are still the less-bad entry, but on a different period than the stop history, so
  the comparison is confounded. 104 trades can't separate the remainder from regime. Gross per trade: limits −0.135R,
  stops −0.029R. Pullback entries may be selecting adversely and giving back half the fee saving. Unproven at this n.
- **The 37% fill-rate forecast did not hold:** live is 86% even after the fix. Most likely the replay counted setups
  where price was already through the level, which live stands aside on and never records. Unverified.
- **No model changes.** Every desk is still net negative after costs. The tuner and the ranked suggestions read the
  corrected ledger automatically; nothing was re-weighted by hand.

**Auto Scalper (paper, 30 Sep–13 Oct):** 46 trades, −$370 (−3.7%). Gross before fees +$216, fees $587. Only the
trend sleeve has n ≥ 20: 22 trades, −0.44R/trade, consistent with the ledger's EMA Pullback. Breakout (12, +0.32R)
and Spike Fade (12, −0.12R) are too small to judge. Mean reversion has 0 trades. No sleeve switched off: a
user-facing choice, and the sample is borderline.

**3Commas:** could not recheck the ×10⁴ P&L scaling against a closed deal. The home IP changed (60.228.0.7 →
60.228.4.54), so 3Commas now rejects the key until the whitelist is updated.

Verified: node --check; 12 of 13 endpoints 200 on first call, Smart Wallets 200 on retry (cold GeckoTerminal pacing,
~25s+, pre-existing); 16 tabs render; zero console errors; bot resumed after restart; 0 order-API call sites.

## 2026-10-14 (later) — The cloud research routine, checked and brought into the 5m tab

**The ask:** check the routine "⚡ Daily market mover self improvement Task" and implement its data.

**What the routine is.** A cloud routine (daily 22:25 UTC) on a separate GitHub repo,
`joshphillips1119-art/claude-cloud-session`, which is **public**. It **can't see this app or its ledger.** Its real
system lives on the branch `claude/scalper-live`: a tested BTC 5m next-candle direction predictor with walk-forward
tuning, a Hedge ensemble, daily journals and `state/scoreboard.jsonl`. It has run since 6 Oct. Scanned the repo for
secrets and personal data: none.

**Reliability bug found in the routine.** Each run starts from `main`, which holds only a README. The operating
manual is on `claude/scalper-live`. The 12 Oct run found it. **The 13 Oct run didn't:** it built a separate toy tool
from scratch (`scalp_lab/`, PR #1), and the real system missed scoring 12 Oct. Whether a run finds the system depends
on whether it thinks to look at other branches.

**Its findings, tested before implementing anything:**
- Its own verdict (6 days, out-of-sample): **51.3%** right (95% 47.7–54.9%, 729 calls), **−10.2 bp per call** after
  its 10 bp round trip, no confirmed edge. Simply "betting the last bar reverses" (52.6%) did better.
- The 13 Oct tool's fade rules, re-run here with its own code on **60 days** of BTC/ETH/SOL in money terms: next
  candles move 9.9 bp on average; the best rules earn **+0.1 to +0.6 bp per call before costs**, none significant
  (all |t| < 1.8 except one 113-call rule designed after seeing its test day). After a 4 bp best-case round trip (maker
  both sides) every rule loses 3.4–4.3 bp per call. At taker cost (~15 bp) they lose ~15 bp. Its "4h trend-gated fade"
  adjustment: **49.7%** over 60 days. Its 54.5% was the day it was designed on.
- **Same conclusion as this app's live read (next 5m ≈ coin flip) and its cost findings.** A correct direction call is
  worth a fraction of a basis point; a round trip costs 4–15.

**Implemented:** a **📡 Daily research routine** panel in the 5m Scalps tab. `/api/routine` reads the routine's
public `scoreboard.jsonl` (one keyless, read-only fetch, cached 1h) and shows pooled out-of-sample accuracy with a
Wilson interval, every-bar and "reverses" baselines, net bp after costs, and day-by-day regime. It **flags missed
days** (it caught the 13 Oct miss: "should have scored 12 Oct"). **Display only: it feeds no signal, ranking or
weight in this app**, because its data shows no edge after costs.

**Not done (needs the user):** fixing the routine itself, i.e. its prompt or the repo's default branch, and the
duplicate PR #1. These are persistent changes to the user's routine and repo.

Verified: node --check; `/api/routine` pooled figures match an independent sum of the raw file (729/374, 51.3%,
−10.2 bp) and the routine's own weekly report; missed-day logic correct (latest 11 Oct, expected 12 Oct); panel
renders; zero console errors; 13 endpoints 200; 0 order-API call sites.

## 2026-10-15 — Yesterday's fix tested by a real 23-hour outage: crypto held, non-crypto exposed a 220-bar cap

**The test.** The app was off from 14 Oct 11:17 to 15 Oct 10:19 (23h). Crypto signals from the gap were scored from
Binance by time: **8 resolved, 0 void.** Non-crypto came out **18 void of 37**, which was suspicious:
- 8 "candle history no longer reaches back" (the coverage guard, by design);
- **6 "no 1-minute data to order the fill bar" (a bug in yesterday's fix);**
- 4 "no candle coverage inside the window".

**Cause: a 220-bar cap, not missing data.** `cnbcBars` keeps the newest 220 aggregated bars. CNBC's "1D" chart
actually serves **~48h of 1-minute bars**: 1,881–2,594 on NVDA, @PL.1 and @NG.1, back to 12 Oct 23:20 UTC. The cap
meant the resolver saw **~18h of 5m** history and **<4h of 1m**, so the 1-minute fill-bar check could never reach a
fill older than about 3.7h. The coverage guard was voiding signals whose bars still existed.

**Fix:** `cnbcFull(meta, tfMs)` returns the whole feed, cached 60s. The resolver uses it for non-crypto 5m/15m candles
and for the 1-minute fill-bar replay, falling back to Yahoo if CNBC fails. The scanner keeps its 220-bar slice, which
is all it needs. Non-crypto offline tolerance goes from ~18h to ~48h; crypto has none to worry about.

**Recovered:** 24 non-crypto voids from the last 46h re-opened (backup `data/signals.backup-2026-10-15.json`,
`rescore.from` kept). **18 now scored** (5 win, 6 loss, 7 no-fill). **6 remain void, correctly:** 4 stock signals
fired outside market hours with no bars in their window, and 2 genuine same-minute ties. **Independent check: 22/22**
LONG/SHORT records, voids included, match a separate Python implementation on CNBC's raw 1-minute feed; 2 brackets
excluded.

**Daily checks:**
- **Ledger:** ~30 newly resolved since yesterday. Too few to move any bucket; no model changes.
- **Cloud routine:** this morning's run found its real system on `claude/scalper-live` and caught up both days (12
  Oct 41.5%, 13 Oct 48.8%). The panel's missed-day flag cleared. Its pooled out-of-sample: **49.0%** (95% 46.1–51.8,
  1,160 calls), −10.3 bp/call. "Bet the last bar reverses": 52.4% (50.3–54.4), +0.39 bp gross, −9.6 bp net. The
  predictor is now below the simplest baseline, and nothing is tradeable after costs.
- **Auto Scalper:** no trades since 13 Oct; it only runs while the app does.
- **3Commas:** still blocked. The whitelist still has the old IP; the current one is 60.228.4.54.

**Remaining data loss** is only what no feed can recover: non-crypto gaps over ~48h, and stock signals outside market
hours. Keeping the app running (the LaunchAgent option) is the only further fix.

Verified: node --check; 13 endpoints 200; 16 tabs render; zero console errors; 0 order-API call sites.

### 2026-10-15 (later) — Runs 24/7 as a LaunchAgent
The app was offline whenever no Claude session was open. That caused the ledger's offline gaps, the voided non-crypto
signals and the Auto Scalper's idle days. It now runs from `~/Library/LaunchAgents/local.market-movers.plist`: starts
at login, restarts if it exits, logs to `~/Library/Logs/market-movers/`. It uses fnm's stable default Node (v24.21.0)
and an explicit PATH, since the Yahoo fallback calls `curl`. launchd stops it with SIGTERM, which saves the ledger.
Verified: serves on 3456; ledger 3,721 before a SIGTERM kill and 3,721 after the automatic restart (~2s, exit 0); bot
scanning under launchd; curl fallback works; 16 tabs, zero console errors. `.claude/launch.json` now attaches the
preview to the running agent instead of starting a second server. Mac sleep still pauses it.

## 2026-10-16 — Ledger saves were racing each other; first day of 24/7 data

**The bug.** `err.log` had **22×** `[ledger] save failed: ENOENT … rename 'signals.json.tmp' -> 'signals.json'`.
Three timers save the ledger independently: the resolver, the scalp recorder and the picks recorder. They all shared
one `.tmp` path. When two saves overlapped, the first rename moved the file and the second got ENOENT. The second
writer could also still be writing to the inode that had just become `signals.json`. A failed save had already
cleared `dirty`, so its changes waited for the next unrelated save.

**Fix:** `saveLedger()` now chains every save onto the one in flight, so only one write runs at a time. A queued save
with nothing new does nothing. If a write fails, `dirty` is set again so the next save retries it. The four callers
are unchanged. A reproduction ran 200 rounds of overlapping saves: the old logic failed **400** times and the new
logic **0**. Other saves are left as they are. `SW_FILE` and `BOT_FILE` write synchronously, so they can't
interleave. `PAPER_FILE` is async with five call sites, but it writes in place, with no rename to fail, and has logged
no errors. It can get the same chain if that ever changes.

**Daily checks:**
- **Ledger:** 2,522 decided, 43% hit, 87.7% fill rate. Net expectancy is negative on every desk once costs are taken
  out: 5m −0.78R (n 1,775; costs alone 0.73R), 15m −0.59R (n 646), Picks −0.46R (n 101). LONG wins 46.6% against
  SHORT 39.5%.
  - **No model changes.** The flagged factors are rr, macd and rsiExt. But `factorStability` marks rr, trend,
    rsiMom and adxStrong as unstable across its 3 periods, and climaxVol is positive in only 2 of them. None of
    them is consistent enough to reweight.
- **Cloud routine:** up to date (latest 14 Oct = expected, 0 missed).
  - 14 Oct: 19 calls, 52.6%, −7.5 bp net.
  - Pooled: **49.0%** (46.2–51.9, 1,179 calls), −10.3 bp/call.
  - Last-bar-reverses: 52.3%, −9.6 bp net. shock_reversal: 55.3% on 47 calls, too few to judge.
  - Nothing is tradeable after costs.
- **Auto Scalper:** first trades since it went 24/7. **7 closed, 1W/6L, −341.** The one win was XAU EMA Pullback
  (+0.80R); Spike Fade went 0/4.
  - Lifetime: 53 trades, 50.9% hit, PF 0.61, −711.54 net. **Fees of 671.11 are about the whole loss.**
  - Breakout sleeve: 75% on 12, +184. Commodities are positive (WTI +103 on 8, Gold 2/2, Brent flat). Every
    crypto symbol is negative.
  - Both edges are far below 20 samples. No sleeve or universe change.
- **3Commas:** still 401. The key's whitelist doesn't include the current IP, 60.228.4.54.
- **Uptime:** the Mac slept on battery 09:58–14:03 AEDT, and the agent was paused for that time. It recorded no new
  signals while asleep. Signals already open resolve by timestamp afterwards: Binance for crypto, CNBC's ~48h
  window for the rest.

Verified:
- `node --check`.
- Restarted with `launchctl kickstart -k` (pid 31268). Ledger 3,898 → 3,900 across the restart, no `.tmp` left
  behind, no new save failures (still 22).
- All read endpoints return 200, including livechart for BTC and GOLD.
- 16 tabs render with zero console errors.
- 0 order-API call sites. The only outbound POSTs are Hyperliquid `/info`, Telegram alerts and read-only Solana RPC.
