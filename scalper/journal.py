"""Markdown daily report written to ``journal/YYYY-MM-DD.md``."""
from __future__ import annotations

import json


def _pct(x):
    return "n/a" if x is None else f"{x * 100:.1f}%"


def _m(m: dict) -> str:
    if not m or not m.get("n"):
        return "no calls"
    return (f"{_pct(m['acc'])} of {m['n']} calls (95% CI {_pct(m['acc_lo'])}-{_pct(m['acc_hi'])}, "
            f"z={m['z']:+.2f}, coverage {_pct(m['coverage'])}, gross {m['gross_bps']:+.2f} bps, "
            f"net {m['net_bps']:+.2f} bps/call)")


def render(report: dict, cfg_dict: dict, summary: dict | None = None, notes: list[str] | None = None) -> str:
    d = report["day"]
    oos = report["oos"]
    a = report.get("analysis", {})
    st = a.get("stats", {})
    tr = a.get("trailing", {})
    L = [f"# {cfg_dict['symbol']} 5m scalp review: {d}", ""]
    L += [f"Params version scored: v{report['params_version_scored']}, new version: v{report['state_version']}. "
          f"Bars: {report['bars']}/{report['expected_bars']}.", ""]
    if report["bars"] < 0.9 * report["expected_bars"]:
        L += [f"> **Data warning:** only {report['bars']} of {report['expected_bars']} bars. Treat stats with care.", ""]

    L += ["## 1. Yesterday's market", ""]
    if st:
        L += [
            f"- **Regime:** {a.get('regime')}",
            f"- Open {st['open']:,.2f}, close {st['close']:,.2f} ({st['return_pct']:+.2f}%), "
            f"range {st['range_pct']:.2f}% (7d median {tr.get('range_pct_median', 'n/a')}%)",
            f"- 5m bar volatility {st['bar_vol_bps']} bps (7d median {tr.get('bar_vol_bps_median', 'n/a')}), "
            f"mean |move| {st['mean_abs_move_bps']} bps. Round-trip cost / mean move = {a.get('cost_vs_move')}",
            f"- Lag-1 autocorrelation {st['autocorr_lag1']:+.3f} (7d median {tr.get('autocorr_lag1_median', 'n/a')}), "
            f"variance ratio(6) {st['variance_ratio_6']}, efficiency ratio {st['efficiency_ratio']}",
            f"- Up bars {_pct(st['up_bar_frac'])}" + (f", taker-buy ratio {st['taker_buy_ratio']}" if "taker_buy_ratio" in st else ""),
            f"- Most active hours (UTC): " + ", ".join(f"{h['hour']:02d}h ({h['mean_abs_bps']} bps)" for h in a.get("top_hours_utc", [])),
            f"- Largest bars continued on the next bar {a.get('shock_continuation')} times",
            "",
        ]

    L += ["## 2. How yesterday's live predictions did (out-of-sample)", ""]
    L += [f"- **Ensemble @ threshold {oos['threshold']}:** {_m(oos['ensemble'])}",
          f"- Ensemble, every bar: {_m(oos['ensemble_all'])}"]
    for b, m in oos["baselines"].items():
        L.append(f"- Baseline `{b}`: {_m(m)}")
    L += ["", "| strategy | acc | calls | wz | net bps |", "|---|---|---|---|---|"]
    for n, m in sorted(oos["strategies"].items(), key=lambda kv: -kv[1]["wz"]):
        L.append(f"| {n} | {_pct(m['acc'])} | {m['n']} | {m['wz']:+.2f} | {m['net_bps']:+.2f} |")
    L.append("")

    L += ["## 3. Adjustments made", ""]
    ch = report.get("changes", [])
    params_ch = [c for c in ch if c["kind"] == "params"]
    if params_ch:
        for c in params_ch:
            L.append(f"- `{c['strategy']}` params {json.dumps(c['from'])} -> {json.dumps(c['to'])} "
                     f"(train wz {c['train_wz'][0]:+.2f} -> {c['train_wz'][1]:+.2f}, val wz {c['val_wz'][0]:+.2f} -> {c['val_wz'][1]:+.2f})")
    else:
        L.append("- No parameter changes passed the validation gate.")
    th = report.get("threshold", {})
    if th.get("changed"):
        L.append(f"- Abstention threshold changed to {th['threshold']} (best z {th['best']['z']:+.2f} vs {th['current']['z']:+.2f}).")
    else:
        L.append(f"- Abstention threshold kept at {th.get('threshold')}.")
    for c in ch:
        if c["kind"] == "enable":
            L.append(f"- **New strategy enabled:** `{c['strategy']}` {json.dumps(c['params'])} (train wz {c['train_wz']:+.2f}, val wz {c['val_wz']:+.2f})")
        if c["kind"] == "guardrail":
            L.append(f"- **Guardrail tripped** (recent ensemble z {c['z']}): weights reset to uniform, threshold raised to {c['threshold']}.")
    L += ["", "Ensemble weights after Hedge update:", ""]
    for n, w in sorted(report.get("weights", {}).items(), key=lambda kv: -kv[1]):
        L.append(f"- {n}: {w:.3f}")
    L.append("")

    trials = report.get("trials") or {}
    if trials:
        L += ["## 4. New strategy trials", "", "| strategy | result | train wz | val wz | ensemble val wz (without -> with) |", "|---|---|---|---|---|"]
        for n, t in trials.items():
            if t.get("status") == "skipped":
                L.append(f"| {n} | skipped ({t['reason']}) | | | |")
            else:
                L.append(f"| {n} | {t['status']} | {t['train']['wz']:+.2f} | {t['val']['wz']:+.2f} | "
                         f"{t['ensemble_val_wz'][0]:+.2f} -> {t['ensemble_val_wz'][1]:+.2f} |")
        L.append("")

    g = report.get("guardrail", {})
    L += ["## 5. Track record", "",
          f"- Last {g.get('days')} days pooled: {g.get('hits')}/{g.get('n')} hits, z={g.get('z')}"]
    if summary:
        e = summary["ensemble"]
        L.append(f"- All {summary['days']} scored days: ensemble acc {_pct(e['acc'])} over {e['n']} calls (z={e['z']}), "
                 f"net {e.get('net_bps_per_call')} bps/call; always-up baseline {_pct(summary['baselines']['always_up']['acc'])}")
    L.append("")
    if notes:
        L += ["## 6. Notes", ""] + [f"- {n}" for n in notes] + [""]
    return "\n".join(L)
