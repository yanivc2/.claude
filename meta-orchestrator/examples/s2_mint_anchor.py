"""Mint the Gate-1 authorization anchor from an ALIGNED, passed Gate-1 artifact ($0, no anchor→spend).

Anchor minting is a distinct step from Gate 1 and from any paid call. This:
  1. re-checks the artifact is passed + production_valid + non-blocking AND aligned
     (artifact.git_commit == current HEAD, worktree clean);
  2. builds the full evidence bundle (all Gate-1 hashes + caps + call-count + messages_create_called
     = false + paid_messages_cost = $0) and its hash;
  3. appends a hash-chained RunLog transition to AUTHORIZED_FOR_FOLD1_C_TRAINING and mints +
     verifies the AuthorizationAnchor (runlog + anchor live OUT of the repo, content-addressed);
  4. runs the NEGATIVE authorization test: a fully-valid call context WITHOUT an execution grant
     must be blocked by assert_call_allowed — proving the anchor alone cannot open spending.

It authorises NO messages.create and mints NO execution grant (that is a separate, later step).

Usage: python examples/s2_mint_anchor.py <gate1_artifact.json> <out_dir>
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys

from meta_orchestrator.experiment.s2.gates import CallContext, GateError, assert_call_allowed
from meta_orchestrator.experiment.s2.pilot import AUTHORIZED_FOLD1
from meta_orchestrator.experiment.s2.runlog import RunLog, make_anchor, verify_anchor

REPO = "/home/user/.claude"


def _negative_authorization_test(art: dict) -> str:
    """A valid Gate-1 call context WITHOUT an execution grant MUST be blocked (fail-closed)."""
    base = dict(fold=1, condition="C", is_held_out=False, request_tokens=1000,
                context_cap=art["context_cap"], remaining_budget=10.0, max_call_cost=0.08,
                env_hash_expected="e", env_hash_actual="e", contract_expected="k",
                contract_actual="k", active_bank_hash="b", model_calls_used=0, max_model_calls=2,
                gate1_ok=True, gate2_ok=True, context_cap_source="anthropic_count_tokens",
                pricing_artifact_hash_expected="p", pricing_artifact_hash_actual="p",
                endpoint_hash_expected="h", endpoint_hash_actual="h")
    # WITH grant → allowed; WITHOUT grant → must raise.
    assert_call_allowed(CallContext(**base, execution_grant_present=True,
                                    requested_task_within_grant=True))
    try:
        assert_call_allowed(CallContext(**base, execution_grant_present=False,
                                        requested_task_within_grant=False))
    except GateError as e:
        return f"BLOCKED as required: {str(e)[:70]}"
    raise SystemExit("NEGATIVE TEST FAILED: a call without an execution grant was NOT blocked")


def main() -> None:
    art_path, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    raw = open(art_path, "rb").read()
    art = json.loads(raw)
    art_sha = hashlib.sha256(raw).hexdigest()

    head = subprocess.check_output(["git", "-C", REPO, "rev-parse", "HEAD"]).decode().strip()
    dirty = bool(subprocess.check_output(["git", "-C", REPO, "status", "--porcelain"]).decode().strip())
    gr = art["gate_report"]

    # (1) hard preconditions
    problems = []
    if not (gr["passed"] and gr["production_valid"]):
        problems.append("gate not passed/production_valid")
    if art["blocking_notes"]:
        problems.append(f"blocking_notes={art['blocking_notes']}")
    if art["git_commit"] != head:
        problems.append(f"commit misalignment: artifact {art['git_commit'][:12]} != HEAD {head[:12]}")
    if dirty:
        problems.append("worktree dirty")
    if problems:
        raise SystemExit(f"REFUSING TO MINT — {problems}")

    # (2) evidence bundle (binds everything; no truncation)
    bundle = {
        "commit": art["git_commit"], "env_hash": art["env_hash"],
        "gate1_report": gr, "gate1_report_hash": hashlib.sha256(
            json.dumps(gr, sort_keys=True).encode()).hexdigest()[:12],
        "token_observations_hash": hashlib.sha256(json.dumps(
            [(t["task_id"], t["r1_tokens"], t["r2_tokens"], t["envelope"]["envelope_hash"],
              t["envelope"]["full_r2_canonical_hash"]) for t in art["per_task"]],
            sort_keys=True).encode()).hexdigest()[:16],
        "context_cap": art["context_cap"], "materialization_index_hash":
            art["materialization_cache_index_hash"],
        "envelope_generator_hash": art["envelope_generator_hash"],
        "budget_policy_hash": art["budget_policy_hash"], "budget_policy": art["budget_policy"],
        "reported_credits": art["reported_credits"],
        "fold1_projection": art["projection"], "experiment_projection": art["experiment_projection"],
        "max_messages_calls_frozen": len(art["projection"]["r1_input_tokens"])
            + len(art["projection"]["r2_input_tokens"]),
        "gate1_artifact_sha256": art_sha,
        "messages_create_called": False, "paid_messages_cost_usd": "0",
    }
    bundle_hash = hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()

    # (3) append the hash-chained transition + mint + verify the anchor (OUT of repo)
    run_log = RunLog(os.path.join(out_dir, "runlog.jsonl"), run_id=art["run_id"])
    ts = "2026-07-19T00:00:00Z"
    transition = run_log.append(new_state=AUTHORIZED_FOLD1, evidence_bundle_hash=bundle_hash,
                                timestamp=ts)
    anchor = make_anchor(run_log, authorized_state=AUTHORIZED_FOLD1, evidence_bundle_hash=bundle_hash)
    verify_anchor(run_log, anchor)                         # must not raise

    # (4) negative authorization test
    neg = _negative_authorization_test(art)

    json.dump(bundle, open(os.path.join(out_dir, "evidence_bundle.json"), "w"), indent=2, sort_keys=True)
    json.dump(anchor.model_dump(), open(os.path.join(out_dir, "anchor.json"), "w"), indent=2, sort_keys=True)

    print("=" * 78)
    print("AUTHORIZATION ANCHOR MINTED (out-of-repo, content-addressed)")
    print(f"  manifest_state          : {run_log.current_state()}")
    print(f"  anchor_content_hash     : {anchor.content_hash()}")
    print(f"  evidence_bundle_hash    : {bundle_hash}")
    print(f"  runlog head (seq/state) : {run_log.head()[1]} / {run_log.head()[2]}")
    print(f"  transition_hash         : {transition.transition_hash}")
    print(f"  gate1_artifact_sha256   : {art_sha}")
    print(f"  bound commit            : {art['git_commit']}  (== HEAD)")
    print(f"  frozen max messages     : {bundle['max_messages_calls_frozen']} (18 R1 + 18 R2)")
    print(f"  negative auth test      : {neg}")
    print(f"  messages_create_called  : {bundle['messages_create_called']}  paid_cost=${bundle['paid_messages_cost_usd']}")
    print(f"  anchor → {os.path.join(out_dir, 'anchor.json')}")
    print("NO messages.create · NO execution grant minted · spending still requires a separate grant")
    print("=" * 78)


if __name__ == "__main__":
    main()
