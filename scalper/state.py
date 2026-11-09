"""Persistent learning state, versioned in git.

state/params.json        current params, ensemble weights, threshold
state/scoreboard.jsonl   one row per day: out-of-sample results of the params
                         that were live that day (the honest track record)
state/changes.jsonl      every parameter / weight / threshold change
state/history/           params snapshot taken before each daily run, so a
                         run can be repeated or rolled back
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from . import strategies as S
from .config import ROOT, Config

CORE = [
    "momentum", "rsi_reversion", "bollinger_reversion", "vwap_reversion", "ema_trend",
    "donchian_breakout", "shock_reversal", "autocorr_adaptive", "taker_flow", "close_location",
]


def initial_state(names: list[str] | None = None) -> dict:
    reg = S.load_all()
    names = [n for n in (names or CORE) if n in reg]
    w = round(1.0 / (len(names) + 1), 6)  # +1: the null (abstain) expert
    return {
        "version": 0,
        "as_of": None,
        "last_run": None,
        "ensemble": {"threshold": 0.1, "null_weight": w},
        "strategies": {
            n: {"params": S.canonical(reg[n], reg[n].defaults), "weight": w, "enabled": True, "added": None}
            for n in names
        },
        "candidates": {},
    }


class StateStore:
    def __init__(self, cfg: Config, root: Path | None = None):
        self.dir = (root or ROOT) / cfg.state_dir
        self.params_path = self.dir / "params.json"
        self.scoreboard_path = self.dir / "scoreboard.jsonl"
        self.changes_path = self.dir / "changes.jsonl"
        self.history_dir = self.dir / "history"

    def exists(self) -> bool:
        return self.params_path.exists()

    def load(self) -> dict:
        return json.loads(self.params_path.read_text())

    def save(self, state: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self.params_path.write_text(json.dumps(state, indent=1, sort_keys=False) + "\n")

    def snapshot_before(self, day: str, state: dict) -> Path:
        self.history_dir.mkdir(parents=True, exist_ok=True)
        p = self.history_dir / f"params-before-{day}.json"
        if not p.exists():
            p.write_text(json.dumps(state, indent=1) + "\n")
        return p

    def load_snapshot(self, day: str) -> dict | None:
        p = self.history_dir / f"params-before-{day}.json"
        return json.loads(p.read_text()) if p.exists() else None

    def scoreboard(self) -> list[dict]:
        if not self.scoreboard_path.exists():
            return []
        return [json.loads(line) for line in self.scoreboard_path.read_text().splitlines() if line.strip()]

    def write_scoreboard(self, rows: list[dict]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        rows = sorted({r["date"]: r for r in rows}.values(), key=lambda r: r["date"])
        self.scoreboard_path.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def append_changes(self, changes: list[dict]) -> None:
        if not changes:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        with self.changes_path.open("a") as f:
            for c in changes:
                f.write(json.dumps(c) + "\n")


def clone(state: dict) -> dict:
    return copy.deepcopy(state)
