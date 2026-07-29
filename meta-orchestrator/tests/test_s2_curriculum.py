"""Frozen training curriculum — exact literal first task, hash-bound (offline, $0)."""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.s2.curriculum import (CURRICULUM_VERSION,
                                                        FROZEN_CURRICULUM_FILENAME,
                                                        load_frozen_curriculum)
from meta_orchestrator.experiment.s2.gates import GateError

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def test_frozen_curriculum_first_task_is_exact_literal():
    cur = load_frozen_curriculum(_CORPUS)
    assert cur.curriculum_version == CURRICULUM_VERSION
    assert cur.content_hash == cur.compute_hash()
    fold1 = cur.folds["1"]
    assert len(fold1.train_order) == 18
    assert cur.task_at(1, 0) == "black-112"                # position 0 is a literal id, not a runtime sort
    assert fold1.condition == "C" and fold1.phase == "training"


def test_tampered_curriculum_order_breaks_hash(tmp_path):
    cur = load_frozen_curriculum(_CORPUS)
    d = cur.model_dump()
    d["folds"]["1"]["train_order"][0] = "black-999"        # reorder/replace, keep old hash
    (tmp_path / FROZEN_CURRICULUM_FILENAME).write_text(json.dumps(d))
    with pytest.raises(GateError):
        load_frozen_curriculum(str(tmp_path))
