from __future__ import annotations

import pytest

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.config import load_config


@pytest.fixture()
def booted():
    """A fresh in-memory, seeded system: (store, registry, config)."""
    config = load_config(db_path=":memory:")
    store, registry, config = boot(config)
    try:
        yield store, registry, config
    finally:
        store.close()
