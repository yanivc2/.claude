"""C: Model Gateway + mock adapter — deterministic competence, cost, fallback."""
from __future__ import annotations

import pytest

from meta_orchestrator.gateway.adapters import AdapterRequest, AdapterResponse, MockAdapter
from meta_orchestrator.gateway.gateway import ModelGateway, ModelUnavailableError
from meta_orchestrator.seed_task.corpus import get_case


def test_mock_competence_is_deterministic():
    ad = MockAdapter()
    case = get_case("off_by_one_sum")
    strong = ad.complete("mock-strong", {"kind": "code_fix", "case": case})
    weak = ad.complete("mock-weak", {"kind": "code_fix", "case": case})
    # strong solves off_by_one; weak does not (returns the unchanged, failing source)
    assert strong.content["candidate_source"] == case.reference_fix
    assert weak.content["candidate_source"] == case.module_source
    # deterministic across calls
    assert ad.complete("mock-strong", {"kind": "code_fix", "case": case}).content == strong.content


def test_gateway_computes_cost_from_registry(booted):
    _store, registry, _config = booted
    gw = ModelGateway(registry, MockAdapter())
    res = gw.run("mock-strong", {"kind": "code_fix", "case": get_case("off_by_one_sum")})
    assert res.model_used == "mock-strong"
    assert res.tokens > 0
    assert res.cost > 0  # priced via Registry


def test_gateway_falls_back_when_unavailable(booted):
    store, registry, _config = booted
    strong = registry.get("mock-strong")
    strong.availability = False           # strong down → fallback_model = mock-weak
    store.upsert_model(strong)
    gw = ModelGateway(registry, MockAdapter())
    res = gw.run("mock-strong", {"kind": "code_fix", "case": get_case("off_by_one_sum")})
    assert res.model_used == "mock-weak"  # SPEC §9 fallback


def test_experiment_mode_never_falls_back(booted):
    """v2 §5: a locked model that is down must FAIL LOUDLY, not silently swap."""
    store, registry, _config = booted
    strong = registry.get("mock-strong")
    strong.availability = False           # strong down — normal mode would use mock-weak
    store.upsert_model(strong)
    gw = ModelGateway(registry, MockAdapter(), experiment_mode=True)
    with pytest.raises(ModelUnavailableError):
        gw.run("mock-strong", {"kind": "code_fix", "case": get_case("off_by_one_sum")})


def test_gateway_passes_provider_snapshot_to_adapter(booted):
    """The exact provider snapshot (not the logical id) is what reaches the API layer."""
    store, registry, _config = booted
    strong = registry.get("mock-strong")
    strong.provider_model_snapshot = "mock-strong-20990101"  # a pinned build id
    store.upsert_model(strong)

    seen: dict[str, str | None] = {}

    class SpyAdapter:
        name = "spy"

        def complete(self, model_id: str, request: AdapterRequest,
                     provider_model: str | None = None) -> AdapterResponse:
            seen["model_id"] = model_id
            seen["provider_model"] = provider_model
            return AdapterResponse(content={"candidate_source": "x"}, tokens_in=1, tokens_out=1)

    gw = ModelGateway(registry, SpyAdapter())
    res = gw.run("mock-strong", {"kind": "code_fix", "case": get_case("off_by_one_sum")})
    assert seen["model_id"] == "mock-strong"                       # logical id for cost/bandit
    assert seen["provider_model"] == "mock-strong-20990101"        # exact snapshot to the API
    assert res.provider_model == "mock-strong-20990101"
