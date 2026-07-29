"""P0.3-5 + negative-control doubles — the hardening batch from the consultation review.

Mixed: the occupancy/gate tests are pure; the four-state and negative-control-separation tests
drive the REAL sandbox/verifier (subprocess pytest). All offline, model-free.
"""
from __future__ import annotations

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.lesson import Lesson, LessonEvidence, LessonTrigger
from meta_orchestrator.experiment.sandbox import Sandbox
from meta_orchestrator.experiment.task import ExperimentTask
from meta_orchestrator.experiment.s2 import (AttemptContract, FrozenLessonBank, LeakingLessonSolver,
                                             MemoryIgnoringRoundSolver, MemorySensitiveRoundSolver,
                                             PlaceboRouter, SEMANTIC_FAMILIES, SolverHarness,
                                             build_synthetic_corpus, evaluate_write_gate,
                                             occupancy_parity, run_attempt, synthetic_task)
from meta_orchestrator.experiment.s2.report import fixture_playbook


def _mock_contract():
    return AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                         tool_definitions=AgentTools.NAMES, system_prompt_hash=prompt_hash("frozen"))


def _map(ids, fams=SEMANTIC_FAMILIES):
    return {tid: fams[i % len(fams)] for i, tid in enumerate(sorted(ids))}


def _small_map():
    # 2 families × 3 tasks: every held-out family stays represented in train (no gap), so the
    # B1 parity selector has a valid derangement (matches the real 27-map invariant).
    return {f"t-{i}": ("whitespace" if i % 2 == 0 else "iterator") for i in range(6)}


# --- P0.3: held-out response-schema parity ------------------------------------------------
def test_held_out_c_emits_no_candidate_lesson():
    t = synthetic_task("black-1", "whitespace")
    ctx = ["@@MEM kind=family_relevant family=whitespace", "- minimal edit"]
    r = run_attempt(t, "C", ctx, MemorySensitiveRoundSolver(t, "C"), _mock_contract(),
                    AttemptContract(), is_train=False)
    assert r.candidate_lessons == []              # held-out never proposes → schema parity with A


def test_train_c_may_emit_candidate():
    t = synthetic_task("black-1", "whitespace")
    ctx = ["@@MEM kind=family_relevant family=whitespace", "- minimal edit"]
    r = run_attempt(t, "C", ctx, MemorySensitiveRoundSolver(t, "C"), _mock_contract(),
                    AttemptContract(), is_train=True)
    assert len(r.candidate_lessons) == 1          # only train proposes


# --- P0.4: four-state public result -------------------------------------------------------
def _task_with_public(public_body: str) -> ExperimentTask:
    return ExperimentTask(
        task_id="pub", task_family="whitespace",
        source={"solution.py": "def f():\n    return 1\n"},
        public_tests={"tests_public/test_p.py": public_body},
        hidden_tests={"tests_hidden/test_h.py": "def test_h():\n    assert True\n"},
        static_targets=["solution.py"])


def test_run_pytest_status_distinguishes_pass_fail_empty():
    passing = _task_with_public("def test_ok():\n    assert True\n")
    failing = _task_with_public("def test_no():\n    assert False\n")
    empty = _task_with_public("# no test functions here\n")
    with Sandbox(passing) as sb:
        assert sb.run_pytest_status("tests_public")[0] == "PASS"
    with Sandbox(failing) as sb:
        assert sb.run_pytest_status("tests_public")[0] == "FAIL"
    with Sandbox(empty) as sb:
        assert sb.run_pytest_status("tests_public")[0] == "NO_PUBLIC_TESTS"


def test_no_public_tests_does_not_open_round2():
    """An empty public suite must NOT buy a Round 2 (P0.4) — only a genuine FAIL does."""
    empty = _task_with_public("# no tests\n")

    class NoOp:
        name = "noop"

        def solve_round(self, view):
            from meta_orchestrator.experiment.s2 import RoundOutput
            return RoundOutput(patch={})

    r = run_attempt(empty, "A", [], NoOp(), _mock_contract(), AttemptContract())
    assert r.round1_public_status == "NO_PUBLIC_TESTS"
    assert r.model_calls == 1 and r.round2_opened is False


# --- P0.5: B1/C occupancy parity ----------------------------------------------------------
def test_occupancy_parity_equal_when_counts_match():
    # MockLearner-style: one lesson per family → C and B1 inject the same number of lines.
    fams = sorted(set(_map([f"t-{i}" for i in range(12)]).values()))
    bank = FrozenLessonBank(by_family={f: [_one_lesson(f)] for f in fams}, frozen=True)
    placebo = PlaceboRouter.build(fams)
    reports = occupancy_parity(bank, placebo, fams)
    assert all(r.equal for r in reports)


def test_occupancy_parity_flags_length_confound():
    fams = sorted(set(_map([f"t-{i}" for i in range(12)]).values()))
    by_family = {f: [_one_lesson(f)] for f in fams}
    by_family[fams[0]] = [_one_lesson(fams[0], "a"), _one_lesson(fams[0], "b")]  # 2 vs 1
    bank = FrozenLessonBank(by_family=by_family, frozen=True)
    placebo = PlaceboRouter.build(fams)
    reports = occupancy_parity(bank, placebo, fams)
    assert any(not r.equal for r in reports)      # the confound is surfaced, not hidden


def _one_lesson(family, suffix=""):
    return Lesson(lesson_id=f"L-{family}{suffix}", task_family=family,
                  trigger=LessonTrigger(symptoms=[f"s {family}"]),
                  recommended_action=[f"do the minimal thing {suffix}".strip()],
                  evidence=LessonEvidence(successes=1), status="active")


# --- negative controls --------------------------------------------------------------------
def test_memory_ignoring_double_shows_no_separation():
    """A double that ignores memory → A=C=D=B1 all pass. Proves the harness invents no effect."""
    fmap = _small_map()
    corpus = build_synthetic_corpus(fmap)
    h = SolverHarness(fmap, corpus, _mock_contract(), fixture_playbook(),
                      lambda task, cond: MemoryIgnoringRoundSolver(task, cond), k=3)
    h.run_fold(h.folds[0])
    h.outcomes.finalize()
    table = h.outcomes.effect_table()[0]
    for cond in ("A", "C", "D", "B1"):
        assert all(table[cond].values())          # every condition passes → no separation


def test_leaking_lesson_is_rejected_by_the_gate():
    """The leaking-lesson double emits a path/line/value lesson; the write-gate must reject it."""
    t = synthetic_task("black-1", "whitespace")
    from meta_orchestrator.experiment.s2 import RoundView
    out = LeakingLessonSolver(t, "C").solve_round(
        RoundView(round_index=1, task_id=t.task_id, task_family="whitespace",
                  source=dict(t.source), public_tests=dict(t.public_tests)))
    res = evaluate_write_gate(out.candidate_lesson, is_train=True, verifier_passed=True,
                              task_family="whitespace", existing=[])
    assert res.written is False
    assert any(r.startswith("leak:") for r in res.reasons)
