"""Run the orchestrator against a REAL Claude model on the seed task.

Requires the `anthropic` SDK (`pip install -e ".[real]"`) and credentials.
Supply the key via META_ORCH_API_KEY (used verbatim, pointed at the real API) —
the reserved ANTHROPIC_API_KEY is stripped from Claude-Code-on-the-web sessions,
so a non-reserved name is needed there. Locally, ANTHROPIC_API_KEY or an
`ant auth login` profile still work. The Model Gateway resolves the model from
config → Registry (claude-opus-4-8 / claude-haiku-4-5); nothing is hardcoded.

Run:  python examples/real_run.py [bug_id]
"""
from __future__ import annotations

import sys

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.config import load_config
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import SEED_CORPUS, get_case


def main() -> None:
    bug_id = sys.argv[1] if len(sys.argv) > 1 else SEED_CORPUS[0].bug_id
    case = get_case(bug_id)

    # adapter="anthropic" → Registry seeds real Claude models + candidates.
    store, registry, config = boot(load_config(adapter="anthropic"))
    try:
        orch = Orchestrator(store, registry, config)  # builds a real Anthropic client on first use
        print(f"Running seed case {case.bug_id!r} against real models "
              f"{config.candidate_models[list(config.candidate_models)[0]]} ...")
        out = orch.run(case, run_id=f"real-{bug_id}")
        print(f"status={out.status} passed={out.passed} model={out.selected_model} "
              f"rounds={out.rounds} cost=${out.cost:.4f} tokens={out.tokens_spent}")
        print("post-mortem:", out.postmortem)
        print("Tier-1 playbook:", orch.reader.render(out.playbook_key))
    except ImportError:
        print("The 'anthropic' SDK is not installed. Run:  pip install -e \".[real]\"")
    except Exception as exc:  # most likely missing credentials
        print(f"Could not complete a live run ({type(exc).__name__}: {exc}).")
        print("Set META_ORCH_API_KEY (or ANTHROPIC_API_KEY / `ant auth login` "
              "locally), then retry.")
    finally:
        store.close()


if __name__ == "__main__":
    main()
