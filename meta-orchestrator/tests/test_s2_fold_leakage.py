"""P0.2 — fold-specific bank leakage tripwire.

The mock learner emits one generic lesson per family, so every fold's bank hashes identically —
which would hide cross-fold leakage (a global bank, a reused fold-0 bank, DB carryover, or B1
sourced from the wrong fold). A DISTINCTIVE, provenance-carrying learner exposes those bugs.
Offline, model-free.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.lesson import Lesson, LessonEvidence, LessonTrigger
from meta_orchestrator.experiment.s2 import (FoldLeakageError, PlaceboRouter, SEMANTIC_FAMILIES,
                                             assert_bank_within_train, bank_provenance,
                                             learn_gated_bank, stratified_folds)

REAL_27 = [
    "black-112", "black-130", "black-132", "black-133", "black-141", "black-1632", "black-183",
    "black-185", "black-193", "black-215", "black-224", "black-232", "black-234", "black-238",
    "black-273", "black-329", "black-334", "black-335", "black-385", "black-389", "black-593",
    "black-60", "black-74", "black-80", "black-95", "cookiecutter-18", "discord.py-7818",
]


def _map(ids, fams=SEMANTIC_FAMILIES):
    return {tid: fams[i % len(fams)] for i, tid in enumerate(sorted(ids))}


def _distinctive_lesson(source_task_id, family):
    """A candidate whose TEXT is unique to its source task (still abstraction-safe: no leaks)."""
    token = source_task_id.replace("-", " ").replace(".", " ")
    return Lesson(
        lesson_id=f"L-{source_task_id}",
        task_family=family,
        trigger=LessonTrigger(symptoms=[f"symptom variant {token} in {family} cases"]),
        recommended_action=[f"apply the minimal targeted approach seen for {token}"],
        avoid=[],
        evidence=LessonEvidence(successes=1),
        status="active",
    )


def _learn_fold(fold, fmap, max_active=99):
    proposals = [(tid, fmap[tid], True, _distinctive_lesson(tid, fmap[tid]))
                 for tid in fold.train_ids]
    bank, _ = learn_gated_bank(proposals, max_active=max_active, fold=fold.index)
    return bank


def test_fold_banks_have_distinct_hashes():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, 3)
    banks = [_learn_fold(f, fmap) for f in folds]
    hashes = {b.content_hash() for b in banks}
    assert len(hashes) == 3                          # distinctive learner → 3 different banks


def test_bank_provenance_is_within_train_and_excludes_held_out():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, 3)
    for f in folds:
        bank = _learn_fold(f, fmap)
        prov = bank_provenance(bank)
        assert prov <= set(f.train_ids)              # provenance ⊆ train
        assert not (prov & set(f.test_ids))          # no held-out task contributed
        assert_bank_within_train(bank, f.train_ids)  # must not raise


def test_injecting_another_folds_bank_fails_loudly():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, 3)
    bank0 = _learn_fold(folds[0], fmap)
    # fold 0's bank contains tasks that are HELD-OUT in fold 1 → the tripwire must fire.
    with pytest.raises(FoldLeakageError):
        assert_bank_within_train(bank0, folds[1].train_ids)


def test_fold_execution_order_does_not_change_a_folds_bank():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, 3)
    forward = {f.index: _learn_fold(f, fmap).content_hash() for f in folds}
    backward = {f.index: _learn_fold(f, fmap).content_hash() for f in reversed(folds)}
    assert forward == backward                        # each fold's bank is independent of order


def test_b1_is_sourced_from_the_same_fold_bank():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, 3)
    present = sorted(set(fmap.values()))
    placebo = PlaceboRouter.build(present)
    f = folds[0]
    bank = _learn_fold(f, fmap)
    # B1 for a task family reads the SAME fold bank, keyed to the placebo family.
    fam = fmap[f.test_ids[0]]
    other = placebo.route(fam)
    b1_lessons = bank.lessons_for(other)
    # whatever B1 injects, its provenance is still inside THIS fold's train (no cross-fold pull).
    for l in b1_lessons:
        for run in l.evidence.supporting_runs:
            assert run.split("::")[-1] in set(f.train_ids)
