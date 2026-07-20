"""Mint the single-task execution grant for the first curriculum task ($0 — NO messages.create).

Minting a grant is distinct from Gate 1, from the anchor, and from any paid call. This:
  1. re-verifies the aligned, passed Gate-1 artifact + the anchor (commit == HEAD, clean);
  2. re-verifies the frozen curriculum's literal first task and its verified reproduction;
  3. GUARDS the hidden ``-k`` selector: it must collect EXACTLY ONE node, equal to the frozen F2P
     and disjoint from the P2P suite (else a configuration failure — never a silent hidden FAIL);
  4. builds a grant bound to the anchor / commit / curriculum / reproduction + the node-plan +
     source + materialisation hashes + the EXACT Decimal max R1+R2 exposure, with grant_id +
     task_2_authorized=false;
  5. seals it, opens its persistent usage ledger (calls_used=0, completed=false), and verifies the
     seal + anchor binding + that a WRONG task / task 2 are refused. It makes NO reservation and
     sends NOTHING.

Usage: python examples/s2_mint_grant.py <gate1_artifact.json> <anchor.json> <workdir> <out_dir>
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from decimal import Decimal

from meta_orchestrator.experiment.s2.budget_projection import GATE_OUTPUT_TOKENS_PER_CALL
from meta_orchestrator.experiment.s2.curriculum import load_frozen_curriculum
from meta_orchestrator.experiment.s2.execution_grant import (GrantUsageLedger, build_execution_grant)
from meta_orchestrator.experiment.s2.pricing import call_cost_usd, load_frozen_pricing
from meta_orchestrator.experiment.s2.realtask import assert_hidden_selection_valid, materialize_real_task

REPO_ROOT = "/home/user/.claude"
FOLD, POSITION = 1, 0


def main() -> None:
    art_path, anchor_path, workdir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    os.makedirs(out_dir, exist_ok=True)
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    corpus_dir = os.path.join(here, "corpus")
    art = json.load(open(art_path))
    anchor = json.load(open(anchor_path))
    anchor_hash = hashlib.sha256(json.dumps(anchor, sort_keys=True).encode()).hexdigest()[:16]
    gate1_report_hash = hashlib.sha256(json.dumps(art["gate_report"], sort_keys=True).encode()).hexdigest()[:12]

    head = subprocess.check_output(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"]).decode().strip()
    dirty = bool(subprocess.check_output(["git", "-C", REPO_ROOT, "status", "--porcelain"]).decode().strip())

    # (1) preconditions
    problems = []
    if not (art["gate_report"]["passed"] and art["gate_report"]["production_valid"]):
        problems.append("gate not passed/production_valid")
    if art["blocking_notes"]:
        problems.append("gate has blocking notes")
    if art["git_commit"] != head or dirty:
        problems.append("commit misalignment or dirty worktree")
    if anchor.get("authorized_state") != "AUTHORIZED_FOR_FOLD1_C_TRAINING":
        problems.append("anchor not in AUTHORIZED_FOR_FOLD1_C_TRAINING")
    if problems:
        raise SystemExit(f"REFUSING TO MINT GRANT — {problems}")

    # (2) frozen curriculum literal first task
    cur = load_frozen_curriculum(corpus_dir)
    task_id = cur.task_at(FOLD, POSITION)
    if task_id != "black-112":
        raise SystemExit(f"unexpected curriculum position 0: {task_id}")

    # (3) reproduce + guard the hidden -k selector (exactly one node, disjoint from P2P)
    ctx = materialize_real_task(task_id, workdir)
    sel = assert_hidden_selection_valid(ctx)                # raises on 0/>1 match or P2P overlap

    # (4) exact max R1+R2 exposure for THIS task (frozen worst, Decimal)
    pricing = load_frozen_pricing(corpus_dir)
    per = {t["task_id"]: t for t in art["per_task"]}[task_id]
    out = GATE_OUTPUT_TOKENS_PER_CALL
    exposure = (call_cost_usd(pricing, input_tokens=per["r1_tokens"], output_tokens=out)
                + call_cost_usd(pricing, input_tokens=per["r2_tokens"], output_tokens=out))
    source_bundle_hash = hashlib.sha256(
        json.dumps(ctx.buggy_source, sort_keys=True).encode()).hexdigest()[:16]
    test_materialization_hash = hashlib.sha256(json.dumps(sel, sort_keys=True).encode()).hexdigest()[:16]
    grant_id = "grant-" + hashlib.sha256(f"{task_id}:{anchor_hash}:{art['git_commit']}".encode()).hexdigest()[:12]

    grant = build_execution_grant(
        grant_id=grant_id, anchor_commit=art["git_commit"], anchor_report_hash=gate1_report_hash,
        fold=FOLD, condition="C", phase="training", task_id=task_id,
        curriculum_hash=cur.content_hash, curriculum_position=POSITION,
        max_total_exposure_usd=format(exposure, "f"), model_id=art["model"],
        reproduction_digest=art.get("materialization_cache_index_hash", ""),
        granted_at="2026-07-19T00:00:00Z")
    # bind the remaining evidence hashes (part of the sealed content)
    grant = grant.model_copy(update={
        "anchor_content_hash": anchor_hash,
        "public_node_plan_hash": sel["public_node_plan_hash"],
        "hidden_node_plan_hash": sel["hidden_node_plan_hash"],
        "source_bundle_hash": source_bundle_hash,
        "test_materialization_hash": test_materialization_hash,
        "network_isolation": " ".join(ctx.netns())})   # reproduction_digest bound from the fresh Gate-1
    grant = grant.sealed()

    # (5) persistent ledger + seal/binding/negative verification (NO reservation, NO send)
    led = GrantUsageLedger(os.path.join(out_dir, "grant_ledger.json"))
    json.dump({**grant.model_dump(), "hidden_selection_evidence": sel},
              open(os.path.join(out_dir, "execution_grant.json"), "w"), indent=2, sort_keys=True)

    seal_ok = grant.is_sealed()
    binding_ok = (grant.anchor_commit == head and grant.anchor_content_hash == anchor_hash
                  and grant.anchor_report_hash == gate1_report_hash)
    covers_ok = led.would_authorize(grant, fold=1, condition="C", task_id=task_id)
    wrong_task_blocked = not led.would_authorize(grant, fold=1, condition="C", task_id="black-130")
    task2_blocked = not grant.task_2_authorized

    print("=" * 78)
    print("EXECUTION GRANT MINTED (single task; out-of-repo; NO messages.create)")
    print(f"  grant_id                : {grant.grant_id}")
    print(f"  grant_content_hash      : {grant.content_hash}")
    print(f"  seal_verified           : {seal_ok}")
    print(f"  task_id                 : {grant.task_id}  (curriculum pos {grant.curriculum_position}, "
          f"hash {grant.curriculum_hash})")
    print(f"  bound anchor            : {grant.anchor_content_hash}  commit {grant.anchor_commit[:12]} (==HEAD)")
    print(f"  anchor_binding_verified : {binding_ok}")
    print(f"  hidden selection        : match_count={sel['hidden_match_count']} "
          f"overlap_with_p2p={sel['overlap_with_p2p']} node={sel['collected_hidden_nodes'][0]}")
    print(f"  node plan hashes        : public={grant.public_node_plan_hash} hidden={grant.hidden_node_plan_hash}")
    print(f"  source/materialisation  : source={grant.source_bundle_hash} test={grant.test_materialization_hash}")
    print(f"  network_isolation       : {grant.network_isolation}")
    print(f"  model                   : {grant.model_id}")
    print(f"  max_total_exposure_usd  : ${grant.max_total_exposure_usd}  (exact R1+R2 worst, Decimal)")
    print(f"  ledger: calls_used={led.calls_used(grant.grant_id)} "
          f"calls_remaining={grant.max_messages_calls - led.calls_used(grant.grant_id)} "
          f"completed={led.is_completed(grant.grant_id)}")
    print(f"  covers this task        : {covers_ok}")
    print(f"  wrong-task blocked      : {wrong_task_blocked}   task_2_authorized: {grant.task_2_authorized}")
    print("  reservation_made        : False   budget_spent/reserved: $0")
    print("  messages_create_called  : False   paid_cost: $0")
    print(f"  grant → {os.path.join(out_dir, 'execution_grant.json')}")
    print("STOP — a SEPARATE explicit go is required before the first messages.create (the paid canary)")
    print("=" * 78)


if __name__ == "__main__":
    main()
