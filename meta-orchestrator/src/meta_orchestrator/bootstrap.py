"""Wire up a Store with seed data (taxonomy + Registry) and hand back a Registry.

This is the composition root for Milestone A: it proves the project "boots,
connects to the DB, and model choice is read from config via the Registry" (A1).
"""
from __future__ import annotations

from .config import OrchestratorConfig, load_config, seed_registry_models
from .persistence.sqlite_store import SqliteStore
from .persistence.store import Store
from .registry.registry import ModelRegistry
from .taxonomy import SEED_TAXONOMY


def seed_store(store: Store, config: OrchestratorConfig) -> ModelRegistry:
    """Populate taxonomy + Registry into an already-connected store."""
    for node in SEED_TAXONOMY:
        store.upsert_taxonomy(node)
    registry = ModelRegistry(store, config)
    for spec in seed_registry_models():
        registry.register(spec)
    return registry


def boot(config: OrchestratorConfig | None = None) -> tuple[Store, ModelRegistry, OrchestratorConfig]:
    """Connect a fresh store, seed it, and return (store, registry, config)."""
    config = config or load_config()
    store = SqliteStore(config.db_path)
    store.connect()
    store.init_schema()
    registry = seed_store(store, config)
    return store, registry, config
