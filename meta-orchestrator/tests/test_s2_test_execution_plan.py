"""Frozen test-execution plan (defect-4 fix): internal consistency, hash seal, fail-closed load,
and — when the frozen corpus artifact exists — that every plan is self-consistent and exact-node."""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.s2.gates import GateError
from meta_orchestrator.experiment.s2.test_execution_plan import (
    FROZEN_TEST_PLANS_FILENAME, FrozenTestExecutionPlans, build_plan,
    load_frozen_test_execution_plans)

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _plan(**over):
    base = dict(task_id="t", buggy_rev="b", fixed_rev="f", overlay_files=["tests/x.py"],
                overlay_hashes={"tests/x.py": "aa"}, public_nodes=["tests/t.py::p"],
                hidden_nodes=["tests/t.py::h"])
    base.update(over)
    return build_plan(**base)


def test_build_plan_is_internally_consistent():
    p = _plan()
    p.assert_internally_consistent()                         # no raise
    assert p.hidden_nodes == ["tests/t.py::h"] and p.public_nodes == ["tests/t.py::p"]


def test_public_hidden_overlap_rejected():
    with pytest.raises(GateError):
        _plan(public_nodes=["tests/t.py::x"], hidden_nodes=["tests/t.py::x"])


def test_empty_hidden_rejected():
    with pytest.raises(GateError):
        _plan(hidden_nodes=[])


def test_seal_and_hash_roundtrip():
    frozen = FrozenTestExecutionPlans(plans={"t": _plan()}).sealed()
    assert frozen.content_hash == frozen.compute_hash()
    tampered = frozen.model_copy(update={"plans": {"t": _plan(hidden_nodes=["tests/t.py::z"])}})
    assert tampered.compute_hash() != frozen.content_hash    # a node change changes the hash


def test_tampered_frozen_file_blocks(tmp_path):
    frozen = FrozenTestExecutionPlans(plans={"t": _plan()}).sealed()
    d = json.loads(frozen.model_dump_json())
    d["plans"]["t"]["hidden_nodes"] = ["tests/t.py::evil"]   # change a node, keep the old hash
    (tmp_path / FROZEN_TEST_PLANS_FILENAME).write_text(json.dumps(d))
    with pytest.raises(GateError):
        load_frozen_test_execution_plans(str(tmp_path))


@pytest.mark.skipif(not os.path.exists(os.path.join(_CORPUS, FROZEN_TEST_PLANS_FILENAME)),
                    reason="frozen test-execution plans not generated yet")
def test_frozen_corpus_plans_all_exact_and_consistent():
    plans = load_frozen_test_execution_plans(_CORPUS)          # verifies hash + per-plan consistency
    assert len(plans.plans) >= 27
    for tid, p in plans.plans.items():
        assert p.hidden_nodes and all("::" in n for n in p.hidden_nodes), tid   # EXACT node ids
        assert not (set(p.hidden_nodes) & set(p.public_nodes)), tid
        assert p.test_overlay_files and p.overlay_aggregate_sha256, tid
