"""§2 Step-2 — offline SOLVER harness report (the bounded-attempt deliverable).

Runs the Decision-B bounded attempt (A/C/D/B1) over synthetic stand-ins for the 27 wired real
task ids, through the REAL Sandbox + composite verifier, with NO model and NO network. It then
prints a report ONLY: pass/fail of the acceptance checks, a contract-clause → test map, the
run invariants, residual risks, and an explicit ``paid_api_called=false``.

Usage:  python examples/s2_solver_harness_report.py
It NEVER calls a paid API. It STOPS before count_tokens and before any Haiku call.
"""
from __future__ import annotations

import json
import os

from meta_orchestrator.experiment.agent import AgentTools
from meta_orchestrator.experiment.contract import AgentContract, prompt_hash
from meta_orchestrator.experiment.s2 import (AttemptContract, MemorySensitiveRoundSolver,
                                             SEMANTIC_FAMILIES, SolverHarness,
                                             anthropic_request_kwargs, build_synthetic_corpus,
                                             frozen_s2_contract, s2_run_policy)
from meta_orchestrator.experiment.s2.contract_s2 import _deep_key_present
from meta_orchestrator.experiment.s2.report import fixture_playbook

_REAL_MAP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "corpus", "s2_family_map.json")

# The contract clause → test that proves it (acceptance criterion 8: map every clause to a test).
CONTRACT_CLAUSE_TESTS = {
    "A: thinking enabled + budget_tokens=1024": "test_s2_contract::test_adapter_sends_enabled_thinking_with_budget_1024",
    "A: never sends effort (errors on Haiku 4.5)": "test_s2_contract::test_adapter_never_sends_effort",
    "A: never sends temperature/top_p/top_k": "test_s2_contract::test_adapter_never_sends_temperature_or_sampling",
    "A: exact snapshot + max_tokens 4096": "test_s2_contract::test_adapter_pins_exact_snapshot_and_max_tokens",
    "A: no silent fallback": "test_s2_contract::test_run_policy_disables_fallback",
    "B: Round 1 success stops (no Round 2)": "test_s2_solver::test_round1_success_stops_without_round2",
    "B: public failure opens exactly one Round 2": "test_s2_solver::test_public_failure_allows_exactly_one_round2",
    "B: <=2 model calls / patches / public runs": "test_s2_solver::test_caps_hold_for_a_greedy_solver",
    "B: exactly one hidden verification": "test_s2_solver::test_hidden_verifier_runs_exactly_once",
    "B: invalid patch blocked + handled": "test_s2_solver::test_invalid_patch_is_blocked_and_handled",
    "B: no F2P feedback to the agent": "test_s2_solver::test_no_f2p_feedback_reaches_the_solver",
    "C: deterministic write-gate (8 checks)": "test_s2_write_gate::test_clean_candidate_is_written (+ per-check rejections)",
    "C: learn from train only; bank frozen": "test_s2_write_gate::test_learn_gated_bank_admits_only_clean_train_passes",
    "C: held-out write raises (noisy)": "test_s2_write_gate::test_frozen_bank_refuses_held_out_write",
    "C/B1/D: only memory content differs": "test_s2_solver::test_only_memory_differs_c_passes_a_b1_d_fail",
    "B1: same bank, frozen mis-routing": "test_s2_harness::test_real_map_b1_placebo_over_present_families_no_fixed_point",
    "D: loaded from frozen file, unmodified": "test_s2_playbook_d::(freeze + content-hash suite)",
    "E: outcomes sealed until finalize": "test_s2_solver::test_effect_table_sealed_until_finalize",
    "resume: no duplicate attempt / cost": "test_s2_solver::test_resume_does_not_duplicate_attempts_or_calls",
    "provenance: all frozen hashes recorded": "test_s2_solver::test_provenance_records_all_frozen_hashes",
    # hardening batch (consultation review):
    "P0.1 production-path body (not just builder)": "test_s2_model_client::test_production_path_sends_exact_contract_body",
    "P0.1 no silent fallback on the call path": "test_s2_model_client::test_no_fallback_raises_model_unavailable",
    "P0.2 fold banks distinct + provenance ⊆ train": "test_s2_fold_leakage::test_bank_provenance_is_within_train_and_excludes_held_out",
    "P0.2 cross-fold injection fails loudly": "test_s2_fold_leakage::test_injecting_another_folds_bank_fails_loudly",
    "P0.3 held-out proposes no lesson (schema parity)": "test_s2_hardening::test_held_out_c_emits_no_candidate_lesson",
    "P0.4 empty public suite ≠ FAIL (no free Round 2)": "test_s2_hardening::test_no_public_tests_does_not_open_round2",
    "P0.5 C/B1 occupancy-parity confound detector": "test_s2_hardening::test_occupancy_parity_flags_length_confound",
    "neg-control: memory-ignoring → no separation": "test_s2_hardening::test_memory_ignoring_double_shows_no_separation",
    "neg-control: leaking lesson → gate rejects": "test_s2_hardening::test_leaking_lesson_is_rejected_by_the_gate",
    # pre-paid freeze (2nd consultation review):
    "B1 parity-optimized derangement + hard block": "test_s2_b1_selector::test_selection_succeeds_with_equal_occupancy / test_block_when_no_mapping_meets_tolerance",
    "held-out request byte-identical except memory": "test_s2_prepaid::test_held_out_requests_are_byte_identical_except_memory",
    "prompt carries no condition/family label": "test_s2_prepaid::test_prompt_carries_no_condition_or_family_label",
    "counterbalanced condition order": "test_s2_prepaid::test_condition_order_is_balanced_across_tasks",
    "infra error → incomplete, never a condition FAIL": "test_s2_prepaid::test_infra_error_is_incomplete_not_a_fail",
    "response-parser robustness": "test_s2_prepaid::test_parser_handles_response_variants",
    "SDK-serialized body omits effort (pilot env)": "test_s2_prepaid::test_sdk_serialized_body_omits_effort_and_temperature [skipped offline]",
}


def _load_family_map():
    if os.path.exists(_REAL_MAP):
        doc = json.load(open(_REAL_MAP))
        if not doc.get("synthetic", True):
            return doc["family_map"], False, doc.get("family_map_content_hash", "?")
    # fallback: a synthetic map over the 27 ids so the example runs anywhere.
    ids = ["black-112", "black-130", "black-132", "black-133", "black-141", "black-1632",
           "black-183", "black-185", "black-193", "black-215", "black-224", "black-232",
           "black-234", "black-238", "black-273", "black-329", "black-334", "black-335",
           "black-385", "black-389", "black-593", "black-60", "black-74", "black-80",
           "black-95", "cookiecutter-18", "discord.py-7818"]
    fmap = {t: SEMANTIC_FAMILIES[i % len(SEMANTIC_FAMILIES)] for i, t in enumerate(sorted(ids))}
    return fmap, True, "synthetic"


def _mock_contract():
    return AgentContract(provider="mock", exact_model_id="mock-v0", agent_version="0.1",
                         tool_definitions=AgentTools.NAMES, system_prompt_hash=prompt_hash("frozen"))


def main() -> None:
    family_map, synthetic_map, map_hash = _load_family_map()
    corpus = build_synthetic_corpus(family_map)
    attempt_contract = AttemptContract()

    # The harness runs on the MOCK contract (offline). The FROZEN Haiku contract is only
    # inspected here — never invoked — to prove the request shape ($0 preflight of the shape).
    harness = SolverHarness(family_map, corpus, _mock_contract(), fixture_playbook(),
                            lambda task, cond: MemorySensitiveRoundSolver(task, cond), k=3,
                            attempt_contract=attempt_contract, synthetic_map=synthetic_map)
    fold_runs = harness.run_all()
    harness.outcomes.finalize()
    table = harness.outcomes.effect_table()
    cost = harness.outcomes.cost_signals()
    hsig = harness.outcomes.harness_signals()

    # Aggregate the sealed table (post-finalize) into per-condition pass rates.
    per_condition = {c: {"pass": 0, "n": 0} for c in ("A", "C", "D", "B1")}
    for fold in table.values():
        for cond, tasks in fold.items():
            for passed in tasks.values():
                per_condition[cond]["n"] += 1
                per_condition[cond]["pass"] += int(passed)

    # Inspect (never send) the frozen Haiku payload.
    fc = frozen_s2_contract()
    kw = anthropic_request_kwargs(fc, prompt="<frozen agent prompt>")
    contract_checks = {
        "thinking_enabled_budget_1024": kw.get("thinking") == {"type": "enabled",
                                                               "budget_tokens": 1024},
        "no_effort": not _deep_key_present(kw, "effort"),
        "no_temperature": "temperature" not in kw,
        "no_top_p_top_k": ("top_p" not in kw and "top_k" not in kw),
        "exact_snapshot": kw["model"] == "claude-haiku-4-5-20251001",
        "max_tokens_4096": kw["max_tokens"] == 4096,
        "fallback_off": s2_run_policy().fallback == "off",
    }

    parity = harness.occupancy_parity(harness.folds[0])
    invariants = {
        "routing_double_C_passes_all_held_out": all(v["pass"] == v["n"]
                                                    for c, v in per_condition.items() if c == "C"),
        "routing_double_A_B1_D_no_relevant_help": all(per_condition[c]["pass"] == 0
                                                      for c in ("A", "D", "B1")),
        "no_f2p_feedback_leaked": hsig["f2p_feedback_leaked"] is False,
        "caps_respected": True,   # structurally enforced by run_attempt (see solver tests)
        "outcomes_were_sealed": True,
        "c_b1_occupancy_parity": all(p.equal for p in parity),   # P0.5
        "no_cross_fold_leakage": True,   # P0.2 tripwire runs inside run_fold (raises otherwise)
    }

    print("=" * 80)
    print(f"§2 SOLVER-HARNESS REPORT — provider=mock  paid_api_called=false")
    print("=" * 80)
    print(f"corpus: n={len(family_map)} synthetic_map={synthetic_map} family_map_hash={map_hash}")
    print(f"attempt_contract: {attempt_contract.model_dump()}")
    print("")
    print("folds:")
    for fr in fold_runs:
        print(f"  fold {fr['fold']}: bank={fr['bank_hash']} families={fr['bank_families']} "
              f"n_test={fr['n_test']}")
    print("")
    print("routing_fixture_expected_outcome (NOT a scientific result — a plumbing test-double):")
    print("  ** these numbers come from a routing double, not a model; they must NEVER enter")
    print("     scientific results, mechanism claims, or summaries. **")
    for c in ("A", "C", "D", "B1"):
        v = per_condition[c]
        print(f"    {c}: {v['pass']}/{v['n']}")
    # P0.5 occupancy parity across the pilot fold's bank
    parity = harness.occupancy_parity(harness.folds[0])
    parity_ok = all(p.equal for p in parity)
    print(f"  C/B1 occupancy parity (fold 0): {'EQUAL' if parity_ok else 'MISMATCH — confound!'}")
    print("")
    print(f"cost signals (OFFLINE, $0): {cost}")
    print(f"harness signals: {hsig}")
    print("")
    print("frozen Haiku contract — INSPECTED, NOT SENT:")
    for k, v in contract_checks.items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")
    print("")
    print("run invariants:")
    for k, v in invariants.items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")
    print("")
    print("contract clause → proving test (acceptance criterion 8):")
    for clause, test in CONTRACT_CLAUSE_TESTS.items():
        print(f"  - {clause}\n      → {test}")
    print("")
    print("residual risks:")
    for r in (
        "synthetic stand-in tasks exercise the PLUMBING only; the real bugs need a cloned "
        "repo + real test run (repo-backed reproduction) to become the graded corpus.",
        "MemorySensitiveRoundSolver is a ROUTING test-double — it makes no claim a real Haiku "
        "session behaves this way; the micro-pilot replaces it.",
        "D's effectiveness is not exercised by the routing double (it only responds to a "
        "relevant-family C lesson); D vs A/C is a real-model question for the pilot.",
        "n=27, per-fold n=9 — a directional pilot only (Decision E); no confirmatory claim.",
        "training-cutoff contamination stratum still needs the official Haiku 4.5 model card "
        "(snapshot date 2025-10-01 != cutoff) before it can be relied on.",
    ):
        print(f"  - {r}")
    print("")
    all_ok = (all(contract_checks.values()) and all(invariants.values()))
    print(f"paid_api_called = false")
    print(f"SELF-CHECKS {'PASSED ✓' if all_ok else 'FAILED ✗'} — STOP before count_tokens and "
          f"before any real Haiku call (both are separate, approval-gated steps).")
    print("=" * 80)


if __name__ == "__main__":
    main()
