"""C: Model Gateway + mock adapter — deterministic competence, cost, fallback."""
from __future__ import annotations

from meta_orchestrator.gateway.adapters import MockAdapter
from meta_orchestrator.gateway.gateway import ModelGateway
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
