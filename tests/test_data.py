import json

import pandas as pd

from scalper import data as D
from scalper.config import Config

T0 = 1791244800000  # 2026-10-06T00:00:00Z


def test_parse_binance():
    rows = [[T0, "100", "101", "99", "100.5", "10", T0 + 299999, "1000", 42, "6", "600", "0"],
            [T0 + 300000, "100.5", "102", "100", "101", "12", T0 + 599999, "1200", 50, "5", "500", "0"]]
    df = D.parse_binance(rows)
    assert list(df.index) == [pd.Timestamp("2026-10-06T00:00Z"), pd.Timestamp("2026-10-06T00:05Z")]
    assert df["close"].tolist() == [100.5, 101.0]
    assert df["taker_buy_volume"].tolist() == [6.0, 5.0]
    assert df["trades"].tolist() == [42, 50]


def test_parse_bybit_newest_first():
    payload = {"retCode": 0, "result": {"list": [
        [str(T0 + 300000), "2", "3", "1", "2.5", "7", "0"], [str(T0), "1", "2", "0.5", "2", "5", "0"]]}}
    df = D.parse_bybit(payload)
    assert df.index.is_monotonic_increasing and df["close"].tolist() == [2.0, 2.5]


def test_parse_okx_coinbase_kraken_yahoo():
    okx = {"code": "0", "data": [[str(T0), "1", "2", "0.5", "1.5", "9", "0", "0", "1"]]}
    assert D.parse_okx(okx)["volume"].iloc[0] == 9.0
    cb = [[T0 // 1000, 0.5, 2, 1, 1.5, 9]]  # time, low, high, open, close, volume
    row = D.parse_coinbase(cb).iloc[0]
    assert (row["open"], row["high"], row["low"], row["close"]) == (1, 2, 0.5, 1.5)
    kr = {"error": [], "result": {"XXBTZUSD": [[T0 // 1000, "1", "2", "0.5", "1.5", "1.2", "9", 33]], "last": 1}}
    k = D.parse_kraken(kr).iloc[0]
    assert k["volume"] == 9.0 and k["trades"] == 33
    yh = {"chart": {"error": None, "result": [{"timestamp": [T0 // 1000],
          "indicators": {"quote": [{"open": [1], "high": [2], "low": [0.5], "close": [1.5], "volume": [9]}]}}]}}
    assert D.parse_yahoo(yh)["close"].iloc[0] == 1.5


def test_store_roundtrip_and_manifest(tmp_path, bars):
    cfg = Config(symbol="TEST")
    st = D.Store(cfg, root=tmp_path)
    day = bars.index[0].strftime("%Y-%m-%d")
    part = bars[bars.index < bars.index[0] + pd.Timedelta(days=1)]
    st.save_day(day, part, "synthetic", True)
    back = D.Store(cfg, root=tmp_path).load(day, day)
    pd.testing.assert_frame_equal(back, part[D.COLUMNS], check_freq=False, rtol=1e-12)
    assert json.loads(st.manifest_path.read_text())[day] == {"rows": 288, "source": "synthetic", "final": True}


def test_ensure_falls_back_and_reports(tmp_path, monkeypatch, bars):
    cfg = Config(symbol="TEST", sources=["binance", "coinbase"])
    calls = []

    def fake_fetch(source, symbol, start, end, minutes=5):
        calls.append(source)
        if source == "binance":
            raise RuntimeError("HTTP 451 geo-blocked")
        return bars[(bars.index >= start) & (bars.index < end)]

    monkeypatch.setattr(D, "fetch", fake_fetch)
    st = D.Store(cfg, root=tmp_path)
    days = ["2026-09-01", "2026-09-02"]
    rep = st.ensure(days, now=pd.Timestamp("2026-09-10", tz="UTC"), log=lambda *_: None)
    assert calls == ["binance", "coinbase"]
    assert set(rep["fetched"]) == set(days) and all(v["source"] == "coinbase" for v in rep["fetched"].values())
    assert st.is_final("2026-09-01")
    calls.clear()
    st.ensure(days, now=pd.Timestamp("2026-09-10", tz="UTC"), log=lambda *_: None)
    assert calls == [], "final days must come from cache"


def test_ensure_all_sources_fail(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("403 blocked by proxy")
    monkeypatch.setattr(D, "fetch", boom)
    st = D.Store(Config(symbol="TEST", sources=["binance", "okx"]), root=tmp_path)
    rep = st.ensure(["2026-09-01"], now=pd.Timestamp("2026-09-10", tz="UTC"), log=lambda *_: None)
    assert rep["fetched"] == {} and rep["errors"]["missing_days"] == ["2026-09-01"]
    assert "403" in rep["errors"]["by_source"]["binance"] and "okx" in rep["errors"]["by_source"]


def test_partial_day_not_final(tmp_path, monkeypatch, bars):
    monkeypatch.setattr(D, "fetch", lambda s, sym, a, b, m=5: bars[(bars.index >= a) & (bars.index < b)])
    st = D.Store(Config(symbol="TEST", sources=["binance"]), root=tmp_path)
    st.ensure(["2026-09-02"], now=pd.Timestamp("2026-09-02T06:00Z"), log=lambda *_: None)
    assert not st.is_final("2026-09-02")
    assert st.manifest["2026-09-02"]["rows"] == 72


def test_import_csv(tmp_path, monkeypatch, bars):
    import scalper.data as mod
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    p = tmp_path / "in.csv"
    out = bars.iloc[:300].copy()
    out.index = out.index.strftime("%Y-%m-%dT%H:%M:%SZ")
    out.index.name = "open_time"
    out.to_csv(p)
    cfg = Config(symbol="IMP")
    days = D.import_csv(cfg, p)
    assert days == ["2026-09-01", "2026-09-02"]
    st = D.Store(cfg, root=tmp_path)
    assert st.is_final("2026-09-01") and not st.is_final("2026-09-02")


def test_partial_source_falls_through(tmp_path, monkeypatch, bars):
    """First source only has the most recent bars (like Kraken); the rest must come from the next one."""
    recent_from = pd.Timestamp("2026-09-03T12:00Z")

    def fake(source, symbol, start, end, minutes=5):
        sel = bars[(bars.index >= start) & (bars.index < end)]
        return sel[sel.index >= recent_from] if source == "kraken" else sel

    monkeypatch.setattr(D, "fetch", fake)
    st = D.Store(Config(symbol="TEST", sources=["kraken", "coinbase"]), root=tmp_path)
    days = ["2026-09-02", "2026-09-03", "2026-09-04"]
    rep = st.ensure(days, now=pd.Timestamp("2026-09-10", tz="UTC"), log=lambda *_: None)
    assert {d: v["source"] for d, v in rep["fetched"].items()} == {
        "2026-09-02": "coinbase", "2026-09-03": "coinbase", "2026-09-04": "kraken"}
    assert all(st.is_final(d) for d in days) and rep["errors"] == {}
