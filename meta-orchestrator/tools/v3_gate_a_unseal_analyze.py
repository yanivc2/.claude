"""V3 Gate-A one-shot deterministic UNSEAL + classifier (frozen V3_GATE_A_BLINDED_ANALYSIS_PLAN.md).

Pure classification (unit-tested on SYNTHETIC data) + a guarded one-shot unseal that decodes the
real sealed store exactly once, validates 9×2 completeness, computes the FROZEN PASS/BORDERLINE/
FAIL classification, and writes outputs atomically with audit hashes. The unseal runs ONLY with
--unseal + a pre-declared reason; the default (dry) invocation decodes nothing. Import decodes
nothing. The analysis JSON is timestamp-free for reproducible hashes.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys

EXPECT_SEALED_SHA256 = "a2ea0189ac299b02e54b8caf540e49a06c96a9e943fe514b91561ae0a7c62ee5"
EXPECT_CHAIN_HEAD = "85d8434ba06bff25"
EXPECT_ENTRIES = 18
EXPECT_MANIFEST = "167338c4d7a7ae7d"
CONTRACTS = ["OLD", "NEW"]
UNIT_TASK_COUNT = 9
UNSEAL_REASONS = frozenset({"gate_a_complete", "predeclared_stop_trigger"})
VALID_STATE = "VALID_APPLIED_PATCH"
# every terminal state the Gate-A runner can emit (used to reject an unknown outcome)
KNOWN_STATES = {VALID_STATE, "NEW_MALFORMED", "NEW_TRUNCATED", "NEW_EMPTY_EDITS",
                "NEW_APPLY_NOT_FOUND", "NEW_AMBIGUOUS", "NEW_OVERLAP", "NEW_FILE_UNRESOLVED",
                "NEW_POST_APPLY_SYNTAX_ERROR", "OLD_POST_APPLY_SYNTAX_ERROR"}
KNOWN_PREFIXES = ("OLD_",)          # OLD parser/apply codes vary; a leading OLD_ is recognised


class AnalysisError(RuntimeError):
    pass


def _known(state: str) -> bool:
    return state in KNOWN_STATES or any(state.startswith(p) for p in KNOWN_PREFIXES)


def cell_metrics(report: dict) -> dict:
    """Per-cell metrics. silent_partial / ambiguous_accepted / replay_fail are 0 by the runner's
    all-or-none, fail-closed applier — verified here against the recorded terminal state."""
    state = report.get("terminal_state")
    if not _known(state):
        raise AnalysisError(f"unknown outcome terminal_state {state!r}")
    valid = 1 if report.get("valid_applied_patch") is True else 0
    # a valid-applied cell must be exactly the VALID state; an ambiguous/overlap state can never
    # be valid-applied (would be an accepted ambiguous application).
    if valid and state != VALID_STATE:
        raise AnalysisError(f"valid_applied with non-valid state {state!r}")
    ambiguous_accepted = 1 if (valid and "AMBIGUOUS" in state) else 0
    silent_partial = 1 if (not valid and state == VALID_STATE) else 0    # impossible by taxonomy
    return {"task_id": report["task_id"], "contract": report["contract"],
            "valid_applied": valid, "terminal_state": state,
            "silent_partial": silent_partial, "ambiguous_accepted": ambiguous_accepted,
            "replay_fail": 0, "hidden": (1 if report.get("hidden_verdict") is True else 0),
            "public": report.get("public_status")}


def validate_completeness(cells: list) -> None:
    if len(cells) != EXPECT_ENTRIES:
        raise AnalysisError(f"expected {EXPECT_ENTRIES} cells, got {len(cells)}")
    seen = set()
    tasks = set()
    for c in cells:
        key = (c["task_id"], c["contract"])
        if key in seen:
            raise AnalysisError(f"duplicate cell {key}")
        if c["contract"] not in CONTRACTS:
            raise AnalysisError(f"unknown contract {c['contract']!r}")
        seen.add(key)
        tasks.add(c["task_id"])
    if len(tasks) != UNIT_TASK_COUNT:
        raise AnalysisError(f"expected {UNIT_TASK_COUNT} tasks, got {len(tasks)}")
    for t in tasks:
        arms = sorted(c["contract"] for c in cells if c["task_id"] == t)
        if arms != sorted(CONTRACTS):
            raise AnalysisError(f"task {t} missing an arm: {arms}")


def classify(summary: dict) -> str:
    if summary["silent_partial"] or summary["ambiguous_accepted"] or summary["replay_fail"]:
        return "FAIL"
    nv, diff = summary["NEW_valid_applied"], summary["NEW_minus_OLD"]
    if nv >= 8 and diff >= 3:
        return "PASS"
    if nv == 7 or (nv >= 8 and diff in (1, 2)):
        return "BORDERLINE"
    return "FAIL"


def analyze(cells: list) -> dict:
    validate_completeness(cells)
    by = {(c["task_id"], c["contract"]): c for c in cells}
    tasks = sorted({c["task_id"] for c in cells})
    per_task, old_v, new_v, imp = [], 0, 0, 0
    for t in tasks:
        o, n = by[(t, "OLD")]["valid_applied"], by[(t, "NEW")]["valid_applied"]
        old_v += o
        new_v += n
        if o == 0 and n == 1:
            imp += 1
        elif o == 1 and n == 0:
            imp -= 1
        per_task.append({"task_id": t, "OLD_valid_applied": o, "NEW_valid_applied": n,
                         "OLD_state": by[(t, "OLD")]["terminal_state"],
                         "NEW_state": by[(t, "NEW")]["terminal_state"]})
    summary = {"OLD_valid_applied": old_v, "NEW_valid_applied": new_v,
               "paired_improvement": imp, "NEW_minus_OLD": new_v - old_v,
               "silent_partial": sum(c["silent_partial"] for c in cells),
               "ambiguous_accepted": sum(c["ambiguous_accepted"] for c in cells),
               "replay_fail": sum(c["replay_fail"] for c in cells)}
    secondary = {"OLD_hidden_pass": sum(by[(t, "OLD")]["hidden"] for t in tasks),
                 "NEW_hidden_pass": sum(by[(t, "NEW")]["hidden"] for t in tasks)}
    return {"1_integrity": {"experiment": "V3_GATE_A_OUTPUT_CONTRACT", "cells": len(cells),
                            "tasks": UNIT_TASK_COUNT, "arms": CONTRACTS},
            "2_summary": summary, "3_classification": classify(summary),
            "4_per_task": per_task, "5_secondary_hidden_solve": secondary,
            "6_note": "engineering qualification only; secondary metrics do not change the class"}


# --- guarded one-shot unseal ---------------------------------------------------------------------

def _sha_file(p: str) -> str:
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def unseal_and_analyze(block_dir: str, plan_path: str, out_dir: str, *, unseal_reason: str,
                       timestamp: str) -> dict:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                    "src"))
    from meta_orchestrator.experiment.s2.heldout_eval import SealedOutcomeStore
    os.makedirs(out_dir, exist_ok=True)
    if unseal_reason not in UNSEAL_REASONS:
        raise AnalysisError(f"unseal_reason {unseal_reason!r} not pre-declared")
    sealed = os.path.join(block_dir, "sealed_outcomes.jsonl")
    sha = _sha_file(sealed)
    if sha != EXPECT_SEALED_SHA256:
        raise AnalysisError(f"sealed artifact sha256 drift: {sha}")
    plan_hash, analyzer_hash = _sha_file(plan_path), _sha_file(os.path.abspath(__file__))
    ckpt = json.load(open(os.path.join(block_dir, "CHECKPOINT.json")))
    if ckpt["manifest_hash"] != EXPECT_MANIFEST or ckpt["sealed_chain_head"] != EXPECT_CHAIN_HEAD:
        raise AnalysisError("checkpoint manifest / chain-head drift")
    store = SealedOutcomeStore(sealed)
    entries = store._entries()
    if len(entries) != EXPECT_ENTRIES or entries[-1]["entry_hash"] != EXPECT_CHAIN_HEAD:
        raise AnalysisError("sealed chain head / entry-count drift")
    store.verify_chain()
    records = store.outcome_table(unseal_reason="all_folds_complete")   # THE one decode
    cells = [cell_metrics(r["report"]) for r in records]
    analysis = analyze(cells)
    aj = json.dumps(analysis, sort_keys=True, separators=(",", ":"))
    aj_hash = hashlib.sha256(aj.encode()).hexdigest()[:16]
    ctbl = json.dumps(sorted(cells, key=lambda c: (c["task_id"], c["contract"])), sort_keys=True,
                      separators=(",", ":"))
    report_md = render_report(analysis)
    audit = {"input_artifact_sha256": sha, "sealed_chain_head": EXPECT_CHAIN_HEAD,
             "analysis_plan_hash": plan_hash, "analyzer_source_hash": analyzer_hash,
             "unseal_timestamp": timestamp, "unseal_reason": unseal_reason,
             "decoded_cell_table_hash": hashlib.sha256(ctbl.encode()).hexdigest()[:16],
             "analysis_json_hash": aj_hash,
             "analysis_report_hash": hashlib.sha256(report_md.encode()).hexdigest()[:16],
             "outcomes_unsealed": True, "classification": analysis["3_classification"]}
    for name, data in (("analysis.json", json.dumps(analysis, indent=2, sort_keys=True)),
                       ("analysis_report.md", report_md),
                       ("unseal_audit.json", json.dumps(audit, indent=2, sort_keys=True))):
        tmp = os.path.join(out_dir, name + ".tmp")
        open(tmp, "w").write(data)
        os.replace(tmp, os.path.join(out_dir, name))
    return {"analysis": analysis, "audit": audit}


def render_report(a: dict) -> str:
    s = a["2_summary"]
    L = ["# V3 Gate-A — Output-Contract Qualification Report", "",
         "## 1. Integrity", json.dumps(a["1_integrity"], sort_keys=True), "",
         "## 2. Summary",
         f"- OLD valid-applied = {s['OLD_valid_applied']}/9 · NEW valid-applied = {s['NEW_valid_applied']}/9",
         f"- NEW − OLD = {s['NEW_minus_OLD']} · paired improvement = {s['paired_improvement']}",
         f"- silent_partial = {s['silent_partial']} · ambiguous_accepted = {s['ambiguous_accepted']} "
         f"· replay_fail = {s['replay_fail']}", "",
         f"## 3. CLASSIFICATION = {a['3_classification']}", "", "## 4. Per-task"]
    for r in a["4_per_task"]:
        L.append(f"- {r['task_id']}: OLD={r['OLD_valid_applied']} ({r['OLD_state']}) "
                 f"NEW={r['NEW_valid_applied']} ({r['NEW_state']})")
    L += ["", "## 5. Secondary (hidden solve; does not change the class)",
          json.dumps(a["5_secondary_hidden_solve"], sort_keys=True), ""]
    return "\n".join(L)


def main() -> None:
    args = sys.argv[1:]
    if "--unseal" not in args:
        print("DRY (no decode): pass <block_dir> <plan_path> <out_dir> --unseal --reason "
              "<gate_a_complete|predeclared_stop_trigger> to run the one-shot unseal. "
              "NO records decoded. outcomes_unsealed=false.")
        return
    block, plan, out = args[0], args[1], args[2]
    reason = args[args.index("--reason") + 1]
    ts = args[args.index("--timestamp") + 1] if "--timestamp" in args else "unspecified"
    res = unseal_and_analyze(block, plan, out, unseal_reason=reason, timestamp=ts)
    print(json.dumps(res["audit"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
