"""Corpus ingestion contract, exercised against the synthetic FixtureCorpusSource."""
from __future__ import annotations

import pytest

from meta_orchestrator.corpus.build import CandidateRejected, build_corpus_task
from meta_orchestrator.corpus.evaluator import evaluate_patch, to_agent_task
from meta_orchestrator.corpus.fixture_source import FixtureCorpusSource
from meta_orchestrator.corpus.manifest import seal_holdout, verify_holdout
from meta_orchestrator.corpus.patch_guard import check_patch
from meta_orchestrator.corpus.qualification import qualify_candidate
from meta_orchestrator.corpus.report import build_report
from meta_orchestrator.corpus.sanitize import sanitize_statement
from meta_orchestrator.experiment.sandbox import Sandbox

SRC = FixtureCorpusSource()


# --- §4 qualification -------------------------------------------------------
def test_qualification_classifies_f2p_and_p2p():
    q = qualify_candidate(SRC.get("fx-sum-offbyone"))
    assert q.admitted is True
    assert q.f2p_files == ["tests/test_behavior.py"]      # fail-on-buggy, pass-on-fixed → hidden
    assert q.p2p_files == ["tests/test_regression.py"]    # pass on both → public


def test_qualification_rejects_non_clean_buggy():
    q = qualify_candidate(SRC.get("fx-broken"))            # buggy has a syntax error
    assert q.admitted is False
    assert "compile" in q.reason


# --- §7 sanitize ------------------------------------------------------------
def test_sanitizer_strips_solution_leak():
    r = sanitize_statement(SRC.get("fx-sum-offbyone"))
    assert r.usable is True
    assert "the fix is" not in r.sanitized.lower()
    assert "range(1, n + 1)" not in r.sanitized
    assert ".py" not in r.sanitized
    assert r.log  # removals were recorded


def test_sanitizer_flags_vague_statement():
    assert sanitize_statement(SRC.get("fx-vague")).usable is False


# --- §5/§11 build -----------------------------------------------------------
def test_build_splits_hidden_and_public():
    task = build_corpus_task(SRC.get("fx-sum-offbyone"))
    assert list(task.hidden_tests) == ["tests_hidden/test_behavior.py"]
    assert list(task.public_tests) == ["tests_public/test_regression.py"]
    assert task.reference_patch and task.patch_size.files == 1
    assert task.problem_statement_raw and "the fix is" not in task.problem_statement_sanitized.lower()


@pytest.mark.parametrize("cid", ["fx-vague", "fx-broken"])
def test_build_rejects_bad_candidates(cid):
    with pytest.raises(CandidateRejected):
        build_corpus_task(SRC.get(cid))


# --- §6 physical isolation --------------------------------------------------
def test_agent_zone_has_no_hidden_tests():
    task = build_corpus_task(SRC.get("fx-sum-offbyone"))
    agent_task = to_agent_task(task)
    assert agent_task.hidden_tests == {}
    # nothing in the agent sandbox contains the hidden behavioural probe
    with Sandbox(agent_task) as sb:
        blob = "".join(p.read_text() for p in sb.root.rglob("*") if p.is_file())
    assert "sum_to(5) == 15" not in blob          # the hidden F2P assertion is absent
    assert "sum_to(0) == 0" in blob               # the public P2P guard is present


def test_evaluator_runs_hidden_tests_on_the_patch():
    task = build_corpus_task(SRC.get("fx-sum-offbyone"))
    assert evaluate_patch(task, task.buggy_source).passed is False        # buggy fails hidden
    assert evaluate_patch(task, {"solution.py": "def sum_to(n):\n    return sum(range(1, n + 1))\n"}).passed is True
    assert evaluate_patch(task, {"solution.py": "def sum_to(n):\n    return 15\n"}).passed is False  # cheat caught


# --- §8 patch guard ---------------------------------------------------------
def test_patch_guard():
    assert check_patch(["solution.py"], ["solution.py"]).ok is True
    assert check_patch(["tests_hidden/test_x.py"], ["solution.py"]).ok is False   # edits a test
    assert check_patch(["setup.py"], ["solution.py"]).ok is False                 # edits setup
    r = check_patch(["solution.py", "tests/test_x.py"], ["solution.py"])
    assert r.ok is False and any("test" in v for v in r.violations)


# --- §10 holdout manifest ---------------------------------------------------
def test_holdout_manifest_seal_and_tamper_detection():
    tasks = [build_corpus_task(SRC.get("fx-sum-offbyone")),
             build_corpus_task(SRC.get("fx-even-operator"))]
    manifest = seal_holdout(tasks)
    assert verify_holdout(manifest, tasks) is True
    assert seal_holdout(tasks).manifest_hash == manifest.manifest_hash   # time-independent
    # tamper: change a hidden test → verification fails (holdout no longer trustworthy)
    tasks[0].hidden_tests["tests_hidden/test_behavior.py"] += "\ndef test_extra():\n    assert True\n"
    assert verify_holdout(manifest, tasks) is False


# --- §3 candidate report ----------------------------------------------------
def test_candidate_report():
    report = build_report(SRC)
    assert report.total_candidates == 4
    assert report.admitted == 2                       # sum + even; vague + broken rejected
    by_id = {r.candidate_id: r for r in report.rows}
    assert by_id["fx-sum-offbyone"].admitted is True
    assert by_id["fx-sum-offbyone"].valid_f2p == 1
    assert by_id["fx-vague"].admitted is False
    assert by_id["fx-broken"].admitted is False
    assert all(r.reproducible_now for r in report.rows)
    assert all(r.baseline_success is None for r in report.rows)  # needs a solver run (flagged)
