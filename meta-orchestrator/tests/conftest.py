from __future__ import annotations

import pytest

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.config import load_config


@pytest.fixture()
def booted():
    """A fresh in-memory, seeded system: (store, registry, config).

    Pins the offline ``mock`` adapter explicitly so these unit tests are deterministic and
    independent of the ambient ``META_ORCH_ADAPTER`` (the pinned pilot env sets it to
    ``anthropic`` for the real run). This seeds ONLY the mock models and touches no network;
    the production ``anthropic`` seeding is asserted separately in ``tests/test_boot.py``.
    Each test gets its own ``:memory:`` store, closed on teardown — no state leaks between tests.
    """
    config = load_config(db_path=":memory:", adapter="mock")
    store, registry, config = boot(config)
    try:
        yield store, registry, config
    finally:
        store.close()
