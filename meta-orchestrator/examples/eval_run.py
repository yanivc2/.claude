"""Milestone D demo: prove Phase 1 learning.

Seeds a *misleading* prior (favouring the weaker model), then runs the seed corpus
many times. The system should correct the prior from verified outcomes: converge its
first choice to the strong model, need fewer retry rounds, and grow playbook confidence.

Run:  python examples/eval_run.py
"""
from __future__ import annotations

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.evaluation.harness import EvalHarness
from meta_orchestrator.models import EvalScore
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import SEED_CORPUS
from meta_orchestrator.taxonomy import SEED_TASK_TYPE
from meta_orchestrator.utils import today_iso


def seed_misleading_prior(registry) -> None:
    # Override provenance so the CHEAP-but-WEAK model looks best a priori.
    registry.record_eval_score("mock-weak",
                               EvalScore(task_type=SEED_TASK_TYPE, score=0.70, n_samples=0,
                                         date=today_iso(), source="seed:misleading"))
    registry.record_eval_score("mock-strong",
                               EvalScore(task_type=SEED_TASK_TYPE, score=0.50, n_samples=0,
                                         date=today_iso(), source="seed:misleading"))


def main() -> None:
    store, registry, config = boot()
    try:
        seed_misleading_prior(registry)
        orch = Orchestrator(store, registry, config)
        report = EvalHarness(orch).run(SEED_CORPUS, repeats=5)
        print(report.summary())
        print("first-choice trend:", report.first_choice_trend)
        print("confidence trend  :", [round(c, 2) for c in report.playbook_confidence_trend])
        print("bandit means final:", report.bandit_means_final)
    finally:
        store.close()


if __name__ == "__main__":
    main()
