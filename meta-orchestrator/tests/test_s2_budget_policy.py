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


def test_frozen_paid_spend_ledger_loads_and_totals():
    from meta_orchestrator.experiment.s2.budget_policy import load_frozen_paid_spend
    led = load_frozen_paid_spend(_CORPUS)
    # $0.121801 diagnostic ($0.052343 prior + black-215 $0.069458 DEFECT_6, diagnostic-only) +
    # $0.238040 official ($0.023641 historical + final-sequence black-112 $0.012028 + black-130
    # $0.029330 + black-132 $0.029049 FAILED + black-141 $0.032788 SOLVED-leak + black-185 $0.037983
    # SOLVED+banked (first memory-bearing) + black-193 $0.038139 SOLVED+banked + black-215 RE-RUN
    # $0.035082 SOLVED+banked under the DEFECT-6-fixed apparatus). The prior black-215 DEFECT_6 run
    # stays diagnostic-only.
    assert led.total_paid_to_date() == Decimal("0.359841")
    assert Decimal(led.diagnostic_apparatus_spend_usd) == Decimal("0.121801")
    assert Decimal(led.official_training_spend_usd) == Decimal("0.238040")
    assert led.content_hash == led.compute_hash()


def test_tampered_paid_spend_ledger_blocks(tmp_path):
    from meta_orchestrator.experiment.s2.budget_policy import (FROZEN_PAID_SPEND_FILENAME,
                                                              PaidSpendLedger, load_frozen_paid_spend)
    led = PaidSpendLedger(diagnostic_apparatus_spend_usd="0.028822",
                          official_training_spend_usd="0").sealed()
    d = led.model_dump()
    d["diagnostic_apparatus_spend_usd"] = "0.00"               # hide the spend, keep the old hash
    (tmp_path / FROZEN_PAID_SPEND_FILENAME).write_text(json.dumps(d))
    with pytest.raises(GateError):
        load_frozen_paid_spend(str(tmp_path))


def test_lifetime_spend_plus_worst_binds_global_cap():
    # the GLOBAL cap binds (already-paid) + (projected worst+reserve), not the projection alone
    from meta_orchestrator.experiment.s2.budget_policy import load_frozen_paid_spend
    led = load_frozen_paid_spend(_CORPUS)
    projected = Decimal("45.99675")
    lifetime = led.total_paid_to_date() + projected
    assert lifetime == Decimal("46.356591")
    assert lifetime <= Decimal("50.00")                        # fits the $50 lifetime cap


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
