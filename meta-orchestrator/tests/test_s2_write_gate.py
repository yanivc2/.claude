"""Deterministic C write-gate (Decision C) — the model proposes, code decides.

Offline and model-free. Proves each of the eight checks blocks a bad write, that a clean
candidate is admitted, that learning is deterministic, and that a held-out write is refused
loudly (the bank is frozen before held-out).
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.lesson import Lesson, LessonEvidence, LessonTrigger
from meta_orchestrator.experiment.s2 import (MAX_ACTIVE_ENTRIES_PER_FAMILY, evaluate_write_gate,
                                             learn_gated_bank)
from meta_orchestrator.experiment.s2.memory import MemoryFrozenError


def _lesson(fam="whitespace", lid=None, rec=None, avoid=None, succ=1):
    return Lesson(
        lesson_id=lid or f"L-{fam}",
        task_family=fam,
        trigger=LessonTrigger(symptoms=[f"output differs in {fam} cases"]),
        # NB: default only when the arg is omitted (None) — an explicit [] must stay empty.
        recommended_action=(["prefer a minimal targeted edit over a broad rewrite"]
                            if rec is None else rec),
        avoid=(["sweeping edits across unrelated code"] if avoid is None else avoid),
        evidence=LessonEvidence(successes=succ),
        status="active",
    )


def test_clean_candidate_is_written():
    res = evaluate_write_gate(_lesson(), is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert res.written is True and res.reasons == []


def test_held_out_candidate_rejected():
    res = evaluate_write_gate(_lesson(), is_train=False, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert res.written is False and "not_train" in res.reasons


def test_verifier_failure_rejected():
    res = evaluate_write_gate(_lesson(), is_train=True, verifier_passed=False,
                              task_family="whitespace", existing=[])
    assert "verifier_failed" in res.reasons


def test_empty_recommendation_rejected():
    res = evaluate_write_gate(_lesson(rec=[]), is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert "empty_recommended_action" in res.reasons


def test_family_not_in_taxonomy_rejected():
    res = evaluate_write_gate(_lesson(fam="made_up_family"), is_train=True, verifier_passed=True,
                              task_family="made_up_family", existing=[])
    assert "family_not_in_taxonomy" in res.reasons


def test_family_mismatch_rejected():
    # candidate claims iterator but the task is whitespace — family must come from the task.
    res = evaluate_write_gate(_lesson(fam="iterator"), is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert "family_mismatch" in res.reasons


def test_leak_rejected():
    leaky = _lesson(rec=["edit line 42 of solution.py"])
    res = evaluate_write_gate(leaky, is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert any(r.startswith("leak:") for r in res.reasons)


def test_forbidden_value_rejected():
    leaky = _lesson(rec=["the expected total is 15 always"])
    res = evaluate_write_gate(leaky, is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[], forbidden_values=["15"])
    assert any(r.startswith("leak:") for r in res.reasons)


def test_duplicate_rejected():
    existing = [_lesson()]
    res = evaluate_write_gate(_lesson(lid="L-other"), is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=existing)
    assert "duplicate" in res.reasons


def test_contradiction_rejected():
    existing = [_lesson(rec=["always rewrite broadly"], avoid=["minimal edits"])]
    contra = _lesson(lid="L-2", rec=["minimal edits"], avoid=["always rewrite broadly"])
    res = evaluate_write_gate(contra, is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=existing)
    assert "contradiction" in res.reasons


def test_slot_budget_enforced():
    existing = [_lesson(lid="L-1", rec=["a"]), _lesson(lid="L-2", rec=["b"])]
    assert len(existing) == MAX_ACTIVE_ENTRIES_PER_FAMILY
    res = evaluate_write_gate(_lesson(lid="L-3", rec=["c"]), is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=existing)
    assert "slot_budget_exceeded" in res.reasons


# --- gated learning + frozen bank --------------------------------------------------------
def test_learn_gated_bank_admits_only_clean_train_passes():
    proposals = [
        ("black-1", "whitespace", True, _lesson(fam="whitespace", lid="L-w1", rec=["minimal edit"])),
        ("black-2", "whitespace", False, _lesson(fam="whitespace", lid="L-w2", rec=["skip me"])),
        ("black-3", "iterator", True, _lesson(fam="iterator", lid="L-i1", rec=["advance once"])),
        ("black-4", "iterator", True, _lesson(fam="wrong", lid="L-bad", rec=["x"])),  # taxonomy
    ]
    bank, audit = learn_gated_bank(proposals)
    assert bank.frozen is True
    assert set(bank.families_present()) == {"whitespace", "iterator"}
    written = {a["lesson_id"] for a in audit if a["written"]}
    assert "L-w1" in written and "L-i1" in written
    assert "L-w2" not in written and "L-bad" not in written


def test_learn_gated_bank_is_deterministic():
    proposals = [("black-1", "whitespace", True, _lesson(lid="L-w1", rec=["minimal edit"]))]
    b1, _ = learn_gated_bank(proposals)
    b2, _ = learn_gated_bank(proposals)
    assert b1.content_hash() == b2.content_hash()


def test_frozen_bank_refuses_held_out_write():
    bank, _ = learn_gated_bank(
        [("black-1", "whitespace", True, _lesson(lid="L-w1", rec=["minimal edit"]))])
    with pytest.raises(MemoryFrozenError):
        bank.add("whitespace", _lesson(lid="L-x", rec=["late write"]))


def test_slot_budget_enforced_in_gated_learning():
    # three clean whitespace candidates → only the first two survive the slot budget.
    proposals = [
        ("black-1", "whitespace", True, _lesson(lid="L-1", rec=["alpha edit"], succ=3)),
        ("black-2", "whitespace", True, _lesson(lid="L-2", rec=["beta edit"], succ=2)),
        ("black-3", "whitespace", True, _lesson(lid="L-3", rec=["gamma edit"], succ=1)),
    ]
    bank, audit = learn_gated_bank(proposals)
    assert len(bank.lessons_for("whitespace")) == MAX_ACTIVE_ENTRIES_PER_FAMILY
    # highest-support candidates win the deterministic ranking (succ 3 and 2 kept, 1 dropped).
    kept = {a["lesson_id"] for a in audit if a["written"]}
    assert kept == {"L-1", "L-2"}
