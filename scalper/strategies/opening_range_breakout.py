"""Opening-range breakout with a relative-volume gate (research/backlog.md item 13).

Zarattini & Aziz (SSRN 4416622) trade the 5-minute opening range of QQQ, and
Zarattini, Barbon & Aziz add a relative-volume ("stocks in play") filter. Crypto
has no single open, so the anchor is tuned: 00:00 UTC, 08:00 London or 09:30 New
York, each starting a 24h session (DST-aware).

For a session with anchor bar a and opening range (OR) over bars [a, e],
e = a + or_bars - 1:

  ORH = max H, ORL = min L, ORV = sum V over the OR
  RVOL = ORV / mean(ORV over the previous 14 sessions at this anchor, min 3)
  variant "direction": at e, dir = sign(C_e - O_a) if |C_e - O_a| > 0.05 ATR14_e, else 0; t0 = e
  variant "breakout":  the first t in (e, a + 48] with C_t > ORH gives dir = +1,
                       with C_t < ORL gives dir = -1; t0 = t
  stop: a long ends when C_t < ORL, a short when C_t > ORH; dir = 0 for the rest
        of the session (no re-entry)
  g = clip((RVOL - rvol_min) / (2 - rvol_min), 0, 1) if use_rvol else 1
  score_t = dir * g * exp(-(t - t0) / decay_bars) while active, else 0

Scores are 0 before the OR completes, in sessions whose anchor bar is missing, and
(with use_rvol) until three sessions of ORV history exist. ``_sign`` -1 fades the
opening range instead of following it. The spec's "atr_frac" stop and the equity
RTH anchor are left out: one stop rule keeps the grid at 24 combinations, and this
market has no equity session.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import indicators as ind
from . import register

_BAR = pd.Timedelta(minutes=5)
_ANCHORS = {
    "utc0": ("UTC", 0, 0),
    "eu_open": ("Europe/London", 8, 0),
    "us_open_ny": ("America/New_York", 9, 30),
}
_RVOL_SESSIONS = 14
_RVOL_MIN_SESSIONS = 3
_RVOL_FULL = 2.0          # RVOL at which the gate reaches full size
_DIR_MIN_ATR = 0.05       # minimum |C_e - O_a| in ATR14 units for the direction variant
_BREAKOUT_WINDOW = 48     # bars after the anchor in which a breakout may still trigger


def _session_start(index: pd.DatetimeIndex, anchor: str) -> pd.DatetimeIndex:
    tz, hh, mm = _ANCHORS[anchor]
    if tz == "UTC":
        return index.floor("D")
    off = pd.Timedelta(hours=hh, minutes=mm)
    local = index.tz_convert(tz) - off  # bars are tz-aware UTC
    start = local.tz_localize(None).floor("D") + off
    start = start.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
    return start.tz_convert(index.tz)


@register(
    "opening_range_breakout",
    defaults={"anchor": "utc0", "or_bars": 6, "variant": "breakout", "use_rvol": False,
              "decay_bars": 12, "rvol_min": 1.0},
    grid={"anchor": ["utc0", "eu_open", "us_open_ny"], "or_bars": [1, 6],
          "variant": ["direction", "breakout"], "use_rvol": [False, True]},
    category="breakout",
    description="Follow the opening range's direction, or the first close outside it, at a tuned "
                "session anchor; sized by opening-range relative volume; stopped at the far side.",
    requires=("open", "high", "low", "close", "volume"),
    source="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4416622",
)
def opening_range_breakout(df, anchor, or_bars, variant, use_rvol, decay_bars, rvol_min):
    idx = df.index
    n = len(df)
    start = _session_start(idx, anchor)
    key = pd.Series(start, index=idx)
    j = pd.Series((idx - start) / _BAR, index=idx).round()
    # Sessions missing their anchor bar have no opening range (NaT keys are dropped by groupby).
    first_j = j.groupby(key.to_numpy()).transform("first")
    has_anchor = ((first_j == 0) & key.notna()).to_numpy()

    opn = df["open"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    close = df["close"].to_numpy(dtype=float)
    vol = np.clip(df["volume"].to_numpy(dtype=float), 0.0, None)
    atr = ind.atr(df, 14).to_numpy(dtype=float)
    j_a = j.fillna(-1).to_numpy(dtype=np.int64)
    key_a = key.to_numpy()

    e = int(or_bars) - 1
    rvol_span = float(_RVOL_FULL - rvol_min)
    score = np.zeros(n)
    orv_hist: list[float] = []  # ORV of earlier sessions at this anchor, oldest first
    orh = -math.inf
    orl = math.inf
    orv = 0.0
    o_a = math.nan
    or_done = False
    direction = 0
    t0 = -1
    stopped = False
    gate = 0.0
    for t in range(n):
        if t == 0 or key_a[t] != key_a[t - 1]:
            orh, orl, orv, o_a = -math.inf, math.inf, 0.0, math.nan
            or_done, direction, t0, stopped, gate = False, 0, -1, False, 0.0
        if not has_anchor[t]:
            continue
        jt = j_a[t]
        if jt <= e:
            if jt == 0:
                o_a = opn[t]
            orh = max(orh, high[t])
            orl = min(orl, low[t])
            orv += vol[t]
            if jt < e:
                continue
            # Opening range complete.
            or_done = True
            if len(orv_hist) >= _RVOL_MIN_SESSIONS:
                base = float(np.mean(orv_hist[-_RVOL_SESSIONS:]))
                rvol = orv / base if base > 0 else math.nan
            else:
                rvol = math.nan
            orv_hist.append(orv)
            if use_rvol:
                gate = 0.0 if not math.isfinite(rvol) else min(1.0, max(0.0, (rvol - rvol_min) / rvol_span))
            else:
                gate = 1.0
            if variant == "direction":
                a = atr[t]
                if math.isfinite(o_a) and math.isfinite(a) and a > 0 and abs(close[t] - o_a) > _DIR_MIN_ATR * a:
                    direction = 1 if close[t] > o_a else -1
                    t0 = t
        else:
            if not or_done:
                continue  # a bar of the opening range is missing: skip the session
            if direction == 0 and not stopped and variant == "breakout" and jt <= _BREAKOUT_WINDOW:
                if close[t] > orh:
                    direction, t0 = 1, t
                elif close[t] < orl:
                    direction, t0 = -1, t
            if direction == 1 and close[t] < orl:
                direction, stopped = 0, True
            elif direction == -1 and close[t] > orh:
                direction, stopped = 0, True
        if direction:
            score[t] = direction * gate * math.exp(-(t - t0) / float(decay_bars))

    out = pd.Series(score, index=idx)
    return out.where(np.isfinite(atr))
