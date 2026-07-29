"""Milestone B demo: the learning backbone wired together (no agent loop yet).

Shows: real verify() (runs pytest) → bandit update → Decision Engine choice →
gated memory write → compact Tier-1 read. Run:  python examples/backbone.py
"""
from __future__ import annotations

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.decision.engine import DecisionEngine, build_model_options
from meta_orchestrator.learning.bandit import BanditBook
from meta_orchestrator.memory.reader import PlaybookReader
from meta_orchestrator.memory.writer import MemoryWriter
from meta_orchestrator.seed_task.corpus import get_case
from meta_orchestrator.taxonomy import SEED_TASK_TYPE, classify_seed_task
from meta_orchestrator.verification import verify_code_fix


def main() -> None:
    store, registry, config = boot()
    try:
        classification = classify_seed_task()
        bandit = BanditBook(store)
        engine = DecisionEngine(config.decision_weights)
        writer, reader = MemoryWriter(store), PlaybookReader(store)
        case = get_case("off_by_one_sum")

        # Simulate two candidate models producing candidates of differing quality,
        # verified by ACTUALLY running pytest.
        outcomes = {
            "mock-strong": verify_code_fix(case, case.reference_fix),   # correct → passes
            "mock-weak": verify_code_fix(case, case.module_source),     # unfixed → fails
        }
        for model_id, res in outcomes.items():
            prior = registry.prior_score(model_id, SEED_TASK_TYPE)
            bandit.update(SEED_TASK_TYPE, model_id, success=res.passed, prior_score=prior)
            print(f"[B1/B3] {model_id}: passed={res.passed} cat={res.failure_category.value} "
                  f"-> bandit_mean={bandit.estimate(SEED_TASK_TYPE, model_id):.3f}")

        # [B6] choose a model via the single utility function.
        candidates = registry.candidate_models(SEED_TASK_TYPE)
        p = {m.model_id: bandit.estimate(SEED_TASK_TYPE, m.model_id) for m in candidates}
        options = build_model_options(candidates, p)
        winner, _scored, record = engine.decide(options, run_id="demo", node="select_model",
                                                 budget_remaining=config.budget_tokens)
        store.add_decision_record(record)
        print(f"[B6] decision: chose {winner.option.label} (utility={winner.utility:.4f})")
        print(f"      reason: {record.reason}")

        # [B4] write the verified lesson for the winning model, then [B5] read it back compactly.
        writer.write(classification=classification, chosen_model=winner.option.label,
                     verify_result=outcomes[winner.option.label], bandit=bandit, cost=0.02)
        print(f"[B5] {reader.render(classification.playbook_key())}")
    finally:
        store.close()


if __name__ == "__main__":
    main()
