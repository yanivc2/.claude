"""Gate 1 orchestration — before paid C-training. Evidence-based; DRY-RUN offline.

Refinement 1: the script GATHERS evidence (observations) and the gate DERIVES the predicates —
the script never passes a `serialized_body_ok=True` boolean. Offline it feeds a proxy count
observation + a suite report with skips, so `gate1_from_evidence` returns
passed=False / production_valid=False and nothing is authorized.

Usage: python examples/s2_gate1.py     # offline dry-run (never authorizes)
"""
from __future__ import annotations

import os

from meta_orchestrator.experiment.s2 import (BudgetEvidence, CountEvidence, GateError,
                                             PytestEvidence, SnapshotEvidence, authorize_after_gate1,
                                             build_run_manifest, gate1_from_evidence)

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")
MODEL = "claude-haiku-4-5-20251001"
REQUIRED = ["tests/test_s2_prepaid.py::test_sdk_serialized_body_omits_effort_and_temperature",
            "tests/test_s2_prepaid.py::test_sdk_max_retries_zero_means_one_http_request"]


def main() -> None:
    manifest = build_run_manifest("s2-pilot-dryrun", "HEAD", budget_usd=4.89, corpus_dir=_CORPUS)

    # OFFLINE observations: suite still has 2 skips (SDK tests can't run without the anthropic pkg),
    # and the token count is from the PROXY — so the gate must derive a fail + non-production.
    pytest_ev = PytestEvidence(run_id=manifest.run_id, environment_hash="offline",
                               git_commit="HEAD", exit_code=0, failed=0, skipped=2,
                               passed_node_ids=[], sdk_version="", httpx_version="",
                               command_hash="offline").sealed()
    count_obs = [CountEvidence(canonical_request_hash="r1", counter_source="offline_proxy",
                               model=MODEL, tokens=1200, round_template="R1")]
    budget = BudgetEvidence(projected_fold_cost=2.0, reserve_fraction=0.25, available_budget=4.89)
    snap = SnapshotEvidence(model_id=MODEL, available=True, retirement_date_iso="",
                            as_of_date_iso="2026-07-19")

    report = gate1_from_evidence(manifest=manifest, corpus_dir=_CORPUS, pytest_ev=pytest_ev,
                                 environment_hash="offline", required_node_ids=REQUIRED,
                                 count_obs=count_obs, expected_request_hashes={"r1"}, model=MODEL,
                                 context_cap=64000, budget_ev=budget, snapshot_ev=snap)

    print("=" * 78)
    print(f"GATE 1 (dry-run, evidence-based) — passed={report.passed} "
          f"production_valid={report.production_valid} source={report.token_count_source}")
    print("derived blocking reasons:", report.reasons)
    try:
        authorize_after_gate1(manifest, report, timestamp="dry-run")
        print("!! AUTHORIZED — must NEVER happen offline")
    except GateError as e:
        print(f"correctly REFUSED to authorize offline: {str(e)[:80]}...")
    print(f"manifest status stays: {manifest.status}")
    print("\nPilot env: feed a real PytestEvidence (0 skips), an AnthropicTokenCounter's count")
    print("observations (source=anthropic_count_tokens), pinned versions, and a live budget/snapshot")
    print("attestation. Only then can gate1_from_evidence pass and authorize fold-1 C-training.")
    print("=" * 78)


if __name__ == "__main__":
    main()
