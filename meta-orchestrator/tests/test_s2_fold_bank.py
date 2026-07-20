"""Frozen Fold-1 Condition-C lesson bank (learned from the first final-sequence attempt).

Verifies the persisted bank loads + hash-verifies, holds exactly the banked whitespace lesson with
its provenance, and that memory injection is exact-family: a whitespace task gets the lesson, an
other-family task (e.g. black-130's other_logic) gets nothing.
"""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.s2.families import resolve_task_family
from meta_orchestrator.experiment.s2.gate_error import GateError
from meta_orchestrator.experiment.s2.memory import (FROZEN_FOLD_BANK_FILENAME, load_frozen_fold_bank,
                                                   render_lines, resolve_memory)

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def test_frozen_bank_loads_and_holds_the_banked_lesson():
    bank = load_frozen_fold_bank(_CORPUS)
    assert bank.frozen is True
    assert bank.families_present() == ["whitespace"]
    lessons = bank.lessons_for("whitespace")
    assert len(lessons) == 1
    lesson = lessons[0]
    assert lesson.lesson_id == "cand-e04f0fb979"
    assert lesson.task_family == "whitespace"
    assert lesson.evidence.supporting_runs == ["fold1::black-112"]     # provenance stamp


def test_bank_content_hash_is_bound():
    raw = json.load(open(os.path.join(_CORPUS, FROZEN_FOLD_BANK_FILENAME)))
    bank = load_frozen_fold_bank(_CORPUS)
    assert bank.content_hash() == raw["bank_content_hash"] == "c68f22dafea5"


def test_tampered_bank_blocks(tmp_path):
    raw = json.load(open(os.path.join(_CORPUS, FROZEN_FOLD_BANK_FILENAME)))
    raw["by_family"]["whitespace"][0]["recommended_action"] = ["tampered"]   # keep old hashes
    (tmp_path / FROZEN_FOLD_BANK_FILENAME).write_text(json.dumps(raw))
    with pytest.raises(GateError):
        load_frozen_fold_bank(str(tmp_path))


def test_injection_is_exact_family():
    bank = load_frozen_fold_bank(_CORPUS)
    # a whitespace task gets the whitespace lesson injected
    mc = resolve_memory("C", "whitespace", bank=bank)
    assert mc.lesson_ids == ["cand-e04f0fb979"]
    assert len(render_lines(mc)) >= 1
    # black-130 is other_logic → NO whitespace lesson injected (exact-family only)
    assert resolve_task_family(_CORPUS, "black-130") == "other_logic"
    mc2 = resolve_memory("C", "other_logic", bank=bank)
    assert mc2.lesson_ids == []
