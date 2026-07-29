"""A2 + taxonomy: seed task definition + classification/keying."""
from __future__ import annotations

from meta_orchestrator.seed_task import SEED_CORPUS, describe_seed_task
from meta_orchestrator.taxonomy import SEED_TASK_TYPE, classify_seed_task


def test_seed_classification_and_playbook_key():
    c = classify_seed_task()
    assert c.labels[-1] == SEED_TASK_TYPE
    assert c.provisional is True  # SPEC §8: reversible best-guess
    assert c.playbook_key() == "Software:Debug|risk:low|verifiable:yes"


def test_seed_task_has_objective_success_rule():
    d = describe_seed_task()
    assert d["task_type"] == SEED_TASK_TYPE
    assert "pytest" in d["success_rule"]
    assert d["breadth"]["verifiable"] == "yes"
    assert d["breadth"]["subjective_dimension"] is False


def test_corpus_cases_are_structurally_valid():
    assert len(SEED_CORPUS) >= 3
    for case in SEED_CORPUS:
        # buggy source and reference fix both compile, and they differ.
        compile(case.module_source, case.module_filename, "exec")
        compile(case.reference_fix, case.module_filename, "exec")
        compile(case.test_source, "test_solution.py", "exec")
        assert case.module_source != case.reference_fix
        assert case.bug_id and case.category
