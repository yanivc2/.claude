"""A1 end-to-end: the system boots, connects to the DB, seeds taxonomy + Registry."""
from __future__ import annotations

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
