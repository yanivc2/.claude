"""C3–C6: the full single-agent LangGraph loop end to end."""
from __future__ import annotations

from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import get_case
from meta_orchestrator.seed_task.definition import BugCase

# A case whose category no mock model can solve → both attempts fail (drives retry + blocked path).
UNSOLVABLE = BugCase(
    bug_id="unsolvable_demo",
    category="unknown_cat",
    module_filename="solution.py",
    module_source="def f():\n    return 0\n",          # tests want 1 → always fails
    test_source="from solution import f\n\ndef test_f():\n    assert f() == 1\n",
    reference_fix="def f():\n    return 1\n",
)


def test_successful_run_end_to_end(booted):
    store, registry, config = booted
    orch = Orchestrator(store, registry, config)
    out = orch.run(get_case("off_by_one_sum"), run_id="run-ok")

    assert out.passed is True
    assert out.status == "completed"
    assert out.selected_model == "mock-strong"   # highest utility, and it solves the case
    assert out.rounds == 1
    assert out.postmortem["actual_passed"] is True
    assert out.postmortem["playbook_updated"] is True
    # decision records were persisted (select_model + postmortem)
    assert len(store.list_decision_records("run-ok")) >= 2
    # trace covers the whole pipeline
    nodes = {e.get("node") for e in out.trace}
    assert {"classify", "read_memory", "plan", "select_model", "execute",
            "verify", "synthesize", "independent_verify", "postmortem"} <= nodes


def test_playbook_written_after_success(booted):
    store, registry, config = booted
    orch = Orchestrator(store, registry, config)
    out = orch.run(get_case("wrong_return_max"), run_id="run-pb")
    entry = store.get_playbook(out.playbook_key)
    assert entry is not None
    assert entry.content["best_model"] == "mock-strong"


def test_unsolvable_run_retries_then_blocks(booted):
    store, registry, config = booted
    orch = Orchestrator(store, registry, config)
    out = orch.run(UNSOLVABLE, run_id="run-blocked")

    assert out.passed is False
    assert out.status == "blocked"           # independent verifier blocked the artifact
    assert out.rounds == 2                    # both candidates tried (bounded retry)
    assert set(_tried(out)) == {"mock-strong", "mock-weak"}
    assert out.postmortem["actual_passed"] is False
    assert out.postmortem["failure_category"] == "TestsFailed"
    assert out.postmortem["playbook_updated"] is False  # no lesson written on failure


def test_independent_verifier_does_not_rewrite_failing_artifact(booted):
    store, registry, config = booted
    orch = Orchestrator(store, registry, config)
    out = orch.run(UNSOLVABLE, run_id="run-noverwrite")
    # the failing synthesis was NOT silently fixed — status stays blocked
    assert out.status == "blocked"


def _tried(outcome) -> list:
    for e in reversed(outcome.trace):
        pass
    # reconstruct tried models from select_model trace events
    return [e["chosen"] for e in outcome.trace if e.get("node") == "select_model"]
