"""Canonical fold cost projection — frozen worst-case + planning scenarios (all $0, offline)."""
from __future__ import annotations

import os
from decimal import Decimal

import pytest

from meta_orchestrator.experiment.s2.budget_projection import (GATE_RESERVE_FRACTION,
                                                               project_fold_cost)
from meta_orchestrator.experiment.s2.contract_s2 import S2_MAX_TOKENS
from meta_orchestrator.experiment.s2.evidence import verify_budget_evidence
from meta_orchestrator.experiment.s2.pricing import call_cost_usd, load_frozen_pricing

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")
R1 = [1000, 2000]
R2 = [3000, 4000]


def _pricing():
    return load_frozen_pricing(_CORPUS)


def _expected_worst(pricing) -> Decimal:
    out = S2_MAX_TOKENS
    return sum((call_cost_usd(pricing, input_tokens=t, output_tokens=out) for t in R1 + R2),
               Decimal(0))


def test_worst_case_matches_hand_computation():
    pricing = _pricing()
    proj = project_fold_cost(pricing, fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    expected = _expected_worst(pricing)
    assert Decimal(proj.worst_fold_cost_usd) == expected
    assert Decimal(proj.worst_fold_cost_with_reserve_usd) == expected * Decimal("1.25")
    # max single-call exposure = the largest input at full output
    biggest = call_cost_usd(pricing, input_tokens=max(R1 + R2), output_tokens=S2_MAX_TOKENS)
    assert Decimal(proj.max_single_call_exposure_usd) == biggest


def test_reserve_is_25_percent_and_meets_gate_floor():
    assert GATE_RESERVE_FRACTION == Decimal("0.25")            # >= the 20% runbook floor
    proj = project_fold_cost(_pricing(), fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    ev = proj.to_budget_evidence(available_budget_usd="4.89")
    assert verify_budget_evidence(ev).ok                       # 0.25 reserve is not below 20%


def test_fits_budget_boundary():
    pricing = _pricing()
    proj = project_fold_cost(pricing, fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    worst_reserved = Decimal(proj.worst_fold_cost_with_reserve_usd)
    assert proj.fits_budget(str(worst_reserved))              # exactly fits
    assert proj.fits_budget("4.89")                           # comfortably fits
    assert not proj.fits_budget(str(worst_reserved - Decimal("0.0001")))   # a hair short → NO


def test_to_budget_evidence_reproduces_worst_times_reserve():
    """The gate re-applies the reserve, so evidence.need == worst × 1.25 (no double count)."""
    pricing = _pricing()
    proj = project_fold_cost(pricing, fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    ev = proj.to_budget_evidence(available_budget_usd="4.89")
    need = Decimal(str(ev.projected_fold_cost)) * (Decimal(1) + Decimal(str(ev.reserve_fraction)))
    assert abs(need - Decimal(proj.worst_fold_cost_with_reserve_usd)) < Decimal("1e-9")


def test_planning_scenarios_are_transparency_only_and_ordered():
    proj = project_fold_cost(_pricing(), fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    by = {s.label: Decimal(s.projected_cost_usd) for s in proj.planning_scenarios}
    assert set(by) == {"r2_0pct", "r2_50pct", "r2_100pct"}
    assert by["r2_0pct"] < by["r2_50pct"] < by["r2_100pct"]   # more Round 2 → costs more
    # nothing is labelled "expected"
    assert all("expected" not in s.label for s in proj.planning_scenarios)
    # the 100%-R2 full-output planning scenario equals the gate-binding worst case
    assert by["r2_100pct"] == Decimal(proj.worst_fold_cost_usd)


def test_input_length_mismatch_and_empty_are_errors():
    with pytest.raises(ValueError):
        project_fold_cost(_pricing(), fold=1, r1_input_tokens=[1, 2], r2_input_tokens=[1])
    with pytest.raises(ValueError):
        project_fold_cost(_pricing(), fold=1, r1_input_tokens=[], r2_input_tokens=[])


def test_projection_is_deterministic():
    a = project_fold_cost(_pricing(), fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    b = project_fold_cost(_pricing(), fold=1, r1_input_tokens=R1, r2_input_tokens=R2)
    assert a.model_dump() == b.model_dump()                   # no float drift, byte-identical
