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


def test_frozen_bank_loads_and_holds_the_banked_lessons():
    bank = load_frozen_fold_bank(_CORPUS)
    assert bank.frozen is True
    assert bank.families_present() == ["iterator", "other_logic", "whitespace"]  # 3 families, 4 lessons
    w = bank.lessons_for("whitespace")
    assert len(w) == 1 and w[0].lesson_id == "cand-e04f0fb979"
    assert w[0].evidence.supporting_runs == ["fold1::black-112"]
    o = bank.lessons_for("other_logic")                                    # other_logic full (cap 2)
    assert [l.lesson_id for l in o] == ["cand-5f96357fce", "cand-773d0aca18"]
    assert o[0].evidence.supporting_runs == ["fold1::black-130"]           # provenance stamp
    assert o[1].evidence.supporting_runs == ["fold1::black-185"]           # memory-bearing SOLVE
    it = bank.lessons_for("iterator")
    assert [l.lesson_id for l in it] == ["cand-f0b1e78791"]                # black-193 SOLVE
    assert it[0].evidence.supporting_runs == ["fold1::black-193"]


def test_bank_content_hash_is_bound():
    raw = json.load(open(os.path.join(_CORPUS, FROZEN_FOLD_BANK_FILENAME)))
    bank = load_frozen_fold_bank(_CORPUS)
    assert bank.content_hash() == raw["bank_content_hash"] == "7d2f81359026"


def test_tampered_bank_blocks(tmp_path):
    raw = json.load(open(os.path.join(_CORPUS, FROZEN_FOLD_BANK_FILENAME)))
    raw["by_family"]["whitespace"][0]["recommended_action"] = ["tampered"]   # keep old hashes
    (tmp_path / FROZEN_FOLD_BANK_FILENAME).write_text(json.dumps(raw))
    with pytest.raises(GateError):
        load_frozen_fold_bank(str(tmp_path))


def test_injection_is_exact_family():
    bank = load_frozen_fold_bank(_CORPUS)
    # a whitespace task gets ONLY the whitespace lesson; an other_logic task ONLY the other_logic one
    assert resolve_memory("C", "whitespace", bank=bank).lesson_ids == ["cand-e04f0fb979"]
    assert resolve_memory("C", "other_logic", bank=bank).lesson_ids == ["cand-5f96357fce",
                                                                        "cand-773d0aca18"]
    # black-132 is parser_normalization → no banked lesson yet → empty (Option B → [])
    assert resolve_task_family(_CORPUS, "black-132") == "parser_normalization"
    mc = resolve_memory("C", "parser_normalization", bank=bank)
    assert mc.lesson_ids == [] and render_lines(mc) == []
