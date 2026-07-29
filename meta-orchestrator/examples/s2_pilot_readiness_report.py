"""§2 pilot-readiness report — maps each Gate GO/NO-GO condition to its offline test ($0).

Prints the manifest status, which gates can/can't be opened offline, and the condition→test map.
Runs NO network / paid call.
"""
from __future__ import annotations

import os

from meta_orchestrator.experiment.s2 import build_run_manifest

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")

# Each Gate condition → the offline test that enforces it.
CONDITION_TESTS = {
    "GATE 1": {
        "0 failed / 0 skipped required": "test_s2_pilot::test_gate1_blocks_on_each_condition[tests_skipped]",
        "SDK serialized-body proven": "test_s2_pilot::...[serialized_body] + test_s2_prepaid::test_sdk_serialized_body_omits_effort_and_temperature (pilot)",
        "max_retries=0 (one HTTP request)": "test_s2_prepaid::test_sdk_max_retries_zero_means_one_http_request (pilot) + test_s2_model_client::test_harness_does_not_retry_on_error",
        "context_cap from anthropic_count_tokens": "test_s2_pilot::test_gate1_proxy_cap_never_production_valid",
        "cost projection fits budget": "test_s2_pilot::test_gate1_blocks_on_each_condition[cost_projection_over_budget]",
        "snapshot available + not retired": "test_s2_pilot::test_gate1_blocks_on_each_condition[snapshot_past_retirement]",
        "offline can NEVER authorize": "test_s2_pilot::test_offline_gate1_cannot_authorize",
    },
    "GATE 2": {
        "18/18 terminal non-infra train": "test_s2_pilot::test_gate2_blocks_on_each_condition[training_incomplete] + test_s2_gates::test_training_incomplete_blocks_held_out",
        "no held-out call before Gate 2": "test_s2_pilot::...[held_out_already_started]",
        "qualifying B1 derangement or STOP": "test_s2_pilot::...[no_qualifying_b1_derangement] + test_s2_b1_selector::test_block_when_one_family_is_much_longer",
        "B1 from real counts only": "test_s2_pilot::test_proxy_gate2_cannot_pass",
        "B1 bound to bank + builder": "test_s2_gates::test_b1_selection_rejects_proxy_stale_and_cross_fold",
        "all held-out fit context_cap": "test_s2_pilot::...[held_out_request_over_context_cap]",
    },
    "RUNTIME (every paid call)": {
        "request ≤ context_cap (block, no truncate)": "test_s2_gates::test_call_blocked_on_oversize_request",
        "no stale / cross-fold bank": "test_s2_gates::test_call_blocked_on_stale_or_cross_fold_bank",
        "no proxy B1 artifact": "test_s2_gates::test_call_blocked_on_proxy_b1_artifact",
        "env/contract hash match": "test_s2_gates::test_call_blocked_on_wrong_environment",
        "budget ≥ max exposure": "test_s2_gates::test_call_blocked_on_budget",
        "attempt caps not exceeded": "test_s2_gates::test_call_blocked_when_caps_exhausted",
    },
    "MANIFEST / SECRETS": {
        "append-only + illegal transition blocked": "test_s2_pilot::test_illegal_transition_is_rejected + test_transitions_are_append_only",
        "no secrets / hidden data persisted": "test_s2_pilot::test_assert_no_secrets_blocks_a_key",
        "one canonical request (no drift)": "test_s2_gates::test_one_canonical_feeds_both_adapters",
        "proxy/real counter isolation": "test_s2_gates::test_proxy_and_real_counters_do_not_share_cache",
    },
}


def main() -> None:
    m = build_run_manifest("s2-pilot-readiness", "HEAD", budget_usd=4.89, corpus_dir=_CORPUS)
    print("=" * 80)
    print(f"§2 PILOT READINESS — manifest status={m.status}  budget=${m.budget_usd}  paid=false")
    print("=" * 80)
    print("Offline gate: CLOSED (all $0 checks green). Pilot gate: intentionally OPEN until the")
    print("pinned env runs Gate 1 (real count_tokens, SDK-body green, 0 skips, budget).\n")
    for gate, conds in CONDITION_TESTS.items():
        print(f"[{gate}]")
        for cond, test in conds.items():
            print(f"  GO/NO-GO: {cond}\n            → {test}")
        print("")
    print("Next action (yours): stand up the pinned pilot env, then run examples/s2_gate1.py with an")
    print("AnthropicTokenCounter. No paid call is authorized until the Gate 1 report passes.")
    print("=" * 80)


if __name__ == "__main__":
    main()
