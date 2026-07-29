"""Milestone A demo: boot the system, connect to the DB, and resolve the model
choice from config through the Registry (nothing hardcoded).

Run:  python examples/boot.py
"""
from __future__ import annotations

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.seed_task import describe_seed_task
from meta_orchestrator.taxonomy import SEED_TASK_TYPE, classify_seed_task


def main() -> None:
    store, registry, config = boot()
    try:
        print(f"[A1] booted; db_path={config.db_path!r}; adapter={config.model_adapter!r}")

        print(f"[A1] taxonomy rows: {[n.label for n in store.list_taxonomy()]}")

        classification = classify_seed_task()
        print(f"[A2] seed task = {describe_seed_task()['what']}")
        print(f"[A2] success rule = {describe_seed_task()['success_rule']}")
        print(f"[A2] playbook key = {classification.playbook_key()}")

        # Model choice READ FROM CONFIG, resolved via Registry — not hardcoded.
        candidates = registry.candidate_models(SEED_TASK_TYPE)
        print(f"[A1] config candidates for {SEED_TASK_TYPE} -> "
              f"{[(m.model_id, m.provider) for m in candidates]}")
        for m in candidates:
            print(f"      {m.model_id}: prior_score={registry.prior_score(m.model_id, SEED_TASK_TYPE)} "
                  f"provenance={[s.source for s in m.eval_scores]}")
    finally:
        store.close()


if __name__ == "__main__":
    main()
