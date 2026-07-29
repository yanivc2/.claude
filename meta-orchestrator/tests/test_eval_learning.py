"""D3: the Phase 1 success criterion — the system learns/improves across runs."""
from __future__ import annotations

from meta_orchestrator.evaluation.harness import EvalHarness
from meta_orchestrator.models import EvalScore
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import SEED_CORPUS
from meta_orchestrator.taxonomy import SEED_TASK_TYPE
from meta_orchestrator.utils import today_iso


def _seed_misleading_prior(registry) -> None:
    registry.record_eval_score("mock-weak", EvalScore(task_type=SEED_TASK_TYPE, score=0.70,
                                                      n_samples=0, date=today_iso(), source="mislead"))
    registry.record_eval_score("mock-strong", EvalScore(task_type=SEED_TASK_TYPE, score=0.50,
                                                        n_samples=0, date=today_iso(), source="mislead"))


def test_playbook_improves_across_runs(booted):
    store, registry, config = booted
    _seed_misleading_prior(registry)      # start the system off believing the WRONG model is best
    orch = Orchestrator(store, registry, config)

    report = EvalHarness(orch).run(SEED_CORPUS, repeats=5)

    # It corrects the bad prior from verified outcomes:
    assert report.first_choice_trend[0] == "mock-weak"      # misled at the start
    assert report.best_model_final == "mock-strong"          # learned the truth
    assert report.converged                                  # first choice stabilised
    assert report.confidence_increased                       # playbook confidence grew
    # improvement shows up as fewer retry rounds late vs early
    assert report.late_avg_rounds <= report.early_avg_rounds
    assert report.bandit_means_final["mock-strong"] > report.bandit_means_final["mock-weak"]
    assert report.phase1_pass is True


def test_confidence_trend_is_monotonic_nondecreasing(booted):
    store, registry, config = booted
    orch = Orchestrator(store, registry, config)
    report = EvalHarness(orch).run(SEED_CORPUS, repeats=3)
    trend = report.playbook_confidence_trend
    assert all(b >= a for a, b in zip(trend, trend[1:]))     # never regresses
