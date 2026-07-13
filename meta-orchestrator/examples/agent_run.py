"""Milestone C demo: the full single-agent LangGraph loop on the seed task.

Run:  python examples/agent_run.py
"""
from __future__ import annotations

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import get_case


def approver(tool_name, args) -> bool:
    print(f"    [approval] HIGH-impact tool {tool_name!r} requested -> approving")
    return True


def main() -> None:
    store, registry, config = boot()
    try:
        orch = Orchestrator(store, registry, config)
        out = orch.run(get_case("off_by_one_sum"), run_id="demo-1", approver=approver)

        print(f"status={out.status} passed={out.passed} model={out.selected_model} "
              f"rounds={out.rounds} cost={out.cost} tokens={out.tokens_spent}")
        print("pipeline:", " → ".join(e["node"] for e in out.trace if "node" in e))
        print("post-mortem:", out.postmortem)
        print("Tier-1 playbook:", orch.reader.render(out.playbook_key))
    finally:
        store.close()


if __name__ == "__main__":
    main()
