"""Generate the FROZEN test-execution plans (defect-4 fix) for all corpus tasks ($0, no Messages).

Runs the repro derivation (fixed-rev TEST overlay + editable reinstall + 4-run stability) for each
task and freezes, per task: the exact overlay files + content hashes, the EXACT public/hidden node
ids, node-set hashes, environment digest, and provenance. Writes corpus/s2_test_execution_plans.
frozen.json. repro and realtask both consume this single artifact.

Usage: python examples/s2_build_test_execution_plans.py <workdir> [task_id ...]
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = os.path.join(HERE, "corpus")
sys.path.insert(0, os.path.join(HERE, "src"))

from meta_orchestrator.experiment.s2.repro import reproduce_bug  # noqa: E402
from meta_orchestrator.experiment.s2.test_execution_plan import (  # noqa: E402
    FROZEN_TEST_PLANS_FILENAME, FrozenTestExecutionPlans, build_plan)

AUDIT_ARTIFACT_HASH = "551d00dc1f93268f"          # the 27/27 DISCRIMINATIVE_REPRODUCED audit
DERIVATION_VERSION = "repro-overlay-4run-v1"


def main() -> None:
    workdir = sys.argv[1]
    os.makedirs(workdir, exist_ok=True)
    corpus = json.load(open(os.path.join(CORPUS, "s2_real_corpus.json")))["tasks"]
    ids = sys.argv[2:] or list(corpus)
    pb = os.path.join(workdir, "_pybughive")
    if not os.path.isdir(pb):
        subprocess.run(["git", "clone", "-q", "--depth", "1",
                        "https://github.com/pybughive/pybughive", pb], check=True, timeout=300)
    dataset = json.load(open(os.path.join(pb, "dataset", "pybughive_current.json")))
    issue_by_id = {f"{p['repository']}-{iss['id']}": (p, iss) for p in dataset for iss in p["issues"]}
    fmap = json.load(open(os.path.join(CORPUS, "s2_family_map.json")))["family_map"]
    scope = {t["task_id"]: t for t in
             json.load(open(os.path.join(CORPUS, "s2_scope_metadata.json")))["tasks"]}
    env_digest = f"py{platform.python_version()}|editable-install|unshare-rn"

    plans = {}
    for tid in ids:
        print(f"[plan] {tid} …", flush=True)
        proj, iss = issue_by_id[tid]
        sc = scope[tid]
        task_wd = os.path.join(workdir, tid)
        try:
            task, rep = reproduce_bug(tid, proj["repository"], proj["username"], iss, fmap[tid],
                                      sc["allowed_source_files"], sc["repair_scope"], task_wd)
        finally:
            shutil.rmtree(task_wd, ignore_errors=True)
        if task is None:
            raise SystemExit(f"REFUSING — {tid} did not reproduce: {rep.status} {rep.detail}")
        plan = build_plan(
            task_id=tid, buggy_rev=task.buggy_rev, fixed_rev=task.fixed_rev,
            overlay_files=task.test_overlay_files, overlay_hashes=task.test_overlay_hashes,
            public_nodes=task.p2p_nodes, hidden_nodes=task.f2p_nodes, environment_digest=env_digest,
            provenance={"audit_artifact_hash": AUDIT_ARTIFACT_HASH,
                        "derivation_version": DERIVATION_VERSION,
                        "legacy_f2p_keyword_plan": task.f2p_plan})
        plans[tid] = plan
        print(f"    overlay={task.test_overlay_files} hidden={task.f2p_nodes} p2p={len(task.p2p_nodes)}",
              flush=True)

    frozen = FrozenTestExecutionPlans(plans=plans).sealed()
    out = os.path.join(CORPUS, FROZEN_TEST_PLANS_FILENAME)
    json.dump(json.loads(frozen.model_dump_json()), open(out, "w"), indent=2, sort_keys=True)
    print("=" * 70)
    print(f"FROZEN {len(plans)} test-execution plans → {out}")
    print(f"content_hash = {frozen.content_hash}")


if __name__ == "__main__":
    main()
