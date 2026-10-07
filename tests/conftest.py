import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scalper.synthetic import generate  # noqa: E402


@pytest.fixture(scope="session")
def bars():
    """Twelve days of synthetic bars with mild structure (enough to warm up
    time-of-day profiles), shared across tests."""
    return generate(12, start="2026-09-01", seed=7, phi=0.1, flow_beta=0.1)
