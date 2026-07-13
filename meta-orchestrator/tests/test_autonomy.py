"""D1: autonomy modes (switchable) + budget circuit breaker."""
from __future__ import annotations

from meta_orchestrator.autonomy.budget import BudgetLedger
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import get_case


def _orch(booted) -> Orchestrator:
    store, registry, config = booted
    return Orchestrator(store, registry, config)


def test_full_auto_runs_to_completion(booted):
    orch = _orch(booted)
    out = orch.run(get_case("off_by_one_sum"), run_id="fa")
    assert out.status == "completed"


def test_plan_first_blocks_without_approval(booted):
    orch = _orch(booted)
    orch.controller.set_mode("plan-first")           # switch mode
    out = orch.run(get_case("off_by_one_sum"), run_id="pf-no")
    assert out.status == "aborted_plan"
    assert out.passed is False


def test_plan_first_proceeds_with_approval(booted):
    orch = _orch(booted)
    orch.controller.set_mode("plan-first")
    out = orch.run(get_case("off_by_one_sum"), run_id="pf-yes",
                   approver=lambda name, args: True)
    assert out.status == "completed"


def test_mode_switch_is_effective_mid_flight(booted):
    orch = _orch(booted)
    # An approver that flips the controller to full-auto the first time it is consulted.
    def flip(name, args):
        orch.controller.set_mode("full-auto")
        return True
    orch.controller.set_mode("plan-first")
    out = orch.run(get_case("off_by_one_sum"), run_id="switch", approver=flip)
    assert out.status == "completed"
    assert orch.controller.mode.value == "full-auto"


def test_ask_on_expensive_requires_approval(booted):
    orch = _orch(booted)
    orch.controller.set_mode("ask-on-expensive")
    orch.controller.expensive_cost_threshold = 0.0   # everything counts as expensive
    denied = orch.run(get_case("off_by_one_sum"), run_id="ax-no", approver=lambda n, a: False)
    assert denied.status == "aborted_cost"
    approved = orch.run(get_case("off_by_one_sum"), run_id="ax-yes", approver=lambda n, a: True)
    assert approved.status == "completed"


def test_budget_circuit_breaker_stops_the_run(booted):
    orch = _orch(booted)
    tiny = BudgetLedger(total_tokens=5, max_rounds=6)  # can't afford one round
    out = orch.run(get_case("off_by_one_sum"), run_id="bud", ledger=tiny)
    assert out.status == "aborted_budget"
    assert out.passed is False
    assert tiny.spent_tokens == 0                      # nothing was spent
