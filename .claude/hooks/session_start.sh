#!/usr/bin/env bash
# Make sure the Python deps exist in fresh cloud sessions (PyPI is reachable on
# the default network policy). Quiet and idempotent.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
python3 -c "import numpy, pandas, pytest" 2>/dev/null || python3 -m pip install -q -r requirements.txt >/dev/null 2>&1 || true
exit 0
