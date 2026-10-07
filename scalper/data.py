"""Market data: public REST adapters plus a per-day CSV cache under ``data/``.

Only public, key-less endpoints are used. Each adapter returns a frame indexed
by bar open time (UTC) with columns open/high/low/close/volume and, where the
venue provides them, taker_buy_volume and trades.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

from .config import ROOT, Config

COLUMNS = ["open", "high", "low", "close", "volume", "taker_buy_volume", "trades"]
UA = {"User-Agent": "Mozilla/5.0 (scalper research bot)", "Accept": "application/json"}


class DataUnavailable(RuntimeError):
    def __init__(self, errors: dict[str, str]):
        self.errors = errors
        detail = "; ".join(f"{k}: {v}" for k, v in errors.items())
        super().__init__(f"no data source succeeded ({detail})")


def _ms(ts: pd.Timestamp) -> int:
    return int(ts.timestamp() * 1000)


def _get_json(url: str, params: dict, timeout: float = 20.0, retries: int = 2):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(full, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 401, 403, 404, 451):
                break  # not transient: blocked, geo-fenced or bad symbol
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise last  # type: ignore[misc]


def _frame(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=COLUMNS, index=pd.DatetimeIndex([], tz="UTC", name="ts"))
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.set_index("ts").sort_index()
    df = df[~df.index.duplicated(keep="last")]
    for c in COLUMNS:
        df[c] = pd.to_numeric(df[c], errors="coerce") if c in df else np.nan
    return df[COLUMNS].dropna(subset=["open", "high", "low", "close"])


# --- parsers (kept separate from HTTP so they can be unit-tested) -------------

def parse_binance(rows: list) -> pd.DataFrame:
    return _frame([
        {"ts": r[0], "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5],
         "trades": r[8], "taker_buy_volume": r[9]}
        for r in rows
    ])


def parse_bybit(payload: dict) -> pd.DataFrame:
    if payload.get("retCode", 0) != 0:
        raise RuntimeError(f"bybit error {payload.get('retCode')}: {payload.get('retMsg')}")
    rows = payload.get("result", {}).get("list", [])
    return _frame([{"ts": int(r[0]), "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}
                   for r in rows])


def parse_okx(payload: dict) -> pd.DataFrame:
    if str(payload.get("code", "0")) != "0":
        raise RuntimeError(f"okx error {payload.get('code')}: {payload.get('msg')}")
    return _frame([{"ts": int(r[0]), "open": r[1], "high": r[2], "low": r[3], "close": r[4], "volume": r[5]}
                   for r in payload.get("data", [])])


def parse_coinbase(rows: list) -> pd.DataFrame:
    if isinstance(rows, dict):
        raise RuntimeError(f"coinbase error: {rows.get('message', rows)}")
    return _frame([{"ts": int(r[0]) * 1000, "low": r[1], "high": r[2], "open": r[3], "close": r[4], "volume": r[5]}
                   for r in rows])


def parse_kraken(payload: dict) -> pd.DataFrame:
    if payload.get("error"):
        raise RuntimeError(f"kraken error: {payload['error']}")
    result = payload.get("result", {})
    key = next((k for k in result if k != "last"), None)
    rows = result.get(key, []) if key else []
    return _frame([{"ts": int(r[0]) * 1000, "open": r[1], "high": r[2], "low": r[3], "close": r[4],
                    "volume": r[6], "trades": r[7]} for r in rows])


def parse_yahoo(payload: dict) -> pd.DataFrame:
    chart = payload.get("chart", {})
    if chart.get("error"):
        raise RuntimeError(f"yahoo error: {chart['error']}")
    res = (chart.get("result") or [{}])[0]
    ts = res.get("timestamp") or []
    q = (res.get("indicators", {}).get("quote") or [{}])[0]
    return _frame([{"ts": int(t) * 1000, "open": q["open"][i], "high": q["high"][i], "low": q["low"][i],
                    "close": q["close"][i], "volume": q["volume"][i]} for i, t in enumerate(ts)])


# --- fetchers ----------------------------------------------------------------

BINANCE_HOSTS = {
    "binance": "https://api.binance.com",
    "binance_vision": "https://data-api.binance.vision",
    "binance_us": "https://api.binance.us",
}


def _fetch_binance(host: str, symbol: str, start: pd.Timestamp, end: pd.Timestamp, minutes: int) -> pd.DataFrame:
    rows, cur, end_ms, step = [], _ms(start), _ms(end), minutes * 60_000
    while cur < end_ms:
        batch = _get_json(f"{host}/api/v3/klines", {
            "symbol": symbol, "interval": f"{minutes}m", "startTime": cur, "endTime": end_ms - 1, "limit": 1000})
        if not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1][0]) + step
        if nxt <= cur or len(batch) < 1000:
            break
        cur = nxt
    return parse_binance(rows)


def _fetch_bybit(symbol, start, end, minutes):
    frames, cur, step = [], start, pd.Timedelta(minutes=minutes * 1000)
    while cur < end:
        stop = min(end, cur + step)
        frames.append(parse_bybit(_get_json("https://api.bybit.com/v5/market/kline", {
            "category": "spot", "symbol": symbol, "interval": str(minutes),
            "start": _ms(cur), "end": _ms(stop) - 1, "limit": 1000})))
        cur = stop
    return pd.concat(frames) if frames else _frame([])


def _fetch_okx(symbol, start, end, minutes):
    frames, after = [], _ms(end)
    for _ in range(400):
        df = parse_okx(_get_json("https://www.okx.com/api/v5/market/history-candles", {
            "instId": symbol, "bar": f"{minutes}m", "after": after, "limit": 100}))
        if df.empty:
            break
        frames.append(df)
        after = _ms(df.index.min())
        if df.index.min() <= start:
            break
        time.sleep(0.12)  # 20 req / 2 s public limit
    return pd.concat(frames) if frames else _frame([])


def _fetch_coinbase(symbol, start, end, minutes):
    frames, cur, step = [], start, pd.Timedelta(minutes=minutes * 300)
    while cur < end:
        stop = min(end, cur + step)
        frames.append(parse_coinbase(_get_json(f"https://api.exchange.coinbase.com/products/{symbol}/candles", {
            "granularity": minutes * 60, "start": cur.isoformat(), "end": stop.isoformat()})))
        cur = stop
        time.sleep(0.2)
    return pd.concat(frames) if frames else _frame([])


def _fetch_kraken(symbol, start, end, minutes):
    # Kraken only serves the most recent 720 bars (~2.5 days at 5m).
    return parse_kraken(_get_json("https://api.kraken.com/0/public/OHLC", {
        "pair": symbol, "interval": minutes, "since": int(start.timestamp()) - 1}))


def _fetch_yahoo(symbol, start, end, minutes):
    return parse_yahoo(_get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}", {
        "interval": f"{minutes}m", "period1": int(start.timestamp()), "period2": int(end.timestamp())}))


def fetch(source: str, symbol: str, start: pd.Timestamp, end: pd.Timestamp, minutes: int = 5) -> pd.DataFrame:
    if source in BINANCE_HOSTS:
        df = _fetch_binance(BINANCE_HOSTS[source], symbol, start, end, minutes)
    else:
        fn = {"bybit": _fetch_bybit, "okx": _fetch_okx, "coinbase": _fetch_coinbase,
              "kraken": _fetch_kraken, "yahoo": _fetch_yahoo}.get(source)
        if fn is None:
            raise ValueError(f"unknown source {source!r}")
        df = fn(symbol, start, end, minutes)
    df = df[(df.index >= start) & (df.index < end)]
    return df[~df.index.duplicated(keep="last")].sort_index()


# --- cache -------------------------------------------------------------------

def day_range(start_day: str, end_day: str) -> list[str]:
    return [d.strftime("%Y-%m-%d") for d in pd.date_range(start_day, end_day, freq="D")]


class Store:
    """One CSV per UTC day in ``data/<symbol>/`` plus a manifest of provenance."""

    def __init__(self, cfg: Config, root: Path | None = None):
        self.cfg = cfg
        self.dir = (root or ROOT) / cfg.data_dir / cfg.symbol
        self.manifest_path = self.dir / "_manifest.json"
        self.manifest = json.loads(self.manifest_path.read_text()) if self.manifest_path.exists() else {}

    @property
    def bars_per_day(self) -> int:
        return 24 * 60 // self.cfg.interval_minutes

    def path(self, day: str) -> Path:
        return self.dir / f"{day}.csv"

    def is_final(self, day: str) -> bool:
        return bool(self.manifest.get(day, {}).get("final")) and self.path(day).exists()

    def save_day(self, day: str, df: pd.DataFrame, source: str, final: bool) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        out = df.copy()
        out.index = out.index.strftime("%Y-%m-%dT%H:%M:%SZ")
        out.index.name = "ts"
        out.to_csv(self.path(day))
        self.manifest[day] = {"rows": int(len(df)), "source": source, "final": bool(final)}
        self.manifest_path.write_text(json.dumps(dict(sorted(self.manifest.items())), indent=1) + "\n")

    def load_day(self, day: str) -> pd.DataFrame:
        p = self.path(day)
        if not p.exists():
            return _frame([])
        df = pd.read_csv(p)
        df.index = pd.to_datetime(df.pop("ts"), utc=True)
        df.index.name = "ts"
        for c in COLUMNS:
            if c not in df:
                df[c] = np.nan
        return df[COLUMNS]

    def load(self, start_day: str, end_day: str) -> pd.DataFrame:
        frames = [self.load_day(d) for d in day_range(start_day, end_day)]
        frames = [f for f in frames if not f.empty]
        if not frames:
            return _frame([])
        df = pd.concat(frames).sort_index()
        return df[~df.index.duplicated(keep="last")]

    def ensure(self, days: list[str], now: pd.Timestamp | None = None, log=print) -> dict:
        """Fetch every day that is missing or not yet final, falling through the
        configured sources. A source that only covers part of the request (Kraken
        keeps ~2.5 days; venues have outages) leaves the rest to the next source.
        A finished day is final only once it is (nearly) complete."""
        now = now or pd.Timestamp.now(tz="UTC")
        cutoff = now.floor(f"{self.cfg.interval_minutes}min")
        complete = int(0.95 * self.bars_per_day)
        report = {"fetched": {}, "cached": [d for d in days if self.is_final(d)], "errors": {}}
        remaining = [d for d in days if not self.is_final(d) and pd.Timestamp(d, tz="UTC") < cutoff]
        by_source: dict[str, str] = {}
        for source in self.cfg.sources:
            if not remaining:
                break
            for g in _consecutive(remaining):
                start = pd.Timestamp(g[0], tz="UTC")
                end = min(pd.Timestamp(g[-1], tz="UTC") + pd.Timedelta(days=1), cutoff)
                try:
                    df = fetch(source, self.cfg.symbol_for(source), start, end, self.cfg.interval_minutes)
                except Exception as e:  # noqa: BLE001 - every failure is reported
                    by_source[source] = f"{type(e).__name__}: {e}"[:200]
                    continue
                for d in g:
                    lo = pd.Timestamp(d, tz="UTC")
                    part = df[(df.index >= lo) & (df.index < lo + pd.Timedelta(days=1))]
                    have = self.manifest.get(d, {}).get("rows", 0) if self.path(d).exists() else 0
                    if part.empty or len(part) <= have:
                        continue
                    ended = lo + pd.Timedelta(days=1) + pd.Timedelta(minutes=15) <= now
                    final = ended and len(part) >= complete
                    self.save_day(d, part, source, final)
                    report["fetched"][d] = {"rows": int(len(part)), "source": source, "final": final}
            # A finished day stays in play until complete; today's partial day only needs some rows.
            still = []
            for d in remaining:
                got = report["fetched"].get(d)
                ended = pd.Timestamp(d, tz="UTC") + pd.Timedelta(days=1) <= now
                if got is None or (ended and not got["final"]):
                    still.append(d)
            if len(still) == len(remaining) and source not in by_source:
                by_source[source] = "no rows for the requested days"
            remaining = still
        if report["fetched"]:
            srcs = sorted({v["source"] for v in report["fetched"].values()})
            log(f"[data] fetched {len(report['fetched'])} day(s) from {', '.join(srcs)}")
        missing = [d for d in remaining if d not in report["fetched"]]
        if missing:
            report["errors"] = {"missing_days": missing, "by_source": by_source}
            log(f"[data] MISSING {missing}: {by_source}")
        elif remaining:
            report["errors"] = {"incomplete_days": remaining, "by_source": by_source}
        return report


def _consecutive(days: list[str]) -> list[list[str]]:
    groups, cur = [], []
    for d in days:
        if cur and pd.Timestamp(d) - pd.Timestamp(cur[-1]) != pd.Timedelta(days=1):
            groups.append(cur)
            cur = []
        cur.append(d)
    if cur:
        groups.append(cur)
    return groups


def import_csv(cfg: Config, path: Path, source: str = "manual") -> list[str]:
    """Import bars from a CSV with a ts/open_time column (ISO or epoch ms) into the cache."""
    raw = pd.read_csv(path)
    tcol = next(c for c in ("ts", "open_time", "timestamp", "time", "date") if c in raw.columns)
    t = raw.pop(tcol)
    idx = pd.to_datetime(t, unit="ms", utc=True) if pd.api.types.is_numeric_dtype(t) else pd.to_datetime(t, utc=True)
    raw.index = idx
    for c in COLUMNS:
        if c not in raw:
            raw[c] = np.nan
    df = raw[COLUMNS].sort_index()
    store = Store(cfg)
    days = sorted(set(df.index.strftime("%Y-%m-%d")))
    for d in days:
        lo = pd.Timestamp(d, tz="UTC")
        part = df[(df.index >= lo) & (df.index < lo + pd.Timedelta(days=1))]
        store.save_day(d, part, source, final=len(part) >= store.bars_per_day)
    return days
