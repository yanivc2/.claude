"""§2 offline harness — condition isolation, C lifecycle, B1 placebo, sealing, mock behaviours.

Everything here is offline and model-free: the REAL Sandbox + composite verifier run over tiny
synthetic stand-in tasks. No network, no API.
"""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.artifacts import ArtifactStore
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.runner import ControlledRunner
from meta_orchestrator.experiment.store import ExperimentDB
from meta_orchestrator.experiment.verifier import verifier_config_hash
from meta_orchestrator.experiment.s2 import (CONDITIONS, LessonSensitiveMock, MemoryFrozenError,
                                             OutcomesSealedError, PlaceboRouter, RealRunBlocked,
                                             S2Harness, SEMANTIC_FAMILIES, build_synthetic_corpus,
                                             continue_decision, learn_bank, render_lines,
                                             resolve_memory, stratified_folds, validate_folds)
from meta_orchestrator.experiment.s2.gate import StabilitySignals
from meta_orchestrator.experiment.s2.lifecycle import MockLearner
from meta_orchestrator.experiment.s2.memory import (KIND_FAMILY_RELEVANT, StaticPlaybook,
                                                    parse_mem_tag)
from meta_orchestrator.experiment.s2.mocks import KIND_HARMFUL
from meta_orchestrator.experiment.s2.report import fixture_playbook
from meta_orchestrator.experiment.s2.synthetic import synthetic_task

REAL_27 = [
    "black-112", "black-130", "black-132", "black-133", "black-141", "black-1632", "black-183",
    "black-185", "black-193", "black-215", "black-224", "black-232", "black-234", "black-238",
    "black-273", "black-329", "black-334", "black-335", "black-385", "black-389", "black-593",
    "black-60", "black-74", "black-80", "black-95", "cookiecutter-18", "discord.py-7818",
]


def _map(ids, fams=SEMANTIC_FAMILIES):
    return {tid: fams[i % len(fams)] for i, tid in enumerate(sorted(ids))}


# A 6-task map (2 held-out per fold) for tests that actually RUN folds through the real
# verifier — keeps subprocess-pytest cost low without changing the logic under test.
def _small_map():
    return _map([f"t-{i}" for i in range(6)])


def _mock_contract():
    return AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                         tool_definitions=AgentTools.NAMES, system_prompt_hash=prompt_hash("frozen"))


def _run(task, context_lines, condition="A"):
    db = ExperimentDB(":memory:")
    runner = ControlledRunner(db, ArtifactStore("/tmp/mo_s2_test"))
    res = runner.run(task, condition, LessonSensitiveMock(task), _mock_contract(),
                     playbook_context=context_lines, run_id=f"{condition}:{task.task_id}")
    db.close()
    return res


# --- folds -------------------------------------------------------------------------------
def test_stratified_folds_partition_each_task_held_out_once():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, k=3)
    assert len(folds) == 3
    validate_folds(folds, sorted(fmap))                      # raises if partition broken
    held = sorted(t for f in folds for t in f.test_ids)
    assert held == sorted(fmap)                              # every task exactly once
    for f in folds:
        assert not (set(f.train_ids) & set(f.test_ids))     # disjoint


def test_folds_are_deterministic():
    fmap = _map(REAL_27)
    a = stratified_folds(fmap, 3)
    b = stratified_folds(fmap, 3)
    assert [f.test_ids for f in a] == [f.test_ids for f in b]


def test_folds_stratified_families_spread_across_folds():
    fmap = _map(REAL_27)
    folds = stratified_folds(fmap, 3)
    # whitespace has 4 tasks → should appear in test sets of >= 2 folds, not all in one.
    per_fold = [sum(1 for t in f.test_ids if fmap[t] == "whitespace") for f in folds]
    assert max(per_fold) <= 2 and sum(per_fold) == 4


# --- placebo (B1) ------------------------------------------------------------------------
def test_placebo_no_fixed_point_and_hash_locked():
    p = PlaceboRouter.build()
    for fam in SEMANTIC_FAMILIES:
        assert p.route(fam) != fam
    assert p.map_hash() == PlaceboRouter.build().map_hash()   # deterministic / hash-locked


# --- condition isolation -----------------------------------------------------------------
def test_only_memory_component_differs_across_conditions():
    fmap = _map(REAL_27)
    corpus = build_synthetic_corpus(fmap)
    h = S2Harness(fmap, corpus, _mock_contract(), fixture_playbook(), k=3)
    bank = h._learn_fold_bank(h.folds[0])
    fam = corpus[sorted(fmap)[0]].task_family
    ctxs = {c: resolve_memory(c, fam, bank=bank, playbook=h.playbook, placebo=h.placebo)
            for c in CONDITIONS}
    # A is empty; C/B1/D each carry a memory slot; the component_kind is the only per-condition tag.
    assert render_lines(ctxs["A"]) == []
    assert {c: ctxs[c].component_kind for c in CONDITIONS} == {
        "A": "none", "C": KIND_FAMILY_RELEVANT, "D": "static_playbook", "B1": "other_family"}
    # C injects THIS family; B1 injects a DIFFERENT family; same rendered shape (tag + bullets).
    assert ctxs["C"].source_family == fam
    assert ctxs["B1"].source_family == h.placebo.route(fam) != fam
    for c in ("C", "B1", "D"):
        assert render_lines(ctxs[c])[0].startswith("@@MEM ")


# --- C lifecycle -------------------------------------------------------------------------
def test_bank_learns_from_train_families_only():
    fmap = _map(REAL_27)
    corpus = build_synthetic_corpus(fmap)
    h = S2Harness(fmap, corpus, _mock_contract(), fixture_playbook(), k=3)
    fold = h.folds[0]
    train_families = {fmap[t] for t in fold.train_ids}
    bank = h._learn_fold_bank(fold)
    assert set(bank.families_present()) <= train_families


def test_frozen_bank_refuses_writes():
    bank = learn_bank([synthetic_task("t1", "whitespace")], MockLearner())
    assert bank.frozen is True
    with pytest.raises(MemoryFrozenError):
        bank.add("whitespace", MockLearner()(synthetic_task("t2", "whitespace")))


def test_bank_content_hash_stable():
    b1 = learn_bank([synthetic_task("t1", "iterator")], MockLearner())
    b2 = learn_bank([synthetic_task("t1", "iterator")], MockLearner())
    assert b1.content_hash() == b2.content_hash()


# --- cross-fold isolation ----------------------------------------------------------------
def test_cross_fold_banks_are_independent():
    fmap = _map(REAL_27)
    corpus = build_synthetic_corpus(fmap)
    h = S2Harness(fmap, corpus, _mock_contract(), fixture_playbook(), k=3)
    banks = [h._learn_fold_bank(f) for f in h.folds]
    # Different train sets → generally different frozen content; never a shared object.
    assert banks[0] is not banks[1]
    # A lesson id present because a family is in train of one fold may be absent in another.
    all_families = [set(b.families_present()) for b in banks]
    assert all_families[0] and all_families[1]              # each learned something


# --- sealed outcomes ---------------------------------------------------------------------
def test_effect_table_sealed_until_finalize():
    fmap = _small_map()
    corpus = build_synthetic_corpus(fmap)
    h = S2Harness(fmap, corpus, _mock_contract(), fixture_playbook(), k=3)
    h.run_fold(h.folds[0])
    with pytest.raises(OutcomesSealedError):
        h.outcomes.effect_table()
    # stability / cost / harness signals ARE available while sealed
    assert h.outcomes.cost_signals()["attempts"] > 0
    assert "verifier_config_hash" in h.outcomes.harness_signals()
    h.outcomes.finalize()
    assert isinstance(h.outcomes.effect_table(), dict)


def test_resume_does_not_double_runs():
    fmap = _small_map()
    corpus = build_synthetic_corpus(fmap)
    h = S2Harness(fmap, corpus, _mock_contract(), fixture_playbook(), k=3)
    h.run_fold(h.folds[0])
    n1 = h.outcomes.cost_signals()["attempts"]
    h.run_fold(h.folds[0])                                  # resume same fold
    assert h.outcomes.cost_signals()["attempts"] == n1


# --- mock behaviours (through the REAL verifier) -----------------------------------------
def test_relevant_family_lesson_passes():
    task = synthetic_task("black-1", "whitespace")
    ctx = [f"@@MEM kind={KIND_FAMILY_RELEVANT} family=whitespace", "- minimal edit"]
    assert _run(task, ctx, "C").passed is True


def test_misrouted_b1_lesson_does_not_help():
    task = synthetic_task("black-1", "whitespace")
    ctx = [f"@@MEM kind=other_family family=iterator", "- minimal edit"]
    assert _run(task, ctx, "B1").passed is False


def test_ablation_no_memory_fails():
    task = synthetic_task("black-1", "whitespace")
    assert _run(task, [], "A").passed is False


def test_harmful_lesson_is_nullified_by_verifier():
    task = synthetic_task("black-1", "whitespace")
    ctx = [f"@@MEM kind={KIND_HARMFUL} family=whitespace", "- hardcode the answer"]
    res = _run(task, ctx, "C")
    assert res.passed is False
    assert res.failing_gate in ("no_forbidden_shortcuts", "hidden_tests")


def test_reset_reproduces_result():
    task = synthetic_task("black-1", "whitespace")
    ctx = [f"@@MEM kind={KIND_FAMILY_RELEVANT} family=whitespace", "- minimal edit"]
    assert _run(task, ctx, "C").passed == _run(task, ctx, "C").passed is True


def test_parse_mem_tag_roundtrip():
    fam = "iterator"
    ctx = render_lines(resolve_memory(
        "C", fam, bank=learn_bank([synthetic_task("t", fam)], MockLearner())))
    assert parse_mem_tag(ctx) == (KIND_FAMILY_RELEVANT, fam)
    assert parse_mem_tag([]) == ("none", None)


# --- gate --------------------------------------------------------------------------------
def test_gate_admits_reps1_when_stable():
    s = StabilitySignals(n=9, a_flips=0, c_flips=1, sign_reversed=False, verifier_deterministic=True)
    d = continue_decision(s, cost_within_breaker=True, harness_healthy=True)
    assert d.go is True


def test_gate_blocks_on_instability_or_sign_reversal():
    unstable = StabilitySignals(n=9, a_flips=3, c_flips=0, sign_reversed=False,
                                verifier_deterministic=False)
    assert continue_decision(unstable, cost_within_breaker=True, harness_healthy=True).go is False
    reversed_ = StabilitySignals(n=9, a_flips=0, c_flips=0, sign_reversed=True,
                                 verifier_deterministic=True)
    assert continue_decision(reversed_, cost_within_breaker=True, harness_healthy=True).go is False
    assert continue_decision(
        StabilitySignals(n=9, a_flips=0, c_flips=0, sign_reversed=False, verifier_deterministic=True),
        cost_within_breaker=False, harness_healthy=True).go is False


# --- real-run guard ----------------------------------------------------------------------
def test_real_run_blocked_until_frozen():
    fmap = _map(REAL_27)
    corpus = build_synthetic_corpus(fmap)
    real = AgentContract(provider="anthropic", exact_model_id="claude-haiku-4-5-20251001",
                         agent_version="0.1", tool_definitions=AgentTools.NAMES)
    h = S2Harness(fmap, corpus, real, fixture_playbook(), k=3, synthetic_map=True)
    with pytest.raises(RealRunBlocked):
        h.assert_real_run_allowed()


def test_real_run_allowed_when_map_and_playbook_frozen():
    fmap = _map(REAL_27)
    corpus = build_synthetic_corpus(fmap)
    real = AgentContract(provider="anthropic", exact_model_id="claude-haiku-4-5-20251001",
                         agent_version="0.1", tool_definitions=AgentTools.NAMES)
    frozen_pb = StaticPlaybook(by_family={f: ["minimal edit"] for f in SEMANTIC_FAMILIES},
                               author_frozen=True, author="independent")
    h = S2Harness(fmap, corpus, real, frozen_pb, k=3, synthetic_map=False)
    h.assert_real_run_allowed()                             # must not raise


def test_mock_provider_never_blocked():
    fmap = _map(REAL_27)
    corpus = build_synthetic_corpus(fmap)
    h = S2Harness(fmap, corpus, _mock_contract(), fixture_playbook(), k=3, synthetic_map=True)
    h.assert_real_run_allowed()                             # mock always allowed


def test_verifier_config_hash_stable():
    assert verifier_config_hash() == verifier_config_hash()


# --- REAL frozen family map (produced by examples/s2_build_family_map.py, $0, no model) ---
_REAL_MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "corpus", "s2_family_map.json")


def _load_real_map():
    if not os.path.exists(_REAL_MAP):
        pytest.skip("real family map not generated yet")
    doc = json.load(open(_REAL_MAP))
    if doc.get("synthetic", True):
        pytest.skip("family map is still synthetic")
    return doc


def test_real_map_frozen_27_balanced_no_gaps():
    doc = _load_real_map()
    fmap = doc["family_map"]
    assert doc["synthetic"] is False and doc["frozen"] is True
    assert len(fmap) == 27 and len(set(fmap)) == 27
    assert doc["corpus_manifest_sha256"].startswith("cee0c602")
    folds = stratified_folds(fmap, doc["k_folds"])
    validate_folds(folds, sorted(fmap))
    assert [len(f.test_ids) for f in folds] == [9, 9, 9]
    from meta_orchestrator.experiment.s2 import train_representation_gaps
    assert train_representation_gaps(folds, fmap) == []       # every test family in train


def test_real_map_b1_placebo_over_present_families_no_fixed_point():
    doc = _load_real_map()
    present = sorted(set(doc["family_map"].values()))
    p = PlaceboRouter.build(present)
    for fam in present:
        assert p.route(fam) != fam and p.route(fam) in present
    # matches the frozen record
    assert p.map_hash() == doc["b1_placebo"]["map_hash"]


def test_real_map_real_run_guard_allows_when_playbook_frozen():
    doc = _load_real_map()
    fmap = doc["family_map"]
    corpus = build_synthetic_corpus(fmap)
    real = AgentContract(provider="anthropic", exact_model_id="claude-haiku-4-5-20251001",
                         agent_version="0.1", tool_definitions=AgentTools.NAMES)
    # frozen real map + fixture (unfrozen) D → still blocked on D
    h = S2Harness(fmap, corpus, real, fixture_playbook(), k=3, synthetic_map=doc["synthetic"])
    with pytest.raises(RealRunBlocked):
        h.assert_real_run_allowed()
    # frozen real map + author-frozen D → allowed
    frozen_pb = StaticPlaybook(by_family={f: ["minimal edit"] for f in SEMANTIC_FAMILIES},
                               author_frozen=True, author="independent")
    S2Harness(fmap, corpus, real, frozen_pb, k=3,
              synthetic_map=doc["synthetic"]).assert_real_run_allowed()
