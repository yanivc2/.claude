"""Frozen deterministic B1 fallback family selection.

When the primary placebo-derangement family cannot count-match C (too few lessons yet), B1 draws from
ONE non-target family chosen by a FROZEN, corpus-wide cyclic fallback order (primary derangement
first, target family excluded), top-n by the frozen ranking. No padding / no duplication / no
cross-family mixing; fail-closed only when no eligible non-target family has enough lessons. The order
is fixed for the whole corpus and independent of any task outcome.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.lesson import Lesson
from meta_orchestrator.experiment.s2.memory import (FrozenLessonBank, MemoryOccupancyMismatch,
                                                   PlaceboRouter, assert_occupancy_parity,
                                                   b1_fallback_order, b1_lines_count_matched,
                                                   b1_source_family, parse_mem_tag, resolve_memory)


def _l(fam, lid, n_rec=1):
    return Lesson(lesson_id=lid, task_family=fam,
                  recommended_action=[f"do thing {i}" for i in range(n_rec)], avoid=["avoid x"])


# whitespace's frozen fallback order (primary derangement iterator first, target excluded)
def test_frozen_fallback_order_is_deterministic_and_excludes_target():
    order = b1_fallback_order("whitespace")
    assert order == ["iterator", "other_logic", "parser_normalization", "state_mutation",
                     "boundary", "condition_inversion"]
    assert "whitespace" not in order                       # target excluded
    assert order[0] == PlaceboRouter.build().route("whitespace")   # primary derangement first


def test_primary_family_has_enough_uses_primary():
    bank = FrozenLessonBank(by_family={"whitespace": [_l("whitespace", "w")],
                                       "iterator": [_l("iterator", "i")]}, frozen=True)
    assert b1_source_family("whitespace", bank=bank, required_count=1) == "iterator"   # primary


def test_primary_empty_uses_first_eligible_fallback():
    # iterator (primary) empty → next eligible in the frozen order is other_logic
    bank = FrozenLessonBank(by_family={"whitespace": [_l("whitespace", "w")],
                                       "other_logic": [_l("other_logic", "o")]}, frozen=True)
    assert b1_source_family("whitespace", bank=bank, required_count=1) == "other_logic"


def test_primary_too_few_skips_to_family_with_enough():
    # C requires 2; primary iterator has only 1 → skip; other_logic has 2 → chosen
    bank = FrozenLessonBank(by_family={
        "whitespace": [_l("whitespace", "w1"), _l("whitespace", "w2")],
        "iterator": [_l("iterator", "i1")],
        "other_logic": [_l("other_logic", "o1"), _l("other_logic", "o2")],
    }, frozen=True)
    assert b1_source_family("whitespace", bank=bank, required_count=2) == "other_logic"
    b1 = b1_lines_count_matched("whitespace", bank=bank, placebo=PlaceboRouter.build())
    kind, fam = parse_mem_tag(b1)
    assert kind == "other_family" and fam == "other_logic"
    assert sum(1 for ln in b1 if ln.startswith("- ")) == 2 + 2   # 2 lessons × (1 rec + 1 avoid)


def test_target_family_is_never_used_even_if_it_has_enough():
    # only the TARGET family (whitespace) holds lessons → forbidden for B1 → fail-closed
    bank = FrozenLessonBank(by_family={"whitespace": [_l("whitespace", "w1"), _l("whitespace", "w2")]},
                            frozen=True)
    with pytest.raises(MemoryOccupancyMismatch):
        b1_source_family("whitespace", bank=bank, required_count=1)


def test_no_eligible_family_fails_closed():
    # C needs 1 but no non-target family has any lesson → fail-closed (no padding/duplication)
    bank = FrozenLessonBank(by_family={"whitespace": [_l("whitespace", "w")]}, frozen=True)
    with pytest.raises(MemoryOccupancyMismatch):
        assert_occupancy_parity("whitespace", bank=bank, placebo=PlaceboRouter.build())


def test_fallback_selection_is_repeatable():
    bank = FrozenLessonBank(by_family={
        "whitespace": [_l("whitespace", "w")],
        "other_logic": [_l("other_logic", "o1"), _l("other_logic", "o2")],
    }, frozen=True)
    a = b1_lines_count_matched("whitespace", bank=bank, placebo=PlaceboRouter.build())
    b = b1_lines_count_matched("whitespace", bank=bank, placebo=PlaceboRouter.build())
    assert a == b                                          # identical family + lesson content
    assert b1_source_family("whitespace", bank=bank, required_count=1) == "other_logic"


def test_count_parity_and_token_gap_gate_still_enforced():
    # C=1 short whitespace lesson; the fallback family other_logic holds a MUCH longer lesson →
    # count-matched 1==1 but the rendered-token gap is large AND >20% → blocked (quantity confound).
    bank = FrozenLessonBank(by_family={
        "whitespace": [_l("whitespace", "w", n_rec=1)],
        "other_logic": [Lesson(lesson_id="o-long", task_family="other_logic",
                               recommended_action=[("word " * 40).strip() for _ in range(3)],
                               avoid=["x"])],
    }, frozen=True)
    with pytest.raises(MemoryOccupancyMismatch):
        assert_occupancy_parity("whitespace", bank=bank, placebo=PlaceboRouter.build())


def test_count_parity_passes_when_fallback_sizes_are_similar():
    bank = FrozenLessonBank(by_family={
        "whitespace": [_l("whitespace", "w", n_rec=2)],
        "other_logic": [_l("other_logic", "o", n_rec=2)],
    }, frozen=True)
    rep = assert_occupancy_parity("whitespace", bank=bank, placebo=PlaceboRouter.build())
    assert rep["c_items"] == rep["b1_items"] == 1
    assert rep["deranged_family"] == "other_logic" and rep["b1_fallback_used"] is True
    assert rep["token_gap"] <= 32


def test_empty_c_slot_needs_no_fallback():
    # a family with no banked lessons → C=0 → B1=0 → parity holds, fallback never engaged
    bank = FrozenLessonBank(by_family={"whitespace": [_l("whitespace", "w")]}, frozen=True)
    rep = assert_occupancy_parity("iterator", bank=bank, placebo=PlaceboRouter.build())
    assert rep["c_items"] == 0 and rep["b1_items"] == 0 and rep["b1_fallback_used"] is False
    assert b1_lines_count_matched("iterator", bank=bank, placebo=PlaceboRouter.build()) == []
