"""The routine drives the system through the CLI, so exercise it end to end."""
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def run(tmp, *args):
    env = {**os.environ, "SCALPER_ROOT": str(tmp), "PYTHONPATH": str(REPO)}
    return subprocess.run([sys.executable, "-m", "scalper", *args], cwd=tmp, env=env,
                          capture_output=True, text=True, timeout=600)


def test_daily_cycle_end_to_end(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({
        "symbol": "SYNTH", "lookback_days": 6, "validation_days": 2, "warmup_days": 1, "min_signals": 80}))
    assert run(tmp_path, "synth", "--days", "12", "--phi", "0.15", "--symbol", "SYNTH").returncode == 0
    assert run(tmp_path, "init").returncode == 0

    r = run(tmp_path, "daily", "--date", "2026-09-10", "--no-fetch")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["status"] == "OK" and out["state_version"] == 1
    journal = (tmp_path / "journal" / "2026-09-10.md").read_text()
    assert "Yesterday's market" in journal and "out-of-sample" in journal
    assert (tmp_path / "state" / "history" / "params-before-2026-09-10.json").exists()

    again = run(tmp_path, "daily", "--date", "2026-09-10", "--no-fetch")
    assert "already ran" in again.stdout
    forced = run(tmp_path, "daily", "--date", "2026-09-10", "--no-fetch", "--force")
    assert json.loads(forced.stdout)["state_version"] == 1, "a forced redo restarts from the snapshot"

    r2 = run(tmp_path, "daily", "--date", "2026-09-11", "--no-fetch")
    assert json.loads(r2.stdout)["state_version"] == 2
    board = (tmp_path / "state" / "scoreboard.jsonl").read_text().splitlines()
    assert [json.loads(x)["date"] for x in board] == ["2026-09-10", "2026-09-11"]

    st = json.loads(run(tmp_path, "status").stdout)
    assert st["version"] == 2 and len(st["last_days"]) == 2


def test_data_unavailable_exit_code(tmp_path):
    (tmp_path / "config.json").write_text(json.dumps({"symbol": "NONE"}))
    r = run(tmp_path, "daily", "--date", "2026-09-10", "--no-fetch")
    assert r.returncode == 2
    assert json.loads(r.stdout)["status"] == "DATA_UNAVAILABLE"
