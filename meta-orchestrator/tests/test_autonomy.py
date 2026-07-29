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


# --- G2 regression: pre-flight cost must price input and output separately ---

def test_preflight_cost_prices_input_and_output_at_their_own_rates(booted):
    """G2: every token used to be billed at the priciest candidate's *output* rate.

    The gate's estimate must instead charge input tokens at ``price_per_1k_in`` and
    output tokens at ``price_per_1k_out``, taking the worst candidate as a whole — so
    it equals a price some registered model would actually charge.
    """
    store, registry, config = booted
    orch = _orch(booted)
    case = get_case("off_by_one_sum")

    est_in, est_out = orch._estimate_io_tokens(case)
    assert est_in > 0 and est_out > 0, "the split must produce both halves"

    candidates = registry.candidate_models("Software:Debug")
    expected = max(est_in / 1000.0 * m.price_per_1k_in + est_out / 1000.0 * m.price_per_1k_out
                   for m in candidates)
    assert orch._worst_case_cost(est_in, est_out) == expected

    # The old formula billed the whole estimate at the max output rate. For any model
    # whose input is cheaper than its output — true of every registered model — the
    # corrected figure must be strictly lower, not merely different.
    max_out_rate = max(m.price_per_1k_out for m in candidates)
    old_formula = (est_in + est_out) / 1000.0 * max_out_rate
    assert orch._worst_case_cost(est_in, est_out) < old_formula


def test_preflight_cost_is_monotonic_in_both_halves(booted):
    """More input or more output may never lower the estimated cost."""
    orch = _orch(booted)
    base = orch._worst_case_cost(1000, 1000)
    assert orch._worst_case_cost(2000, 1000) > base
    assert orch._worst_case_cost(1000, 2000) > base


def test_ledger_is_charged_the_sum_of_both_halves(booted):
    """The token-denominated ledger still sees one round as input + output."""
    orch = _orch(booted)
    case = get_case("off_by_one_sum")
    est_in, est_out = orch._estimate_io_tokens(case)
    assert orch._estimate_tokens(case) == est_in + est_out
