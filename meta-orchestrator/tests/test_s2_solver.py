"""Bounded-attempt behaviours (acceptance criterion 7) through the REAL Sandbox + verifier.

Offline and model-free: scripted ``RoundSolver`` test-doubles drive the Decision-B loop; the
real composite verifier decides PASS/FAIL. No network, no API.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.s2 import (AttemptContract, FixOnRoundSolver, InvalidPatchSolver,
                                             MemorySensitiveRoundSolver, RoundOutput, RoundView,
                                             SEMANTIC_FAMILIES, SolverHarness,
                                             SolverOutcomesSealedError, build_synthetic_corpus,
                                             run_attempt, synthetic_task)
from meta_orchestrator.experiment.s2.report import fixture_playbook

REAL_27 = [
    "black-112", "black-130", "black-132", "black-133", "black-141", "black-1632", "black-183",
    "black-185", "black-193", "black-215", "black-224", "black-232", "black-234", "black-238",
    "black-273", "black-329", "black-334", "black-335", "black-385", "black-389", "black-593",
    "black-60", "black-74", "black-80", "black-95", "cookiecutter-18", "discord.py-7818",
]


def _mock_contract():
    return AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                         tool_definitions=AgentTools.NAMES, system_prompt_hash=prompt_hash("frozen"))


def _map(ids, fams=SEMANTIC_FAMILIES):
    return {tid: fams[i % len(fams)] for i, tid in enumerate(sorted(ids))}


def _small_map():
    # 2 families × 3 tasks so EVERY held-out family is also in train (no representation gap),
    # matching the real 27-task map's invariant. A gap would leave C empty and — correctly —
    # trip the B1 parity block, which is a fixture artefact, not the behaviour under test.
    return {f"t-{i}": ("whitespace" if i % 2 == 0 else "iterator") for i in range(6)}


# --- Decision-B loop mechanics -----------------------------------------------------------
def test_round1_success_stops_without_round2():
    t = synthetic_task("black-1", "whitespace")
    r = run_attempt(t, "A", [], FixOnRoundSolver(t, fix_round=1), _mock_contract(), AttemptContract())
    assert r.passed is True
    assert r.model_calls == 1 and r.rounds_used == 1
    assert r.round2_opened is False
    assert r.public_runs == 1 and r.hidden_verifications == 1


def test_public_failure_allows_exactly_one_round2():
    t = synthetic_task("black-1", "whitespace")
    solver = FixOnRoundSolver(t, fix_round=2)
    r = run_attempt(t, "A", [], solver, _mock_contract(), AttemptContract())
    assert r.passed is True
    assert r.model_calls == 2 and r.round2_opened is True
    assert r.public_pass_round1 is False
    assert r.public_runs == 2 and r.hidden_verifications == 1
    assert solver.rounds_seen == [1, 2]           # the solver was asked exactly twice


def test_no_fix_uses_both_rounds_then_hidden_verify_fails():
    t = synthetic_task("black-1", "whitespace")
    r = run_attempt(t, "A", [], FixOnRoundSolver(t, fix_round=None), _mock_contract(),
                    AttemptContract())
    assert r.passed is False and r.failing_gate == "public_tests"
    assert r.model_calls == 2 and r.hidden_verifications == 1


def test_hidden_verifier_runs_exactly_once():
    t = synthetic_task("black-1", "whitespace")
    for fix_round in (1, 2, None):
        r = run_attempt(t, "A", [], FixOnRoundSolver(t, fix_round=fix_round), _mock_contract(),
                        AttemptContract())
        assert r.hidden_verifications == 1


def test_invalid_patch_is_blocked_and_handled():
    t = synthetic_task("black-1", "whitespace")
    # Round 1 tries to write a protected test file; Round 2 applies the real fix.
    r = run_attempt(t, "A", [], InvalidPatchSolver(t, fix_round=2), _mock_contract(),
                    AttemptContract())
    assert r.blocked_attempts >= 1                # the out-of-scope write was audited
    assert r.passed is True                       # tampering was blocked, the real fix still lands
    assert r.round2_opened is True


def test_no_f2p_feedback_reaches_the_solver():
    """Round 2's feedback is the sanitized PUBLIC summary only — never hidden output/the verdict."""
    t = synthetic_task("black-1", "whitespace")
    solver = FixOnRoundSolver(t, fix_round=2)
    r = run_attempt(t, "A", [], solver, _mock_contract(), AttemptContract())
    assert r.f2p_feedback_leaked is False
    fb_round2 = solver.feedback_seen[1]
    assert fb_round2 is not None
    assert "tests_hidden" not in fb_round2 and "hidden" not in fb_round2.lower()


def test_caps_hold_for_a_greedy_solver():
    """Even a solver that patches every round cannot exceed 2 rounds / 2 patches / 2 public runs."""
    t = synthetic_task("black-1", "whitespace")

    class Greedy:
        name = "greedy"

        def solve_round(self, view: RoundView) -> RoundOutput:
            return RoundOutput(patch={"solution.py": "def x():\n    return 0\n"}, notes="always patch")

    r = run_attempt(t, "A", [], Greedy(), _mock_contract(), AttemptContract())
    assert r.model_calls <= 2 and r.public_runs <= 2 and r.patches_submitted <= 2
    assert r.hidden_verifications == 1


def test_feedback_is_length_capped():
    t = synthetic_task("black-1", "whitespace")
    solver = FixOnRoundSolver(t, fix_round=2)
    r = run_attempt(t, "A", [], solver, _mock_contract(),
                    AttemptContract(public_feedback_char_cap=10))
    fb = solver.feedback_seen[1]
    assert fb is not None and len(fb) <= 10


def test_provenance_records_all_frozen_hashes():
    t = synthetic_task("black-1", "whitespace")
    r = run_attempt(t, "C", ["@@MEM kind=family_relevant family=whitespace", "- edit"],
                    MemorySensitiveRoundSolver(t, "C"), _mock_contract(), AttemptContract())
    p = r.provenance
    for key in ("agent_contract_snapshot", "attempt_contract_hash", "verifier_config_hash",
                "exact_model_id", "provider", "memory_kind"):
        assert key in p and p[key]
    assert p["memory_kind"] == "family_relevant"


# --- SolverHarness: condition isolation, sealing, reset, resume --------------------------
def _harness(fmap):
    corpus = build_synthetic_corpus(fmap)
    return SolverHarness(fmap, corpus, _mock_contract(), fixture_playbook(),
                         lambda task, cond: MemorySensitiveRoundSolver(task, cond), k=3)


def test_only_memory_differs_c_passes_a_b1_d_fail():
    fmap = _small_map()
    h = _harness(fmap)
    h.run_fold(h.folds[0])
    h.outcomes.finalize()
    table = h.outcomes.effect_table()[0]
    # C (relevant family lesson) passes every held-out task; A/B1/D get no relevant lesson.
    assert all(v for v in table["C"].values())
    assert not any(table["A"].values())
    assert not any(table["B1"].values())
    assert not any(table["D"].values())


def test_effect_table_sealed_until_finalize():
    h = _harness(_small_map())
    h.run_fold(h.folds[0])
    with pytest.raises(SolverOutcomesSealedError):
        h.outcomes.effect_table()
    assert h.outcomes.cost_signals()["attempts"] > 0
    assert h.outcomes.harness_signals()["f2p_feedback_leaked"] is False
    h.outcomes.finalize()
    assert isinstance(h.outcomes.effect_table(), dict)


def test_resume_does_not_duplicate_attempts_or_calls():
    fmap = _small_map()
    corpus = build_synthetic_corpus(fmap)
    calls = {"n": 0}

    class SpySolver(MemorySensitiveRoundSolver):
        def solve_round(self, view):
            calls["n"] += 1
            return super().solve_round(view)

    h = SolverHarness(fmap, corpus, _mock_contract(), fixture_playbook(),
                      lambda task, cond: SpySolver(task, cond), k=3)
    h.run_fold(h.folds[0])
    n_attempts, n_calls = h.outcomes.cost_signals()["attempts"], calls["n"]
    h.run_fold(h.folds[0])                        # resume the same fold
    assert h.outcomes.cost_signals()["attempts"] == n_attempts
    assert calls["n"] == n_calls                  # no solver re-invocation → no doubled cost


def test_cross_fold_banks_are_independent():
    fmap = _map(REAL_27)
    h = _harness(fmap)
    banks = [h._learn_fold_bank(f) for f in h.folds]
    assert banks[0] is not banks[1]
    assert banks[0].families_present() and banks[1].families_present()
