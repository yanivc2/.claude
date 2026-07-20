"""Frozen budget policy (approved caps) + whole-experiment worst-case projection ($0, offline)."""
from __future__ import annotations

import json
import os
from decimal import Decimal

import pytest

from meta_orchestrator.experiment.s2.budget_policy import (BUDGET_POLICY_VERSION,
                                                           FROZEN_BUDGET_POLICY_FILENAME,
                                                           ReportedCredits, build_budget_policy,
                                                           load_frozen_budget_policy)
from meta_orchestrator.experiment.s2.budget_projection import (EXPERIMENT_WORST_MULTIPLIER,
                                                               project_experiment_worst)
from meta_orchestrator.experiment.s2.gates import GateError
from meta_orchestrator.experiment.s2.pricing import load_frozen_pricing

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def test_frozen_policy_loads_with_approved_caps():
    pol = load_frozen_budget_policy(_CORPUS)
    assert pol.policy_version == BUDGET_POLICY_VERSION
    assert pol.fold1_cap() == Decimal("10.00")
    assert pol.global_cap() == Decimal("50.00")               # raised for calibrated max_tokens=11264
    assert pol.content_hash == pol.compute_hash()             # self-consistent seal


def test_tampered_cap_breaks_the_hash_and_blocks(tmp_path):
    pol = build_budget_policy(fold1_hard_cap_usd="10.00", global_hard_cap_usd="30.00",
                              approved_at="2026-07-19")
    d = pol.model_dump()
    d["fold1_hard_cap_usd"] = "25.00"                          # raise the cap, keep the old hash
    (tmp_path / FROZEN_BUDGET_POLICY_FILENAME).write_text(json.dumps(d))
    with pytest.raises(GateError):
        load_frozen_budget_policy(str(tmp_path))              # hash mismatch → void


def test_reported_credits_are_not_a_cap():
    c = ReportedCredits(available_api_credits_usd="4.75", verified_at="2026-07-19")
    assert c.is_budget_cap is False and c.machine_verified is False
    assert c.amount() == Decimal("4.75")


def test_experiment_projection_uses_frozen_8x_structure_and_fits_global_cap():
    pricing = load_frozen_pricing(_CORPUS)
    # a small stand-in corpus; the point is the 8× structure + Decimal arithmetic
    r1 = [10_000] * 27
    r2 = [20_000] * 27
    exp = project_experiment_worst(pricing, r1_input_tokens=r1, r2_input_tokens=r2)
    assert exp.worst_multiplier == EXPERIMENT_WORST_MULTIPLIER == 8
    # experiment_worst == 8 · Σ(full_cost(r1)+full_cost(r2))
    from meta_orchestrator.experiment.s2.pricing import call_cost_usd
    from meta_orchestrator.experiment.s2.contract_s2 import S2_MAX_TOKENS
    s = sum((call_cost_usd(pricing, input_tokens=a, output_tokens=S2_MAX_TOKENS)
             + call_cost_usd(pricing, input_tokens=b, output_tokens=S2_MAX_TOKENS)) for a, b in zip(r1, r2))
    assert Decimal(exp.experiment_worst_usd) == Decimal(8) * s
    assert Decimal(exp.experiment_worst_with_reserve_usd) == Decimal(8) * s * Decimal("1.25")
    assert exp.fits_global_cap("45.00") == (Decimal(exp.experiment_worst_with_reserve_usd)
                                            <= Decimal("45.00"))
