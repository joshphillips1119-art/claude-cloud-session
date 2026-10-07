"""Configuration: ``config.json`` at the repo root overrides these defaults."""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

ROOT = Path(os.environ.get("SCALPER_ROOT") or Path(__file__).resolve().parent.parent)


@dataclass
class Config:
    symbol: str = "BTCUSDT"
    # Per-source symbol overrides; sources missing here use ``symbol``.
    symbol_map: dict = field(default_factory=lambda: {
        "coinbase": "BTC-USD",
        "kraken": "XBTUSD",
        "okx": "BTC-USDT",
        "yahoo": "BTC-USD",
    })
    # Tried in order until one returns data.
    sources: list = field(default_factory=lambda: [
        "binance", "binance_vision", "binance_us", "bybit", "okx", "coinbase", "kraken",
    ])
    interval_minutes: int = 5
    horizon_bars: int = 1
    label_mode: str = "close_to_close"   # or "open_to_close" for prediction markets
    cost_bps_round_trip: float = 10.0    # fees + slippage, for net-edge reporting
    lookback_days: int = 14              # tuning window (train + validation)
    validation_days: int = 3             # most recent days held out from training
    warmup_days: int = 2                 # extra history so indicators are warm
    min_signals: int = 100               # minimum calls in the training window
    min_val_signals: int = 30
    adopt_min_gain: float = 1.0          # train wz improvement needed to change params
    max_candidates: int = 64
    hedge_eta: float = 0.3
    hedge_share: float = 0.05
    threshold_grid: list = field(default_factory=lambda: [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5])
    min_coverage: float = 0.10
    threshold_min_gain: float = 0.5
    trial_min_train_wz: float = 2.0      # bar for adopting a brand-new strategy
    guardrail_days: int = 5
    guardrail_z: float = -2.0
    data_dir: str = "data"
    state_dir: str = "state"
    journal_dir: str = "journal"

    def symbol_for(self, source: str) -> str:
        return self.symbol_map.get(source, self.symbol)

    def to_dict(self) -> dict:
        return asdict(self)


def load(path: Path | None = None) -> Config:
    path = path or ROOT / "config.json"
    cfg = Config()
    if path.exists():
        raw = json.loads(path.read_text())
        known = {f.name for f in fields(Config)}
        unknown = set(raw) - known - {"_comment"}
        if unknown:
            raise ValueError(f"unknown config keys: {sorted(unknown)}")
        for k, v in raw.items():
            if k in known:
                setattr(cfg, k, v)
    return cfg
