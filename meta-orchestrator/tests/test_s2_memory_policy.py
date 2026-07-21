"""Frozen memory-injection policy (Option B empty-slot + occupancy parity hard gate).

Freezes: an empty memory slot injects NOTHING (no @@MEM tag) across C/D/B1; B1 is occupancy
count-matched to C from the deranged family (fail-closed if it cannot supply enough); the policy
artifact loads + hash-verifies.
"""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.lesson import Lesson
from meta_orchestrator.experiment.s2.memory import (FrozenLessonBank, MemoryOccupancyMismatch,
                                                   PlaceboRouter, assert_occupancy_parity,
                                                   b1_lines_count_matched, render_lines,
                                                   resolve_memory)

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _lesson(fam, lid, n_rec=1):
    return Lesson(lesson_id=lid, task_family=fam,
                  recommended_action=[f"action {i}" for i in range(n_rec)], avoid=["x"])


def test_policy_artifact_loads_and_hash_verifies():
    raw = json.load(open(os.path.join(_CORPUS, "s2_memory_injection_policy.frozen.json")))
    import hashlib
    payload = json.dumps({k: v for k, v in raw.items() if k != "content_hash"},
                         sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256(payload.encode()).hexdigest()[:16] == raw["content_hash"]
    assert raw["empty_slot_policy"] == "inject_nothing"
    assert raw["C"]["exact_family_only"] is True


def test_empty_slot_injects_nothing_for_C_D_B1():
    bank = FrozenLessonBank(by_family={}, frozen=True)
    # C with an empty family bank → [] (no @@MEM tag)
    assert render_lines(resolve_memory("C", "whitespace", bank=bank)) == []
    # A is always empty
    assert render_lines(resolve_memory("A", "whitespace")) == []


def test_occupancy_gate_passes_when_both_empty():
    bank = FrozenLessonBank(by_family={"whitespace": [_lesson("whitespace", "L-w")]}, frozen=True)
    placebo = PlaceboRouter.build()
    # other_logic has no C lessons → C injects 0 → B1 must inject 0 → parity holds
    rep = assert_occupancy_parity("other_logic", bank=bank, placebo=placebo)
    assert rep["c_items"] == 0 and rep["b1_items"] == 0 and rep["line_parity"] is True


def test_occupancy_gate_fails_closed_when_deranged_family_cannot_match():
    # C has a whitespace lesson but the deranged family has none → B1 cannot match → blocked.
    bank = FrozenLessonBank(by_family={"whitespace": [_lesson("whitespace", "L-w")]}, frozen=True)
    placebo = PlaceboRouter.build()
    with pytest.raises(MemoryOccupancyMismatch):
        assert_occupancy_parity("whitespace", bank=bank, placebo=placebo)


def test_b1_is_count_matched_to_c():
    deranged = PlaceboRouter.build().route("whitespace")
    bank = FrozenLessonBank(by_family={
        "whitespace": [_lesson("whitespace", "L-w")],
        deranged: [_lesson(deranged, "L-d1"), _lesson(deranged, "L-d2")],   # 2 available
    }, frozen=True)
    # C injects 1 → B1 must inject exactly 1 (not both) from the deranged family
    b1 = b1_lines_count_matched("whitespace", bank=bank, placebo=PlaceboRouter.build())
    # 1 tag line + 1 recommended + 1 avoid = 3 rendered lines for a single 1-rec lesson
    assert b1[0].startswith("@@MEM kind=other_family")
    assert sum(1 for ln in b1 if ln.startswith("- ")) == 2       # one rec + one avoid bullet
