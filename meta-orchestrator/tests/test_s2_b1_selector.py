"""B1 parity-optimized derangement selector (user decision A, frozen algorithm).

Pure and offline. Proves: parity-qualified selection, determinism, hard block when no mapping
meets the tolerance, no fixed point, and that the artifact is derived only from the frozen bank.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.lesson import Lesson, LessonEvidence, LessonTrigger
from meta_orchestrator.experiment.s2 import (B1_SELECTOR_ALGO_VERSION, B1SelectionBlocked,
                                             FrozenLessonBank, SEMANTIC_FAMILIES,
                                             enumerate_derangements, local_token_estimate,
                                             select_b1_derangement)

FAMS = sorted(SEMANTIC_FAMILIES)[:6]


def _lesson(family, rec):
    return Lesson(lesson_id=f"L-{family}", task_family=family,
                  trigger=LessonTrigger(symptoms=[f"s {family}"]),
                  recommended_action=rec, evidence=LessonEvidence(successes=1), status="active")


def _equal_bank():
    # one lesson per family, all with the SAME token length → parity trivially achievable.
    return FrozenLessonBank(by_family={f: [_lesson(f, ["apply a minimal targeted edit here"])]
                                       for f in FAMS}, frozen=True)


def test_enumerate_derangements_have_no_fixed_point():
    ds = enumerate_derangements(FAMS)
    assert ds and all(all(m[f] != f for f in FAMS) for m in ds)


def test_selection_succeeds_with_equal_occupancy():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, FAMS, fold=0)
    assert sel.algo_version == B1_SELECTOR_ALGO_VERSION
    assert sel.token_fn_name == "local-v1"
    assert all(sel.mapping[f] != f for f in FAMS)          # no fixed point
    for row in sel.metrics:                                 # exact entries+lines parity
        assert row.c_entries == row.b1_entries
        assert row.c_lines == row.b1_lines
        assert row.token_diff <= 16


def test_selection_is_deterministic():
    bank = _equal_bank()
    a = select_b1_derangement(bank, FAMS, FAMS, fold=1)
    b = select_b1_derangement(bank, FAMS, FAMS, fold=1)
    assert a.mapping == b.mapping and a.content_hash() == b.content_hash()


def test_block_when_no_mapping_meets_tolerance():
    # one family carries a MUCH longer lesson; a held-out task in that family can never be
    # length-matched by any OTHER (short) family → hard block, no fallback.
    long_rec = ["apply a very long and detailed multi clause corrective procedure " * 3]
    by_family = {f: [_lesson(f, ["short edit"])] for f in FAMS}
    by_family[FAMS[0]] = [_lesson(FAMS[0], long_rec)]
    bank = FrozenLessonBank(by_family=by_family, frozen=True)
    with pytest.raises(B1SelectionBlocked):
        select_b1_derangement(bank, FAMS, FAMS, fold=2)


def test_artifact_hash_locked_to_bank():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, FAMS, fold=0)
    assert sel.c_bank_hash == bank.content_hash()
    # a router built from the selection routes exactly the chosen mapping, no self-map
    router = sel.router()
    for f in FAMS:
        assert router.route(f) == sel.mapping[f] != f


def test_empty_held_out_family_requires_empty_b1():
    # a family with NO lessons in the bank: C injects nothing, so B1 must inject nothing too.
    by_family = {f: [_lesson(f, ["short edit"])] for f in FAMS[1:]}   # FAMS[0] absent → empty
    bank = FrozenLessonBank(by_family=by_family, frozen=True)
    # held-out is only the empty family → any mapping to a NON-empty family fails parity → block.
    with pytest.raises(B1SelectionBlocked):
        select_b1_derangement(bank, FAMS, [FAMS[0]], fold=0)
