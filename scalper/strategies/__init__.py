"""Strategy registry.

A strategy is a function ``fn(df, **params) -> pd.Series`` that returns, for
every bar t, a score in [-1, 1] predicting the direction of the next bar
(positive = up). It may only use rows <= t. NaN means "no opinion" (warm-up).

Add a strategy by dropping a module in this package that uses ``@register``.
Modules are auto-discovered, so no other file needs editing.
"""
from __future__ import annotations

import importlib
import itertools
import pkgutil
import random
import zlib
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

OHLCV = ("open", "high", "low", "close", "volume")


@dataclass(frozen=True)
class Strategy:
    name: str
    fn: Callable[..., pd.Series]
    defaults: dict
    grid: dict
    category: str
    description: str
    requires: tuple = OHLCV
    invertible: bool = True
    source: str = ""
    extra: dict = field(default_factory=dict)


REGISTRY: dict[str, Strategy] = {}


def register(
    name: str,
    *,
    defaults: dict,
    grid: dict,
    category: str,
    description: str,
    requires: tuple = OHLCV,
    invertible: bool = True,
    source: str = "",
):
    def deco(fn):
        if name in REGISTRY and REGISTRY[name].fn.__module__ != fn.__module__:
            raise ValueError(f"duplicate strategy name {name!r}")
        for k in grid:
            if k not in defaults:
                raise ValueError(f"{name}: grid key {k!r} missing from defaults")
        REGISTRY[name] = Strategy(
            name=name,
            fn=fn,
            defaults=dict(defaults),
            grid={k: list(v) for k, v in grid.items()},
            category=category,
            description=description,
            requires=tuple(requires),
            invertible=invertible,
            source=source,
        )
        return fn

    return deco


def load_all() -> dict[str, Strategy]:
    for mod in pkgutil.iter_modules(__path__):
        if not mod.name.startswith("_"):
            importlib.import_module(f"{__name__}.{mod.name}")
    return REGISTRY


def get(name: str) -> Strategy:
    load_all()
    return REGISTRY[name]


def has_inputs(strat: Strategy, df: pd.DataFrame) -> bool:
    for col in strat.requires:
        if col not in df.columns or df[col].isna().all():
            return False
    return True


def compute(name: str, df: pd.DataFrame, params: dict | None = None) -> pd.Series:
    """Run a strategy with framework conventions applied.

    ``_sign`` (+1/-1) flips the strategy (momentum <-> reversal); it is the
    one parameter the framework adds on top of the strategy's own grid.
    """
    strat = get(name)
    p = {**strat.defaults, **(params or {})}
    sign = float(p.pop("_sign", 1))
    if not has_inputs(strat, df):
        return pd.Series(np.nan, index=df.index, dtype=float)
    out = strat.fn(df, **p)
    out = pd.Series(out, index=df.index, dtype=float).clip(-1.0, 1.0)
    out = out.where(np.isfinite(out))
    return out * sign


def full_grid(strat: Strategy) -> list[dict]:
    keys = list(strat.grid)
    combos = [dict(zip(keys, vals)) for vals in itertools.product(*(strat.grid[k] for k in keys))]
    if not combos:
        combos = [{}]
    if strat.invertible:
        combos = [{**c, "_sign": s} for c in combos for s in (1, -1)]
    return combos


def canonical(strat: Strategy, params: dict) -> dict:
    p = {k: params.get(k, strat.defaults[k]) for k in strat.grid}
    if strat.invertible:
        p["_sign"] = int(params.get("_sign", 1))
    return p


def neighbours(strat: Strategy, params: dict) -> list[dict]:
    """Params one grid step away from ``params`` along each axis."""
    base = canonical(strat, params)
    out = []
    for k, vals in strat.grid.items():
        if base[k] not in vals:
            continue
        i = vals.index(base[k])
        for j in (i - 1, i + 1):
            if 0 <= j < len(vals):
                out.append({**base, k: vals[j]})
    if strat.invertible:
        out.append({**base, "_sign": -base["_sign"]})
    return out


def candidates(strat: Strategy, current: dict, max_n: int, seed_key: str) -> list[dict]:
    """Current params, their neighbours, then a deterministic sample of the grid."""
    seen, out = set(), []

    def add(p):
        key = tuple(sorted(p.items()))
        if key not in seen:
            seen.add(key)
            out.append(p)

    add(canonical(strat, current))
    for p in neighbours(strat, current):
        add(p)
    grid = full_grid(strat)
    rng = random.Random(zlib.crc32(f"{strat.name}|{seed_key}".encode()))
    rng.shuffle(grid)
    for p in grid:
        if len(out) >= max_n:
            break
        add(p)
    return out
