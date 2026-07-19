"""Gate 1 orchestration — before paid C-training. Ready for the pilot env; DRY-RUN offline.

This script calls the SAME production decision function (`pilot.gate1_evaluate`) that the tests
and the real run use — it is NOT a parallel re-implementation. Offline it can only DRY-RUN: it
feeds the offline/proxy context-cap source, so `gate1_evaluate` returns production_valid=False and
`authorize_after_gate1` REFUSES to move the manifest to AUTHORIZED_FOR_FOLD1_C_TRAINING. Only the
pinned pilot env (real count_tokens, SDK-body green, 0 skips, budget OK) can pass Gate 1.

Usage: python examples/s2_gate1.py            # offline dry-run (never authorizes)
"""
from __future__ import annotations

import os

from meta_orchestrator.experiment.s2 import (Gate1Inputs, GateError, authorize_after_gate1,
                                             build_run_manifest, context_cap_preflight,
                                             gate1_evaluate)
from meta_orchestrator.experiment.s2 import build_synthetic_corpus
from meta_orchestrator.experiment.s2.token_counter import ProxyTokenCounter

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def gather_gate1_inputs(*, counter, tests_failed: int, tests_skipped: int, sdk_version: str,
                        httpx_version: str, serialized_body_ok: bool, max_retries_zero: bool,
                        budget_ok: bool, hashes_match: bool, snapshot_available: bool,
                        snapshot_within_retirement: bool, corpus) -> Gate1Inputs:
    """Assemble Gate-1 inputs. The context-cap preflight runs through the SAME counter the pilot
    injects; offline that is a ProxyTokenCounter (source=offline_proxy → cannot be production)."""
    cap = context_cap_preflight(corpus, counter=counter)
    return Gate1Inputs(
        tests_failed=tests_failed, tests_skipped=tests_skipped, sdk_version=sdk_version,
        httpx_version=httpx_version, serialized_body_ok=serialized_body_ok,
        max_retries_zero_proven=max_retries_zero, context_cap_source=cap.token_count_source,
        context_cap_fits_budget=budget_ok, all_hashes_match=hashes_match,
        snapshot_available=snapshot_available, snapshot_within_retirement=snapshot_within_retirement)


def main() -> None:
    corpus = build_synthetic_corpus({"black-1": "whitespace", "black-2": "iterator"})
    manifest = build_run_manifest("s2-pilot-dryrun", "HEAD", budget_usd=4.89, corpus_dir=_CORPUS)

    # OFFLINE dry-run: proxy counter + honest "not yet proven" flags for the pilot-only checks.
    inp = gather_gate1_inputs(counter=ProxyTokenCounter(), tests_failed=0, tests_skipped=2,
                              sdk_version="", httpx_version="", serialized_body_ok=False,
                              max_retries_zero=False, budget_ok=True, hashes_match=True,
                              snapshot_available=True, snapshot_within_retirement=True, corpus=corpus)
    report = gate1_evaluate(inp)

    print("=" * 78)
    print(f"GATE 1 (dry-run) — passed={report.passed} production_valid={report.production_valid}")
    print(f"token_count_source={report.token_count_source}")
    print("blocking reasons:", report.reasons)
    try:
        authorize_after_gate1(manifest, report, timestamp="dry-run")
        print("!! AUTHORIZED — this must NEVER happen offline")
    except GateError as e:
        print(f"correctly REFUSED to authorize offline: {e}")
    print(f"manifest status stays: {manifest.status}")
    print("\nIn the pinned pilot env, gather_gate1_inputs() is called with an AnthropicTokenCounter")
    print("(real count_tokens), the SDK-body/max_retries tests green (0 skips), pinned versions, and")
    print("a real budget check. Only then can gate1_evaluate pass and authorize fold-1 C-training.")
    print("=" * 78)


if __name__ == "__main__":
    main()
