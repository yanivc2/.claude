"""A1 end-to-end: the system boots, connects to the DB, seeds taxonomy + Registry."""
from __future__ import annotations

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.config import load_config
from meta_orchestrator.taxonomy import SEED_TASK_TYPE


def test_boot_seeds_taxonomy_and_registry(booted):
    store, registry, _config = booted
    labels = {n.label for n in store.list_taxonomy()}
    assert "Software" in labels
    assert "Software:Debug" in labels
    assert {"verifiable", "risk"} <= labels  # breadth dims present

    models = {m.model_id for m in registry.all()}
    assert {"mock-strong", "mock-weak"} <= models


def test_boot_resolves_model_choice_via_config_and_registry(booted):
    _store, registry, config = booted
    candidates = registry.candidate_models(SEED_TASK_TYPE)
    assert [m.model_id for m in candidates] == config.candidate_models[SEED_TASK_TYPE]
    # every candidate carries provenance-backed prior score
    for m in candidates:
        assert registry.prior_score(m.model_id, SEED_TASK_TYPE) is not None


def test_production_anthropic_boot_seeds_real_models_and_no_mocks():
    """Production contract (post-f3d2e1f): the ``anthropic`` adapter seeds the real frozen
    Claude snapshots and NEVER the mock models. This is the negative assertion that a real
    run cannot silently pick up ``mock-strong`` / ``mock-weak`` from the registry seed."""
    store, registry, _config = boot(load_config(db_path=":memory:", adapter="anthropic"))
    try:
        models = {m.model_id for m in registry.all()}
        assert {"claude-opus-4-8", "claude-haiku-4-5"} <= models     # real snapshots seeded
        assert not ({"mock-strong", "mock-weak"} & models)           # negative: no mocks seeded
    finally:
        store.close()


def test_booted_fixture_is_mock_only_and_isolated(booted):
    """The offline fixture seeds ONLY the mock models (deterministic, env-independent) and
    shares no state with an independently-booted system — proving per-test cleanup / no leak."""
    _store, registry, _config = booted
    ids = {m.model_id for m in registry.all()}
    assert {"mock-strong", "mock-weak"} <= ids
    assert not ({"claude-opus-4-8", "claude-haiku-4-5"} & ids)       # no real-model leak
    assert registry.get("mock-strong").availability is True

    # A separate boot mutating its OWN store must not affect this fixture's registry.
    other_store, other_registry, _ = boot(load_config(db_path=":memory:", adapter="mock"))
    try:
        spec = other_registry.get("mock-strong")
        spec.availability = False
        other_store.upsert_model(spec)
        assert other_registry.get("mock-strong").availability is False
    finally:
        other_store.close()
    assert registry.get("mock-strong").availability is True          # unaffected → isolated
