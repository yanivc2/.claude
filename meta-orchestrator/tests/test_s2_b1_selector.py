"""B1 parity-optimized derangement selector (frozen algorithm) + adversarial bank shapes.

Pure and offline. The selector counts the COMPLETE request via an injectable metrics oracle; here
the oracle is a memory-only proxy so the ALGORITHM is exercised in isolation. Proves parity
qualification, determinism, hard block on impossible shapes, tie-break, proxy-vs-production
tagging, and that a bank mutation breaks the artifact hash.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.lesson import Lesson, LessonEvidence, LessonTrigger
from meta_orchestrator.experiment.s2 import (B1_SELECTOR_ALGO_VERSION, PROXY_SOURCE, REAL_SOURCE,
                                             B1SelectionBlocked, FrozenLessonBank,
                                             ProxyArtifactNotProductionValid, SEMANTIC_FAMILIES,
                                             assert_production_valid, enumerate_derangements,
                                             memory_only_metrics_fn, select_b1_derangement)

FAMS = sorted(SEMANTIC_FAMILIES)[:6]


def _lesson(family, rec, lid=None):
    return Lesson(lesson_id=lid or f"L-{family}", task_family=family,
                  trigger=LessonTrigger(symptoms=[f"s {family}"]),
                  recommended_action=rec, evidence=LessonEvidence(successes=1), status="active")


def _equal_bank():
    return FrozenLessonBank(by_family={f: [_lesson(f, ["apply a minimal targeted edit here"])]
                                       for f in FAMS}, frozen=True)


def _tasks(families):
    # one held-out task per family (task id embeds the family)
    return [(f"task-{f}", f) for f in families]


def test_enumerate_derangements_have_no_fixed_point():
    ds = enumerate_derangements(FAMS)
    assert ds and all(all(m[f] != f for f in FAMS) for m in ds)


def test_selection_succeeds_with_equal_occupancy():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=0,
                                metrics_fn=memory_only_metrics_fn(bank))
    assert sel.algo_version == B1_SELECTOR_ALGO_VERSION
    assert sel.token_count_source == PROXY_SOURCE
    assert all(sel.mapping[f] != f for f in FAMS)
    for row in sel.metrics:
        assert row.c_entries == row.b1_entries and row.c_lines == row.b1_lines
        assert row.token_diff <= 16


def test_selection_is_deterministic():
    bank = _equal_bank()
    a = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=1, metrics_fn=memory_only_metrics_fn(bank))
    b = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=1, metrics_fn=memory_only_metrics_fn(bank))
    assert a.mapping == b.mapping and a.content_hash() == b.content_hash()


# --- proxy vs production source (user rule 2) --------------------------------------------
def test_proxy_artifact_is_not_production_valid():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=0,
                                metrics_fn=memory_only_metrics_fn(bank))  # default source = proxy
    with pytest.raises(ProxyArtifactNotProductionValid):
        assert_production_valid(sel)


def test_real_source_artifact_passes_the_gate_guard():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=0,
                                metrics_fn=memory_only_metrics_fn(bank),
                                token_count_source=REAL_SOURCE)
    assert_production_valid(sel)                    # must not raise


# --- adversarial bank shapes -------------------------------------------------------------
def test_block_when_one_family_is_much_longer():
    long_rec = ["apply a very long and detailed multi clause corrective procedure " * 3]
    by = {f: [_lesson(f, ["short edit"])] for f in FAMS}
    by[FAMS[0]] = [_lesson(FAMS[0], long_rec)]
    bank = FrozenLessonBank(by_family=by, frozen=True)
    with pytest.raises(B1SelectionBlocked):
        select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=2, metrics_fn=memory_only_metrics_fn(bank))


def test_block_on_zero_entry_family():
    by = {f: [_lesson(f, ["short edit"])] for f in FAMS[1:]}       # FAMS[0] absent → empty
    bank = FrozenLessonBank(by_family=by, frozen=True)
    with pytest.raises(B1SelectionBlocked):
        select_b1_derangement(bank, FAMS, [(f"task-{FAMS[0]}", FAMS[0])], fold=0,
                              metrics_fn=memory_only_metrics_fn(bank))


def test_block_on_equal_entries_but_unequal_lines():
    # two families each have 1 entry, but one entry renders 2 lines (an avoid line) vs 1.
    by = {f: [_lesson(f, ["one line edit"])] for f in FAMS}
    by[FAMS[1]] = [Lesson(lesson_id="L-two", task_family=FAMS[1],
                          trigger=LessonTrigger(symptoms=["s"]),
                          recommended_action=["one line edit"], avoid=["a second rendered line"],
                          evidence=LessonEvidence(successes=1), status="active")]
    bank = FrozenLessonBank(by_family=by, frozen=True)
    # held out only the two mismatched families → no mapping can match lines both ways.
    with pytest.raises(B1SelectionBlocked):
        select_b1_derangement(bank, FAMS, _tasks([FAMS[0], FAMS[1]]), fold=0,
                              metrics_fn=memory_only_metrics_fn(bank))


def test_tie_break_is_deterministic_with_multiple_qualifiers():
    # a fully uniform bank has many qualifying derangements; the frozen tie-break picks one.
    bank = _equal_bank()
    picks = {select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=0,
                                   metrics_fn=memory_only_metrics_fn(bank)).content_hash()
             for _ in range(5)}
    assert len(picks) == 1


def test_bank_mutation_breaks_the_artifact_hash():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=0,
                                metrics_fn=memory_only_metrics_fn(bank))
    # the artifact is bound to the exact bank; a different bank yields a different bank hash.
    mutated = FrozenLessonBank(
        by_family={**bank.by_family, FAMS[0]: [_lesson(FAMS[0], ["a DIFFERENT edit entirely"])]},
        frozen=True)
    assert sel.c_bank_hash != mutated.content_hash()


def test_router_routes_the_chosen_mapping():
    bank = _equal_bank()
    sel = select_b1_derangement(bank, FAMS, _tasks(FAMS), fold=0,
                                metrics_fn=memory_only_metrics_fn(bank))
    router = sel.router()
    for f in FAMS:
        assert router.route(f) == sel.mapping[f] != f
