"""B6: Decision Engine v1 scores options, picks the best, honours the budget ceiling."""
from __future__ import annotations

import pytest

from meta_orchestrator.decision.engine import (
    BudgetExceededError,
    DecisionEngine,
    Option,
    build_model_options,
)
from meta_orchestrator.models import ModelSpec

WEIGHTS = {"w_success": 1.0, "w_cost": 0.15, "w_risk": 0.30}


def test_picks_highest_utility():
    eng = DecisionEngine(WEIGHTS)
    a = Option(label="a", p_success=0.8, cost=0.2, risk=0.0)
    b = Option(label="b", p_success=0.5, cost=0.1, risk=0.0)
    winner, scored, record = eng.decide([a, b], run_id="r1", node="select_model")
    assert winner.option.label == "a"
    assert record.chosen == "a"
    assert len(record.alternatives) == 2
    assert scored[0].utility >= scored[1].utility


def test_cost_and_risk_can_flip_the_winner():
    eng = DecisionEngine({"w_success": 1.0, "w_cost": 0.15, "w_risk": 2.0})
    safe = Option(label="safe", p_success=0.70, cost=0.1, risk=0.0)
    risky = Option(label="risky", p_success=0.75, cost=0.1, risk=0.5)  # high risk penalised hard
    winner, _, _ = eng.decide([safe, risky], run_id="r", node="n")
    assert winner.option.label == "safe"


def test_budget_ceiling_filters_expensive_options():
    eng = DecisionEngine(WEIGHTS)
    cheap = Option(label="cheap", p_success=0.6, est_tokens=100)
    pricey = Option(label="pricey", p_success=0.99, est_tokens=10_000)
    winner, _, _ = eng.decide([cheap, pricey], run_id="r", node="n", budget_remaining=500)
    assert winner.option.label == "cheap"  # pricey filtered despite higher p_success


def test_budget_exceeded_raises_when_nothing_affordable():
    eng = DecisionEngine(WEIGHTS)
    o = Option(label="x", p_success=0.9, est_tokens=10_000)
    with pytest.raises(BudgetExceededError):
        eng.decide([o], run_id="r", node="n", budget_remaining=100)


def test_build_model_options_normalises_cost():
    strong = ModelSpec(model_id="mock-strong", provider="mock", price_per_1k_out=0.015)
    weak = ModelSpec(model_id="mock-weak", provider="mock", price_per_1k_out=0.0015)
    opts = {o.label: o for o in build_model_options([strong, weak],
                                                    {"mock-strong": 0.8, "mock-weak": 0.45})}
    assert opts["mock-strong"].cost == 1.0          # most expensive → 1.0
    assert opts["mock-weak"].cost == pytest.approx(0.1)
    assert opts["mock-strong"].p_success == 0.8
