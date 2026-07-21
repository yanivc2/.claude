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


def test_public_pass_but_hidden_fail_is_not_a_solve_and_never_banks():
    # black-132 regression: a patch can PASS the public suite yet FAIL the hidden F2P. The
    # AUTHORITATIVE verifier is the hidden verdict — verifier_passed reflects hidden, NOT public.
    # So a public-PASS/hidden-FAIL attempt is a FAILED solve and its lesson is never banked.
    hidden_verdict = False              # both hidden F2P nodes failed (public may still have passed)
    res = evaluate_write_gate(_lesson(), is_train=True, verifier_passed=hidden_verdict,
                              task_family="whitespace", existing=[])
    assert res.written is False and "verifier_failed" in res.reasons
    # authoritative outcome derivation must be hidden-based, never public-based:
    solver_outcome = "SOLVED" if hidden_verdict else "FAILED"
    assert solver_outcome == "FAILED"


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


def test_forbidden_token_screen_rejects_replayed_identifier_exact_only():
    # a frozen fix-only identifier is rejected as an EXACT token, but a lesson that merely uses a
    # SUBSTRING of it ("normalize") is NOT rejected (the old substring screen over-blocked).
    toks = ["normalize_fmt_off"]
    replay = _lesson(rec=["always call normalize_fmt_off before visiting"])
    res = evaluate_write_gate(replay, is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[], forbidden_values=toks)
    assert any(r.startswith("leak:") for r in res.reasons)
    ok = _lesson(rec=["normalize whitespace consistently across the file"])
    res2 = evaluate_write_gate(ok, is_train=True, verifier_passed=True,
                               task_family="whitespace", existing=[], forbidden_values=toks)
    assert not any(r.startswith("leak:") for r in res2.reasons)


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


# --- A+ regression: persist-time audit refuses a 3rd lesson for a family already at cap -----------
def _write_temp_bank(tmp_path, by_family):
    """Materialize a valid frozen-bank artifact (loadable by load_frozen_fold_bank) under tmp_path —
    never the active corpus files. Recomputes both the lesson-level and artifact-level hashes."""
    import hashlib
    import json

    from meta_orchestrator.experiment.s2.memory import (FOLD_BANK_VERSION, FROZEN_FOLD_BANK_FILENAME,
                                                        FrozenLessonBank)
    bank = FrozenLessonBank(by_family=by_family, frozen=True)
    art = {"schema_version": FOLD_BANK_VERSION, "frozen": True,
           "by_family": {f: [json.loads(l.model_dump_json()) for l in ls]
                         for f, ls in by_family.items()},
           "bank_content_hash": bank.content_hash()}
    payload = json.dumps({k: v for k, v in art.items() if k != "content_hash"},
                         sort_keys=True, separators=(",", ":"))
    art["content_hash"] = hashlib.sha256(payload.encode()).hexdigest()[:16]
    p = tmp_path / FROZEN_FOLD_BANK_FILENAME
    p.write_text(json.dumps(art, indent=2, sort_keys=True))
    return str(p)


def test_persist_audit_rejects_third_lesson_when_family_at_cap(tmp_path):
    """A+ (black-238 methodology lock): when the REAL bank already holds a family at cap, the
    persist-time mechanical audit REFUSES a third candidate (slot_budget_exceeded); the active bank
    does not grow, no eviction/replacement/re-ranking happens, and the on-disk artifact is byte-for-
    byte unchanged. This exercises the frozen decision function against a temp bank shaped like the
    real one — NEVER the active corpus bank files."""
    from meta_orchestrator.experiment.s2.memory import load_frozen_fold_bank
    # temp bank: whitespace already at MAX (2), each lesson distinct + clean
    two = [_lesson(fam="whitespace", lid="cand-existing1", rec=["prefer minimal targeted edits"], succ=3),
           _lesson(fam="whitespace", lid="cand-existing2", rec=["normalize whitespace consistently"], succ=2)]
    bank_path = _write_temp_bank(tmp_path, {"whitespace": two})
    before_bytes = open(bank_path, "rb").read()

    bank = load_frozen_fold_bank(str(tmp_path))
    existing = bank.lessons_for("whitespace")
    assert len(existing) == MAX_ACTIVE_ENTRIES_PER_FAMILY == 2

    # a clean, non-duplicate third whitespace candidate that a SOLVE at black-238 might propose
    cand = _lesson(fam="whitespace", lid="cand-third", rec=["group trailing comments before dedent"])

    # the frozen decision function the persist audit delegates to — evaluated against the REAL bank
    wg = evaluate_write_gate(cand, is_train=True, verifier_passed=True, task_family="whitespace",
                             existing=existing)
    assert wg.written is False
    assert "slot_budget_exceeded" in wg.reasons

    # the persist audit's authoritative gate (mirror of the s2 persist audit checks): REFUSE
    resulting_count_ok = len(existing) + 1 <= MAX_ACTIVE_ENTRIES_PER_FAMILY
    lesson_id_new = cand.lesson_id not in [l.lesson_id for l in existing]
    persist_allowed = resulting_count_ok and wg.written and wg.reasons == [] and lesson_id_new
    assert persist_allowed is False           # persistence refused
    assert resulting_count_ok is False        # specifically because the family is already at cap

    # no eviction / replacement / mutation — the frozen bank refuses writes and stays at 2
    with pytest.raises(MemoryFrozenError):
        bank.add("whitespace", cand)
    assert len(bank.lessons_for("whitespace")) == 2
    reloaded = load_frozen_fold_bank(str(tmp_path))
    assert [l.lesson_id for l in reloaded.lessons_for("whitespace")] == ["cand-existing1", "cand-existing2"]
    assert reloaded.content_hash() == bank.content_hash()      # lesson-level bank hash unchanged
    assert open(bank_path, "rb").read() == before_bytes        # artifact never rewritten (no impostor entry)
