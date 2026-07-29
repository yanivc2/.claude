"""Gate 2 orchestration — after C's bank is frozen, before held-out. Ready for pilot; DRY-RUN.

Same production logic (`pilot.gate2_evaluate`) as the tests and the real run. Offline it feeds a
proxy B1 source, so `gate2_evaluate` returns production_valid=False and `record_gate2_pass`
REFUSES to mark GATE2_PASSED. In the pilot env the B1 mapping is recomputed FROM SCRATCH with real
count_tokens on the complete requests (never reusing the proxy pick); no qualifying derangement
STOPS the whole experiment before any held-out call.

Usage: python examples/s2_gate2.py            # offline dry-run (never passes Gate 2)
"""
from __future__ import annotations

from meta_orchestrator.experiment.s2 import (Gate2Inputs, GateError, gate2_evaluate,
                                             record_gate2_pass, build_run_manifest)
from meta_orchestrator.experiment.s2.pilot import AUTHORIZED_FOLD1


def main() -> None:
    manifest = build_run_manifest("s2-pilot-dryrun", "HEAD", budget_usd=4.89)
    # simulate having reached the authorized state (in the real run Gate 1 does this transition)
    manifest.status = AUTHORIZED_FOLD1

    # OFFLINE dry-run: training looks complete + a mapping exists, but the B1 source is PROXY.
    inp = Gate2Inputs(fold=1, train_terminal_count=18, train_total=18, bank_frozen=True,
                      bank_fold_correct=True, held_out_calls_made=0, b1_source="offline_proxy",
                      b1_bound_to_bank=True, b1_bound_to_builder=True, all_held_out_fit_cap=True,
                      budget_sufficient_for_block=True, b1_qualifying_mapping_found=True)
    report = gate2_evaluate(inp)

    print("=" * 78)
    print(f"GATE 2 (dry-run) — passed={report.passed} production_valid={report.production_valid}")
    print(f"token_count_source={report.token_count_source}")
    print("blocking reasons:", report.reasons)
    try:
        record_gate2_pass(manifest, report, fold=1, timestamp="dry-run")
        print("!! GATE2_PASSED — this must NEVER happen offline")
    except GateError as e:
        print(f"correctly REFUSED to pass Gate 2 offline: {e}")
    print(f"manifest status stays: {manifest.status}")
    print("\nIn the pilot env: recompute B1 with AnthropicTokenCounter on COMPLETE requests; if no")
    print("derangement meets entries+lines parity and token diff <=16 & <=5%, STOP the experiment.")
    print("=" * 78)


if __name__ == "__main__":
    main()
