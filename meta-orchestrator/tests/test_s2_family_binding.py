"""Defect-5 regression: the frozen task_family binding is authoritative and fail-closed.

Offline / model-free. Proves:
  * the frozen family map resolves black-112 → 'whitespace' and every §2 task audits valid (27/27);
  * ``assert_task_family_valid`` rejects empty / None / unknown families and accepts a taxonomy member;
  * a clean synthetic lesson is writable to the bank under the CORRECT family, and the write-gate
    rejects it under a mismatched or non-taxonomy family;
  * ``run_real_task_canary`` binds ONE family and hands the SAME value to the solver, the RoundView
    and the write-gate; and it blocks — BEFORE any reservation or model call — on an empty / unknown
    context family, a caller-override mismatch, or a grant/task-metadata mismatch.
"""
from __future__ import annotations

import os

import pytest

from meta_orchestrator.experiment.lesson import Lesson, LessonEvidence, LessonTrigger
from meta_orchestrator.experiment.s2 import evaluate_write_gate
from meta_orchestrator.experiment.s2.families import (SEMANTIC_FAMILIES, assert_task_family_valid,
                                                     audit_family_bindings, resolve_task_family)
from meta_orchestrator.experiment.s2.gate_error import GateError
from meta_orchestrator.experiment.s2.families import TaskFamilyBindingError
from meta_orchestrator.experiment.s2.realtask import RealTaskContext
from meta_orchestrator.experiment.s2.real_canary import run_real_task_canary

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _lesson(fam="whitespace"):
    return Lesson(
        lesson_id=f"L-{fam}", task_family=fam,
        trigger=LessonTrigger(symptoms=[f"output differs in {fam} cases"]),
        recommended_action=["prefer a minimal targeted edit over a broad rewrite"],
        avoid=["sweeping edits across unrelated code"],
        evidence=LessonEvidence(successes=1), status="active")


# --- the frozen map + taxonomy -----------------------------------------------------------

def test_black_112_resolves_to_whitespace():
    assert resolve_task_family(_CORPUS, "black-112") == "whitespace"


def test_task_family_binding_is_a_gate_error():
    # defect-5 is an APPARATUS failure: it must be catchable as a GateError (blocks the paid call).
    assert issubclass(TaskFamilyBindingError, GateError)


def test_every_task_family_audits_valid():
    rows = audit_family_bindings(_CORPUS)
    assert len(rows) == 27
    bad = [r for r in rows if not r["valid"]]
    assert not bad, f"invalid family bindings: {bad}"
    assert all(r["family"] in SEMANTIC_FAMILIES for r in rows)


@pytest.mark.parametrize("bad", ["", None, "made_up_family", "TOKENIZER/PARSER"])
def test_assert_task_family_valid_rejects(bad):
    with pytest.raises(TaskFamilyBindingError):
        assert_task_family_valid(bad)


def test_assert_task_family_valid_accepts_taxonomy_member():
    assert assert_task_family_valid("whitespace") == "whitespace"


# --- the write-gate honours the authoritative family --------------------------------------

def test_clean_lesson_writable_under_correct_family():
    res = evaluate_write_gate(_lesson("whitespace"), is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert res.written and not res.reasons


def test_lesson_blocked_when_family_mismatches_task():
    res = evaluate_write_gate(_lesson("whitespace"), is_train=True, verifier_passed=True,
                              task_family="iterator", existing=[])
    assert not res.written and "family_mismatch" in res.reasons


def test_lesson_blocked_when_candidate_family_not_in_taxonomy():
    res = evaluate_write_gate(_lesson("made_up_family"), is_train=True, verifier_passed=True,
                              task_family="made_up_family", existing=[])
    assert not res.written and "family_not_in_taxonomy" in res.reasons


# --- run_real_task_canary fail-closed binding (no reservation / no send on any violation) --

class _ExplodingClient:
    """A stand-in transport that fails LOUDLY if anything tries to send — proving no paid call ran."""

    def build_request_messages(self, messages):  # pragma: no cover - must never be reached
        raise AssertionError("build_request_messages called — a send was attempted")

    @property
    def last_request_json(self):  # pragma: no cover
        raise AssertionError("last_request_json read — a send was attempted")

    def complete_messages(self, messages):  # pragma: no cover
        raise AssertionError("complete_messages called — a paid send was attempted")


class _FakeGrant:
    """Only the attributes read BEFORE the (never-reached) reservation matter here."""

    def __init__(self, task_family=""):
        self.fold = 1
        self.condition = "C"
        self.task_family = task_family
        self.grant_id = "grant-test"
        self.max_messages_calls = 2


def _ctx(task_family):
    return RealTaskContext(task_id="black-112", task_family=task_family, repo="/nonexistent",
                           py="/nonexistent/python", allowed_source_files=["src/black/__init__.py"],
                           p2p_nodes=["t::a"], hidden_nodes=["t::b"], buggy_source={"src/black/__init__.py": "x = 1\n"})


def _run(tmp_path, ctx, grant, **kw):
    return run_real_task_canary(
        ctx, client=_ExplodingClient(), statement="fix it", pricing=None, endpoint_att=None,
        grant=grant, grant_ledger_path=str(tmp_path / "grant_ledger.json"),
        work_dir=str(tmp_path / "work"), count_fn=lambda req: 0, full_exposure_usd="0.14",
        fold_budget_usd=10.0, context_cap=200_000, env_hash="e", contract_hash="c",
        memory_lines=[], is_train=True, **kw)


def _assert_no_reservation(tmp_path):
    # the fail-closed check runs BEFORE the BudgetLedger is even constructed → no ledger file exists.
    assert not os.path.exists(tmp_path / "work" / "ledger.json")


def test_empty_context_family_blocks_before_send(tmp_path):
    with pytest.raises(TaskFamilyBindingError):
        _run(tmp_path, _ctx(""), _FakeGrant("whitespace"))
    _assert_no_reservation(tmp_path)


def test_unknown_context_family_blocks_before_send(tmp_path):
    with pytest.raises(TaskFamilyBindingError):
        _run(tmp_path, _ctx("made_up_family"), _FakeGrant("made_up_family"))
    _assert_no_reservation(tmp_path)


def test_caller_override_mismatch_blocks_before_send(tmp_path):
    with pytest.raises(TaskFamilyBindingError):
        _run(tmp_path, _ctx("whitespace"), _FakeGrant("whitespace"), task_family="iterator")
    _assert_no_reservation(tmp_path)


def test_grant_family_mismatch_blocks_before_send(tmp_path):
    with pytest.raises(TaskFamilyBindingError):
        _run(tmp_path, _ctx("whitespace"), _FakeGrant("iterator"))
    _assert_no_reservation(tmp_path)
