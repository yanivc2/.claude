"""Pilot gate production logic — the SAME functions the scripts and the real run use.

Pure, offline. Proves: Gate 1 / Gate 2 pass only on production-valid (real-count) inputs; offline/
proxy can NEVER authorize or pass; manifest transitions are append-only + reject illegal moves;
artifacts hold no secrets.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.s2 import (AUTHORIZED_FOLD1, BLOCKED, UNAUTHORIZED, Gate1Inputs,
                                             Gate2Inputs, GateError, RunManifest, assert_no_secrets,
                                             authorize_after_gate1, build_run_manifest,
                                             gate1_evaluate, gate2_evaluate, gate2_passed_status,
                                             record_gate2_pass)

REAL = "anthropic_count_tokens"
PROXY = "offline_proxy"


def _gate1_good(**over):
    base = dict(tests_failed=0, tests_skipped=0, sdk_version="0.40.0", httpx_version="0.27.0",
                serialized_body_ok=True, max_retries_zero_proven=True, context_cap_source=REAL,
                context_cap_fits_budget=True, all_hashes_match=True, snapshot_available=True,
                snapshot_within_retirement=True)
    base.update(over)
    return Gate1Inputs(**base)


def _gate2_good(**over):
    base = dict(fold=1, train_terminal_count=18, train_total=18, bank_frozen=True,
                bank_fold_correct=True, held_out_calls_made=0, b1_source=REAL,
                b1_bound_to_bank=True, b1_bound_to_builder=True, all_held_out_fit_cap=True,
                budget_sufficient_for_block=True, b1_qualifying_mapping_found=True)
    base.update(over)
    return Gate2Inputs(**base)


# --- Gate 1 -------------------------------------------------------------------------------
def test_gate1_passes_on_real_valid_inputs():
    r = gate1_evaluate(_gate1_good())
    assert r.passed and r.production_valid and r.reasons == []


def test_gate1_proxy_cap_never_production_valid():
    r = gate1_evaluate(_gate1_good(context_cap_source=PROXY))
    assert not r.passed and not r.production_valid
    assert "context_cap_not_from_anthropic_count_tokens" in r.reasons


@pytest.mark.parametrize("over,reason", [
    ({"tests_skipped": 1}, "tests_skipped"),
    ({"tests_failed": 1}, "tests_failed"),
    ({"serialized_body_ok": False}, "serialized_body_not_proven"),
    ({"max_retries_zero_proven": False}, "max_retries_not_proven"),
    ({"context_cap_fits_budget": False}, "cost_projection_over_budget"),
    ({"snapshot_within_retirement": False}, "snapshot_past_retirement"),
    ({"sdk_version": ""}, "unpinned_sdk_or_httpx"),
])
def test_gate1_blocks_on_each_condition(over, reason):
    assert reason in gate1_evaluate(_gate1_good(**over)).reasons


# --- Gate 2 -------------------------------------------------------------------------------
def test_gate2_passes_on_real_valid_inputs():
    r = gate2_evaluate(_gate2_good())
    assert r.passed and r.production_valid and r.reasons == []


@pytest.mark.parametrize("over,reason", [
    ({"train_terminal_count": 15}, "training_incomplete"),
    ({"held_out_calls_made": 1}, "held_out_already_started"),
    ({"b1_qualifying_mapping_found": False}, "no_qualifying_b1_derangement"),
    ({"b1_source": PROXY}, "b1_not_from_anthropic_count_tokens"),
    ({"b1_bound_to_bank": False}, "b1_not_bound_to_bank"),
    ({"all_held_out_fit_cap": False}, "held_out_request_over_context_cap"),
    ({"budget_sufficient_for_block": False}, "insufficient_budget_for_held_out_block"),
])
def test_gate2_blocks_on_each_condition(over, reason):
    assert reason in gate2_evaluate(_gate2_good(**over)).reasons


# --- offline / proxy can never authorize --------------------------------------------------
def test_offline_gate1_cannot_authorize():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    with pytest.raises(GateError):
        authorize_after_gate1(m, gate1_evaluate(_gate1_good(context_cap_source=PROXY)),
                              timestamp="t")
    assert m.status == UNAUTHORIZED


def test_real_gate1_authorizes_and_transitions():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    authorize_after_gate1(m, gate1_evaluate(_gate1_good()), timestamp="2026-07-19T00:00:00Z")
    assert m.status == AUTHORIZED_FOLD1
    assert m.transitions[-1].to_status == AUTHORIZED_FOLD1
    assert m.transitions[-1].timestamp == "2026-07-19T00:00:00Z"
    assert m.transitions[-1].artifact_hash                       # hash-locked


def test_proxy_gate2_cannot_pass():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    m.status = AUTHORIZED_FOLD1
    with pytest.raises(GateError):
        record_gate2_pass(m, gate2_evaluate(_gate2_good(b1_source=PROXY)), fold=1, timestamp="t")
    assert m.status == AUTHORIZED_FOLD1


def test_real_gate2_passes_and_transitions():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    m.status = AUTHORIZED_FOLD1
    record_gate2_pass(m, gate2_evaluate(_gate2_good()), fold=1, timestamp="t")
    assert m.status == gate2_passed_status(1)


# --- append-only + illegal transitions ---------------------------------------------------
def test_illegal_transition_is_rejected():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    with pytest.raises(GateError):                               # cannot jump straight to GATE2
        m.apply_transition(gate2_passed_status(1), reason="x", timestamp="t", artifact_hash="h")


def test_transitions_are_append_only():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    m.apply_transition(AUTHORIZED_FOLD1, reason="gate1", timestamp="t1", artifact_hash="h1")
    m.apply_transition(BLOCKED, reason="budget", timestamp="t2", artifact_hash="h2")
    assert [t.to_status for t in m.transitions] == [AUTHORIZED_FOLD1, BLOCKED]
    assert m.transitions[0].from_status == UNAUTHORIZED           # history preserved, not edited
    # BLOCKED is terminal
    with pytest.raises(GateError):
        m.apply_transition(AUTHORIZED_FOLD1, reason="x", timestamp="t3", artifact_hash="h3")


# --- no secrets in artifacts --------------------------------------------------------------
def test_assert_no_secrets_blocks_a_key():
    m = build_run_manifest("r", "c", budget_usd=4.89)
    m.hashes["leak"] = "sk-ant-abc123"                           # simulate an accidental key
    with pytest.raises(GateError):
        assert_no_secrets(m)


def test_clean_manifest_has_no_secrets():
    assert_no_secrets(build_run_manifest("r", "c", budget_usd=4.89))
