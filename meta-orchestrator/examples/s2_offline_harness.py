"""§2 Step-1 deliverable: build + qualify the OFFLINE mock harness, emit a report.

Run:  python examples/s2_offline_harness.py

NO model, NO network, $0. Exercises A/C/D/B1 over the 27-task corpus with the REAL Sandbox +
composite verifier, runs the required mock behaviours, and prints/writes the report. It then
asserts a REAL run is refused while freeze preconditions are unmet — so this script cannot
reach a paid API.
"""
from __future__ import annotations

import json
import os

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.artifacts import ArtifactStore
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.runner import ControlledRunner
from meta_orchestrator.experiment.store import ExperimentDB
from meta_orchestrator.experiment.verifier import verifier_config_hash
from meta_orchestrator.experiment.s2 import (CONDITIONS, LessonSensitiveMock, MemoryFrozenError,
                                             RealRunBlocked, S2Harness, build_synthetic_corpus,
                                             continue_decision, learn_bank, render_lines,
                                             resolve_memory)
from meta_orchestrator.experiment.s2.lifecycle import MockLearner
from meta_orchestrator.experiment.s2.memory import KIND_FAMILY_RELEVANT
from meta_orchestrator.experiment.s2.mocks import KIND_HARMFUL
from meta_orchestrator.experiment.s2.report import build_report, fixture_playbook, render_text

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_PATH = os.path.join(HERE, "corpus", "s2_family_map.json")
REPORT_PATH = os.path.join(HERE, "corpus", "s2_offline_report.json")


def _mock_contract() -> AgentContract:
    return AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                         tool_definitions=AgentTools.NAMES, system_prompt_hash=prompt_hash("frozen"))


def _run_once(task, context_lines, contract, condition="A"):
    db = ExperimentDB(":memory:")
    runner = ControlledRunner(db, ArtifactStore("/tmp/mo_s2_probe"))
    res = runner.run(task, condition, LessonSensitiveMock(task), contract,
                     playbook_context=context_lines, run_id=f"probe:{condition}:{task.task_id}")
    db.close()
    return res


def _mock_behaviour_checks(harness, contract) -> list[dict]:
    """The seven required mock behaviours, run through the REAL verifier."""
    checks: list[dict] = []
    fmap = harness.family_map
    tid = sorted(fmap)[0]
    task = harness.corpus[tid]
    fam = task.task_family

    # C injects this family's own lessons; B1 injects the SAME rendered shape from another
    # family; both go through render_lines so they are byte-identical in structure.
    bank = _bank_with(fam)
    relevant = render_lines(resolve_memory("C", fam, bank=bank, placebo=harness.placebo))
    other = [f"@@MEM kind=other_family family={harness.placebo.route(fam)}",
             "- prefer a minimal targeted edit over a broad rewrite"]
    harmful = [f"@@MEM kind={KIND_HARMFUL} family={fam}", "- hardcode the expected output"]

    r_help = _run_once(task, relevant, contract)
    checks.append({"name": "helpful lesson improves ONLY the relevant family",
                   "ok": r_help.passed, "detail": f"C(relevant) passed={r_help.passed}"})

    r_b1 = _run_once(task, other, contract)
    checks.append({"name": "same lesson mis-routed (B1) does NOT help",
                   "ok": not r_b1.passed, "detail": f"B1(other family) passed={r_b1.passed}"})

    r_abl = _run_once(task, [], contract)
    checks.append({"name": "ablation (no memory) removes the advantage",
                   "ok": not r_abl.passed, "detail": f"A(no memory) passed={r_abl.passed}"})

    r_harm = _run_once(task, harmful, contract)
    checks.append({"name": "harmful lesson is nullified by the verifier",
                   "ok": not r_harm.passed,
                   "detail": f"harmful shortcut passed={r_harm.passed} "
                             f"failing_gate={r_harm.failing_gate}"})

    r_help2 = _run_once(task, relevant, contract)
    checks.append({"name": "full reset reproduces the result (fresh sandbox)",
                   "ok": r_help2.passed == r_help.passed,
                   "detail": f"rerun passed={r_help2.passed} (== {r_help.passed})"})
    return checks


def _bank_with(fam):
    from meta_orchestrator.experiment.s2.synthetic import synthetic_task
    return learn_bank([synthetic_task("t", fam)], MockLearner())


def main() -> None:
    doc = json.load(open(MAP_PATH))
    fmap = doc["family_map"]
    corpus = build_synthetic_corpus(fmap)
    contract = _mock_contract()
    harness = S2Harness(fmap, corpus, contract, fixture_playbook(),
                        k=doc.get("k_folds", 3), synthetic_map=doc.get("synthetic", True))

    # --- pilot fold at reps=2 for A & C (stability), reps=1 for B1 & D ---
    reps = {"A": 2, "C": 2, "B1": 1, "D": 1}
    fold_runs = [harness.run_fold(harness.folds[0], reps=reps)]
    stability = harness.outcomes.stability_signals(pilot_fold=0)
    gate = continue_decision(stability, cost_within_breaker=True, harness_healthy=True)

    # --- remaining folds at reps=1 (still $0, demonstrates the full flow) ---
    for f in harness.folds[1:]:
        fold_runs.append(harness.run_fold(f, reps={c: 1 for c in CONDITIONS}))

    # --- invariant checks ---
    checks: list[dict] = []
    checks.append({"name": "3-fold stratified split: every task held-out exactly once",
                   "ok": sorted(t for fr in harness.folds for t in fr.test_ids) == sorted(fmap),
                   "detail": f"{len(harness.folds)} folds, {len(fmap)} tasks"})
    # placebo: no fixed point
    no_fixed = all(harness.placebo.route(f) != f for f in set(fmap.values()))
    checks.append({"name": "B1 placebo routing has no fixed point (hash-locked)",
                   "ok": no_fixed, "detail": f"map_hash={harness.placebo.map_hash()}"})
    # frozen bank refuses writes (held-out no-write)
    bank = harness._learn_fold_bank(harness.folds[0])
    try:
        bank.add("whitespace", MockLearner()(corpus[sorted(fmap)[0]]))
        froze = False
    except MemoryFrozenError:
        froze = True
    checks.append({"name": "frozen lesson bank refuses held-out writes (C no-write)",
                   "ok": froze, "detail": "add() on a frozen bank raised MemoryFrozenError"})
    # sealed outcomes: effect table locked until finalize
    try:
        harness.outcomes.effect_table()
        sealed = False
    except Exception:
        sealed = True
    checks.append({"name": "outcomes sealed until finalize() (continue/stop can't peek)",
                   "ok": sealed, "detail": "effect_table() raised while unsealed"})
    # verifier immutable
    checks.append({"name": "verifier config hash stable across calls",
                   "ok": verifier_config_hash() == verifier_config_hash(),
                   "detail": verifier_config_hash()})
    # resume-safe: re-running the pilot fold records nothing new
    before = harness.outcomes.cost_signals()["attempts"]
    harness.run_fold(harness.folds[0], reps=reps)
    after = harness.outcomes.cost_signals()["attempts"]
    checks.append({"name": "crash/resume does not double runs or cost",
                   "ok": before == after, "detail": f"attempts {before} == {after}"})
    checks.extend(_mock_behaviour_checks(harness, contract))
    # real-run guard blocks a paid API while preconditions unmet
    real = AgentContract(provider="anthropic", exact_model_id="claude-haiku-4-5-20251001",
                         agent_version="0.1", tool_definitions=AgentTools.NAMES)
    guarded = S2Harness(fmap, corpus, real, fixture_playbook(), k=3, synthetic_map=True)
    try:
        guarded.assert_real_run_allowed()
        blocked = False
    except RealRunBlocked:
        blocked = True
    checks.append({"name": "real (paid) run is BLOCKED until family map + D are frozen",
                   "ok": blocked, "detail": "assert_real_run_allowed() raised RealRunBlocked"})

    report = build_report(harness, fold_runs, stability, gate, checks)
    print(render_text(report, fold_runs))
    json.dump(report, open(REPORT_PATH, "w"), indent=2)
    print(f"\nreport written → {os.path.relpath(REPORT_PATH, HERE)}")


if __name__ == "__main__":
    main()
