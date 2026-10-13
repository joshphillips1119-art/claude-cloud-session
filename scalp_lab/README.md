# scalp_lab

Daily self-improvement loop for 5-minute BTC/ETH/SOL direction calls.

    python3 scalp_lab/improve.py            # reviews yesterday (UTC)
    python3 scalp_lab/improve.py --day 2026-10-12

It needs only the Python standard library and uses public Binance klines
(data-api.binance.vision). Each run writes `reports/<day>.md` and updates
`state/scores.json`. Read `PLAYBOOK.md` for the current rules.

Each daily routine run: run the script, read the report, add one or two new
candidate rules to `STRATEGIES`, record the changes in `PLAYBOOK.md`'s
changelog, then commit.
