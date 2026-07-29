"""A1: model choice is read from config and resolved via the Registry (not hardcoded)."""
from __future__ import annotations

import pytest

from meta_orchestrator.models import EvalScore, ModelSpec
from meta_orchestrator.registry.registry import ModelRegistry, UnknownModelError
from meta_orchestrator.taxonomy import SEED_TASK_TYPE


def test_candidates_resolved_from_config(booted):
    _store, registry, config = booted
    candidates = registry.candidate_models(SEED_TASK_TYPE)
    ids = [m.model_id for m in candidates]
    # Exactly the ids declared in config.candidate_models — proving config drives selection.
    assert ids == config.candidate_models[SEED_TASK_TYPE]


def test_unregistered_configured_model_is_hard_error(booted):
    store, _registry, config = booted
    config.candidate_models["Software:Debug"] = ["does-not-exist"]
    registry = ModelRegistry(store, config)
    with pytest.raises(UnknownModelError):
        registry.candidate_models("Software:Debug")


def test_unavailable_models_filtered_out(booted):
    store, registry, _config = booted
    strong = registry.get("mock-strong")
    strong.availability = False
    store.upsert_model(strong)
    ids = [m.model_id for m in registry.candidate_models(SEED_TASK_TYPE)]
    assert "mock-strong" not in ids
    assert "mock-weak" in ids


def test_prior_score_from_provenance(booted):
    _store, registry, _config = booted
    assert registry.prior_score("mock-strong", SEED_TASK_TYPE) == 0.80
    assert registry.prior_score("mock-weak", SEED_TASK_TYPE) == 0.45


def test_record_eval_score_requires_registered_model(booted):
    _store, registry, _config = booted
    with pytest.raises(UnknownModelError):
        registry.record_eval_score("ghost", EvalScore(task_type=SEED_TASK_TYPE, score=1.0,
                                                       n_samples=1, date="2026-07-13", source="t"))
