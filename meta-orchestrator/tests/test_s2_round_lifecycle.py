"""Shared final-round lifecycle contract (DEFECT-6) — exercised against BOTH runners.

The ONE rule: once R2 opens it is the final round; R1's applied patch is NEVER the final graded state
(there is no silent fallback to R1). Each runner keeps its own verify policy — the paid real_canary
verifies iff a valid final patch exists (0 or 1); the offline run_attempt verifies EXACTLY ONCE on the
resolved final state — but neither may grade R1 after R2. The paid side is covered by the
``test_defect6_*`` cases in test_s2_real_canary.py (same shared resolver); here we unit-test the
resolver and prove the OFFLINE simulator grades the buggy pre-image (not R1's patch) after a terminal
R2, while preserving its "exactly one verify" contract.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.sandbox import Sandbox
from meta_orchestrator.experiment.s2 import solver as S
from meta_orchestrator.experiment.s2 import (AttemptContract, RoundOutput, run_attempt, synthetic_task)
from meta_orchestrator.experiment.s2.round_lifecycle import (GradedState, LifecycleViolation,
                                                           hidden_verify_allowed,
                                                           resolve_final_graded_state)
from meta_orchestrator.experiment.verifier import Verdict


# --- the shared resolver: the single source of truth both runners call ------------------------------
def test_resolver_single_round_success_is_r1_patch():
    st = resolve_final_graded_state(r2_opened=False, final_round_index=1, final_round_valid_applied=True)
    assert st == GradedState.R1_PATCH and hidden_verify_allowed(st) is True


def test_resolver_valid_r2_is_r2_patch():
    st = resolve_final_graded_state(r2_opened=True, final_round_index=2, final_round_valid_applied=True)
    assert st == GradedState.R2_PATCH and hidden_verify_allowed(st) is True


def test_resolver_failed_final_round_is_buggy():
    # R1 terminal failure (no R2)
    st1 = resolve_final_graded_state(r2_opened=False, final_round_index=1, final_round_valid_applied=False)
    # R2 terminal failure (after R1 applied then public-failed)
    st2 = resolve_final_graded_state(r2_opened=True, final_round_index=2, final_round_valid_applied=False)
    assert st1 == GradedState.BUGGY and st2 == GradedState.BUGGY
    assert hidden_verify_allowed(st1) is False and hidden_verify_allowed(st2) is False


def test_resolver_forbids_r1_patch_after_r2_opened():
    # the DEFECT-6 fallback: R1's patch resolved as final AFTER R2 opened must be impossible
    with pytest.raises(LifecycleViolation):
        resolve_final_graded_state(r2_opened=True, final_round_index=1, final_round_valid_applied=True)


# --- offline runner: grades the buggy pre-image (never R1) after a terminal R2 ----------------------
def _mock_contract():
    return AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                         tool_definitions=AgentTools.NAMES, system_prompt_hash=prompt_hash("frozen"))


class _Scripted:
    """R1/R2 each either apply the task's reference fix (dict) or nothing (None)."""
    name = "scripted-lifecycle"

    def __init__(self, task, r1, r2):
        self._fix = dict(task.reference_fix)
        self._r1, self._r2 = r1, r2

    def solve_round(self, view):
        want = self._r1 if view.round_index == 1 else self._r2
        return RoundOutput(patch=dict(self._fix) if want == "fix" else {}, claimed_done=(want == "fix"))


def _run_offline(monkeypatch, task, *, r1, r2, public_seq):
    """Drive run_attempt with scripted public statuses + a capturing verifier. Returns (result,
    graded_source): the exact source the single verify saw."""
    seq = list(public_seq)
    calls = {"i": 0}

    def fake_status(self, subdir, timeout_s=30):
        st = seq[min(calls["i"], len(seq) - 1)]; calls["i"] += 1
        return st, ("" if st == "PASS" else "public failed")
    monkeypatch.setattr(Sandbox, "run_pytest_status", fake_status)

    captured = {}
    verify_calls = {"n": 0}

    def fake_verify(t, sb):
        verify_calls["n"] += 1
        src = {p: sb.read(p) for p in t.source}
        captured.update(src)
        passed = src == dict(t.reference_fix)          # "hidden PASS iff the real fix is present"
        return Verdict(passed=passed, gates={}, failing_gate=None if passed else "hidden")
    monkeypatch.setattr(S, "verify", fake_verify)

    res = run_attempt(task, "A", [], _Scripted(task, r1, r2), _mock_contract(), AttemptContract())
    assert verify_calls["n"] == 1                       # offline "exactly one verify" contract preserved
    return res, dict(captured)


def test_offline_terminal_r2_grades_buggy_not_r1(monkeypatch):
    # R1 applies the WINNING reference fix but public (forced) FAILs → R2 opens → R2 empty (terminal).
    # The reset before R2 removes R1's fix, so the single verify grades the BUGGY source → FAIL.
    task = synthetic_task("black-canary", "whitespace")
    res, graded = _run_offline(monkeypatch, task, r1="fix", r2="none", public_seq=["FAIL", "FAIL"])
    assert res.round2_opened is True and res.hidden_verifications == 1
    assert res.passed is False                          # graded buggy, NOT R1's winning patch
    assert graded == dict(task.source)                  # the verifier saw the buggy pre-image
    assert graded != dict(task.reference_fix)


def test_offline_valid_r2_grades_r2(monkeypatch):
    # R1 empty (public FAIL) → R2 applies the fix → the single verify grades R2's patch → PASS.
    task = synthetic_task("black-canary", "whitespace")
    res, graded = _run_offline(monkeypatch, task, r1="none", r2="fix", public_seq=["FAIL", "PASS"])
    assert res.round2_opened is True and res.hidden_verifications == 1
    assert res.passed is True and graded == dict(task.reference_fix)


def test_offline_r1_pass_grades_r1(monkeypatch):
    # R1 applies the fix, public PASS → no R2 → grades R1's patch → PASS.
    task = synthetic_task("black-canary", "whitespace")
    res, graded = _run_offline(monkeypatch, task, r1="fix", r2="none", public_seq=["PASS"])
    assert res.round2_opened is False and res.hidden_verifications == 1
    assert res.passed is True and graded == dict(task.reference_fix)
