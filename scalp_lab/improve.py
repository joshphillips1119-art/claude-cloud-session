#!/usr/bin/env python3
"""Daily self-improvement loop for 5-minute scalp direction predictions.

Each run:
  1. Downloads 5m klines (Binance public data API) for the review day plus a
     trailing training window.
  2. Scores every strategy in STRATEGIES on "will the next 5m candle close
     above its open?" -- hit rate, coverage, and an edge z-score.
  3. Walk-forward: strategy weights are fit on the training window only, then
     the weighted ensemble is tested on the review day (no lookahead).
  4. Merges results into state/scores.json (exponentially decayed history) and
     writes reports/YYYY-MM-DD.md with promote / demote decisions.

Stdlib only. Usage: python3 scalp_lab/improve.py [--day YYYY-MM-DD]
"""
import argparse
import json
import math
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(ROOT, "state", "scores.json")
REPORTS = os.path.join(ROOT, "reports")
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
TRAIN_DAYS = 7
DECAY = 0.85          # weight kept by yesterday's history when merging a new day
MIN_Z_PROMOTE = 2.0   # walk-forward z needed to call a rule "active"
API = "https://data-api.binance.vision/api/v3/klines"


# ---------------------------------------------------------------- data
def fetch(symbol, start, end):
    out, t = [], int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    while t < end_ms:
        url = f"{API}?symbol={symbol}&interval=5m&startTime={t}&endTime={end_ms - 1}&limit=1000"
        with urllib.request.urlopen(url, timeout=30) as r:
            rows = json.load(r)
        if not rows:
            break
        for k in rows:
            out.append({
                "t": k[0], "o": float(k[1]), "h": float(k[2]), "l": float(k[3]),
                "c": float(k[4]), "v": float(k[5]), "tb": float(k[9]),
            })
        t = rows[-1][0] + 300_000
    return out


# ---------------------------------------------------------------- features
def ema(vals, n):
    a, e, out = 2 / (n + 1), None, []
    for x in vals:
        e = x if e is None else a * x + (1 - a) * e
        out.append(e)
    return out


def add_features(c):
    closes = [k["c"] for k in c]
    e9, e21, e48 = ema(closes, 9), ema(closes, 21), ema(closes, 48)
    gain = loss = None
    cum_pv = cum_v = 0.0
    day = None
    for i, k in enumerate(c):
        k["ret"] = (k["c"] - k["o"]) / k["o"]
        k["e9"], k["e21"] = e9[i], e21[i]
        k["e48"] = e48[i]
        k["e48_slope"] = e48[i] - e48[i - 6] if i >= 6 else 0
        # RSI(14), Wilder
        if i:
            d = closes[i] - closes[i - 1]
            g, l = max(d, 0), max(-d, 0)
            gain = g if gain is None else (gain * 13 + g) / 14
            loss = l if loss is None else (loss * 13 + l) / 14
            k["rsi"] = 100 - 100 / (1 + gain / loss) if loss else 100
        # session (UTC day) VWAP
        d0 = k["t"] // 86_400_000
        if d0 != day:
            day, cum_pv, cum_v = d0, 0.0, 0.0
        tp = (k["h"] + k["l"] + k["c"]) / 3
        cum_pv += tp * k["v"]
        cum_v += k["v"]
        k["vwap"] = cum_pv / cum_v if cum_v else k["c"]
        # 20-bar stats
        if i >= 19:
            w = closes[i - 19:i + 1]
            m = sum(w) / 20
            sd = math.sqrt(sum((x - m) ** 2 for x in w) / 20)
            k["bb_m"], k["bb_sd"] = m, sd
            vols = [x["v"] for x in c[i - 19:i + 1]]
            k["vol_z"] = (k["v"] - sum(vols) / 20) / (statistics_sd(vols) or 1)
            rets = [x["ret"] for x in c[i - 19:i + 1]]
            k["rv"] = statistics_sd(rets)
            # Kaufman efficiency ratio over 10 bars: trendiness 0..1
            path = sum(abs(closes[j] - closes[j - 1]) for j in range(i - 9, i + 1))
            k["er"] = abs(closes[i] - closes[i - 10]) / path if path else 0
        k["tbr"] = k["tb"] / k["v"] if k["v"] else 0.5   # taker-buy ratio
        k["hour"] = (k["t"] // 3_600_000) % 24
    return c


def statistics_sd(xs):
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))


# ---------------------------------------------------------------- strategies
# Each returns +1 (up), -1 (down) or 0 (no call) for the NEXT candle using
# information up to and including candle i.
def s_momentum(c, i):
    return 1 if c[i]["ret"] > 0 else -1 if c[i]["ret"] < 0 else 0

def s_reversal(c, i):
    return -s_momentum(c, i)

def s_streak3_fade(c, i):
    s = [s_momentum(c, j) for j in (i - 2, i - 1, i)]
    return -s[0] if s[0] and s[0] == s[1] == s[2] else 0

def s_rsi_extreme(c, i):
    r = c[i].get("rsi")
    return 0 if r is None else 1 if r < 25 else -1 if r > 75 else 0

def s_bb_fade(c, i):
    k = c[i]
    if "bb_sd" not in k or not k["bb_sd"]:
        return 0
    z = (k["c"] - k["bb_m"]) / k["bb_sd"]
    return -1 if z > 2 else 1 if z < -2 else 0

def s_vwap_revert(c, i):
    k = c[i]
    if not k.get("rv"):
        return 0
    dev = (k["c"] - k["vwap"]) / k["vwap"] / k["rv"]
    return -1 if dev > 3 else 1 if dev < -3 else 0

def s_ema_trend(c, i):
    return 1 if c[i]["e9"] > c[i]["e21"] else -1

def s_taker_flow(c, i):
    t = c[i]["tbr"]
    return 1 if t > 0.60 else -1 if t < 0.40 else 0

def s_taker_exhaustion(c, i):
    # heavy one-sided aggression on a volume spike tends to mean-revert
    k = c[i]
    if k.get("vol_z", 0) < 2:
        return 0
    return -1 if k["tbr"] > 0.62 else 1 if k["tbr"] < 0.38 else 0

def s_volume_breakout(c, i):
    k = c[i]
    return s_momentum(c, i) if k.get("vol_z", 0) > 2.5 else 0

def s_regime_switch(c, i):
    # follow momentum in trending tape (high ER), fade it in chop (low ER)
    er = c[i].get("er")
    if er is None:
        return 0
    return s_momentum(c, i) if er > 0.6 else -s_momentum(c, i) if er < 0.2 else 0

def s_wick_rejection(c, i):
    k = c[i]
    rng = k["h"] - k["l"]
    if not rng:
        return 0
    upper = (k["h"] - max(k["o"], k["c"])) / rng
    lower = (min(k["o"], k["c"]) - k["l"]) / rng
    return -1 if upper > 0.6 else 1 if lower > 0.6 else 0

def htf_trend(k):
    # 4h trend proxy: price vs EMA48 (5m bars) and EMA48 slope over 30 min agree
    if k["c"] > k["e48"] and k["e48_slope"] > 0:
        return 1
    if k["c"] < k["e48"] and k["e48_slope"] < 0:
        return -1
    return 0

def s_trend_gated_fade(c, i):
    # added 2026-10-13: 10/12 sell-off showed ungated fades buying every dip in a
    # trending tape. Only take the fade when it points WITH the 4h trend
    # (buy dips in uptrends, sell rips in downtrends).
    t = htf_trend(c[i])
    p = s_reversal(c, i)
    return p if t and p == t else 0

def s_trend_gated_bb(c, i):
    # added 2026-10-13: Bollinger 2sd fade, same higher-timeframe gate
    t = htf_trend(c[i])
    p = s_bb_fade(c, i)
    return p if t and p == t else 0

STRATEGIES = {
    "momentum_1bar": s_momentum,
    "reversal_1bar": s_reversal,
    "streak3_fade": s_streak3_fade,
    "rsi14_extreme_fade": s_rsi_extreme,
    "bollinger_2sd_fade": s_bb_fade,
    "vwap_3sigma_revert": s_vwap_revert,
    "ema9_21_trend": s_ema_trend,
    "taker_flow_follow": s_taker_flow,
    "taker_exhaustion_fade": s_taker_exhaustion,
    "volume_spike_follow": s_volume_breakout,
    "efficiency_regime_switch": s_regime_switch,
    "wick_rejection": s_wick_rejection,
    "trend_gated_fade": s_trend_gated_fade,
    "trend_gated_bb_fade": s_trend_gated_bb,
}


# ---------------------------------------------------------------- scoring
def evaluate(c, lo, hi, fn):
    hits = calls = 0
    for i in range(max(lo, 25), hi - 1):
        p = fn(c, i)
        nxt = c[i + 1]["c"] - c[i + 1]["o"]
        if not p or not nxt:
            continue
        calls += 1
        hits += (p > 0) == (nxt > 0)
    return hits, calls


def z(h, n):
    return (h - n / 2) / math.sqrt(n / 4) if n else 0.0


def hour_bias(c, lo, hi):
    up, tot = [0] * 24, [0] * 24
    for i in range(max(lo, 25), hi - 1):
        n = c[i + 1]
        if n["c"] == n["o"]:
            continue
        tot[n["hour"]] += 1
        up[n["hour"]] += n["c"] > n["o"]
    return [(up[h] / tot[h] if tot[h] else 0.5, tot[h]) for h in range(24)]


def ensemble(c, lo, hi, weights, thresh):
    hits = calls = 0
    for i in range(max(lo, 25), hi - 1):
        s = sum(w * STRATEGIES[name](c, i) for name, w in weights.items())
        nxt = c[i + 1]["c"] - c[i + 1]["o"]
        if abs(s) < thresh or not nxt:
            continue
        calls += 1
        hits += (s > 0) == (nxt > 0)
    return hits, calls


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", help="review day (UTC), default yesterday")
    a = ap.parse_args()
    day = (datetime.strptime(a.day, "%Y-%m-%d").replace(tzinfo=timezone.utc) if a.day
           else datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1))
    start = day - timedelta(days=TRAIN_DAYS, hours=3)   # 3h warm-up for indicators
    end = day + timedelta(days=1)
    day_ms = int(day.timestamp() * 1000)
    train_ms = int((day - timedelta(days=TRAIN_DAYS)).timestamp() * 1000)

    state = json.load(open(STATE)) if os.path.exists(STATE) else {"days": [], "strategies": {}}
    res, market = {}, {}
    for sym in SYMBOLS:
        c = add_features(fetch(sym, start, end))
        tr_lo = next(i for i, k in enumerate(c) if k["t"] >= train_ms)
        d_lo = next(i for i, k in enumerate(c) if k["t"] >= day_ms)
        n = len(c)
        dc = c[d_lo:]
        rets = [k["ret"] for k in dc]
        market[sym] = {
            "open": dc[0]["o"], "close": dc[-1]["c"],
            "chg_pct": 100 * (dc[-1]["c"] / dc[0]["o"] - 1),
            "range_pct": 100 * (max(k["h"] for k in dc) / min(k["l"] for k in dc) - 1),
            "rv_5m_bp": 1e4 * statistics_sd(rets),
            "up_bars_pct": 100 * sum(r > 0 for r in rets) / len(rets),
            "mean_er": sum(k.get("er", 0) for k in dc) / len(dc),
            "lag1_autocorr": autocorr(rets),
        }
        # per-strategy: train window and review day
        weights = {}
        for name, fn in STRATEGIES.items():
            th, tn = evaluate(c, tr_lo, d_lo + 1, fn)
            dh, dn = evaluate(c, d_lo, n, fn)
            res.setdefault(name, {})[sym] = {"train": (th, tn), "day": (dh, dn)}
            tz = z(th, tn)
            if tz > 1.0:                      # only trust rules with training edge
                weights[name] = tz
        # walk-forward ensemble with training-fit weights; threshold tuned on train
        best = (0, None, (0, 0))
        if weights:
            tot = sum(weights.values())
            weights = {k: v / tot for k, v in weights.items()}
            for th_ in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5):
                h, nn = ensemble(c, tr_lo, d_lo + 1, weights, th_)
                if nn >= 150 and z(h, nn) > best[0]:
                    best = (z(h, nn), th_, (h, nn))
        oos = ensemble(c, d_lo, n, weights, best[1]) if best[1] is not None else (0, 0)
        hb = hour_bias(c, tr_lo, d_lo + 1)
        hb_hits = hb_calls = 0
        for i in range(d_lo, n - 1):
            p, cnt = hb[c[i + 1]["hour"]]
            nx = c[i + 1]
            if cnt >= 40 and abs(p - 0.5) > 0.08 and nx["c"] != nx["o"]:
                hb_calls += 1
                hb_hits += (p > 0.5) == (nx["c"] > nx["o"])
        res.setdefault("_ensemble", {})[sym] = {"weights": weights, "thresh": best[1],
                                                "train": best[2], "day": oos}
        res.setdefault("hour_of_day_bias", {})[sym] = {"train": (0, 0), "day": (hb_hits, hb_calls)}

    # merge into decayed history
    ds = day.strftime("%Y-%m-%d")
    if ds not in state["days"]:
        for name, per in res.items():
            if name == "_ensemble":
                continue
            h = sum(v["day"][0] for v in per.values())
            n = sum(v["day"][1] for v in per.values())
            s = state["strategies"].setdefault(name, {"hits": 0.0, "calls": 0.0, "since": ds, "log": []})
            s["hits"] = s["hits"] * DECAY + h
            s["calls"] = s["calls"] * DECAY + n
            s["log"].append([ds, h, n])
        state["days"].append(ds)
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, "w"), indent=1)
    report = render(ds, res, market, state)
    os.makedirs(REPORTS, exist_ok=True)
    path = os.path.join(REPORTS, f"{ds}.md")
    open(path, "w").write(report)
    print(report)
    print(f"\nwrote {path}")


def autocorr(x):
    m = sum(x) / len(x)
    num = sum((x[i] - m) * (x[i - 1] - m) for i in range(1, len(x)))
    den = sum((v - m) ** 2 for v in x)
    return num / den if den else 0


def render(ds, res, market, state):
    L = [f"# 5m scalp review: {ds} (UTC)", "",
         "Target: direction of the next 5-minute candle (close vs open). "
         f"Train = prior {TRAIN_DAYS} days, test = review day (walk-forward, no lookahead).", "",
         "## Market recap", "",
         "| Symbol | Day chg | Range | 5m RV (bp) | Up bars | Mean ER | Lag-1 autocorr |",
         "|---|---|---|---|---|---|---|"]
    for s, m in market.items():
        L.append(f"| {s} | {m['chg_pct']:+.2f}% | {m['range_pct']:.2f}% | {m['rv_5m_bp']:.1f} | "
                 f"{m['up_bars_pct']:.1f}% | {m['mean_er']:.2f} | {m['lag1_autocorr']:+.3f} |")
    L += ["", "## Strategy scorecard (all symbols pooled)", "",
          "| Strategy | Train hit% (n) | Train z | Day hit% (n) | Day z | History hit% | Verdict |",
          "|---|---|---|---|---|---|---|"]
    rows = []
    for name, per in res.items():
        if name == "_ensemble":
            continue
        th = sum(v["train"][0] for v in per.values()); tn = sum(v["train"][1] for v in per.values())
        dh = sum(v["day"][0] for v in per.values()); dn = sum(v["day"][1] for v in per.values())
        hist = state["strategies"].get(name, {})
        hh = pct(hist.get("hits", 0), hist.get("calls", 0))
        tz, dz = z(th, tn), z(dh, dn)
        verdict = ("ACTIVE" if tz >= MIN_Z_PROMOTE and dz > 0 else
                   "watch" if tz >= 1 or dz >= 1.5 else
                   "INVERT?" if tz <= -MIN_Z_PROMOTE else "bench")
        rows.append((tz, f"| {name} | {pct(th, tn)} ({tn}) | {tz:+.2f} | {pct(dh, dn)} ({dn}) | {dz:+.2f} | {hh} | {verdict} |"))
    L += [r for _, r in sorted(rows, key=lambda x: -x[0])]
    L += ["", "## Walk-forward ensemble (per symbol)", "",
          "| Symbol | Weights (train-fit) | Threshold | Train hit% (n) | Day hit% (n) |", "|---|---|---|---|---|"]
    for s, e in res["_ensemble"].items():
        w = ", ".join(f"{k} {v:.2f}" for k, v in sorted(e["weights"].items(), key=lambda x: -x[1])) or "none (no rule with train z>1)"
        L.append(f"| {s} | {w} | {e['thresh']} | {pct(*e['train'])} ({e['train'][1]}) | {pct(*e['day'])} ({e['day'][1]}) |")
    L += ["", "Hit rates near 50% are noise: at n=288 a single day's 1-sigma band is about +/-2.9 pts. "
          "Verdicts lean on the 7-day train z and on decayed history, not on one day.", ""]
    return "\n".join(L)


def pct(h, n):
    return f"{100 * h / n:.1f}%" if n else "-"


if __name__ == "__main__":
    sys.exit(main())
