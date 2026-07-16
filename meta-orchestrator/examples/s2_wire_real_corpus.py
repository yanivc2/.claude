"""Wire the 27 real bugs into repo-backed tasks (online, model-free, $0 API).

Runs the 8-point reproduction gate (see experiment/s2/repro.py) per bug and writes a LEAN,
verifiable manifest (revs, allowed files + content hashes, F2P plan, P2P count, sanitized
statement, status/gates) to corpus/s2_real_corpus.json. Full source is re-materialised from the
pinned revisions at grading time — not stored — so the config repo stays small and git stays the
source of truth.

Run:
  python examples/s2_wire_real_corpus.py --gate        # the 2 gate bugs only
  python examples/s2_wire_real_corpus.py --all         # all 27 (same pipeline, no per-bug tweaks)
  python examples/s2_wire_real_corpus.py black-95 ...   # explicit ids

No model. install/timeout are harness failures, never repair failures. A pipeline fix must re-run
ALL tasks (delete the manifest to force a clean re-run).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from collections import Counter

from meta_orchestrator.experiment.s2.repro import ReproStatus, reproduce_bug

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "pybughive_gate1_manifest.json")
MAP_PATH = os.path.join(HERE, "corpus", "s2_family_map.json")
SCOPE_PATH = os.path.join(HERE, "corpus", "s2_scope_metadata.json")
DATASET = os.path.join(HERE, "..", "..")   # unused; dataset cloned below
OUT = os.path.join(HERE, "corpus", "s2_real_corpus.json")
PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"

# The 2 gate bugs: one single-file Black, one multi-file from another repo (cookiecutter).
GATE_IDS = ["black-95", "cookiecutter-18"]


def _sha(d: dict) -> str:
    blob = json.dumps({k: d[k] for k in sorted(d)}, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def _load_dataset(workdir):
    repo = os.path.join(workdir, "_pybughive")
    import subprocess
    subprocess.run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, repo],
                   check=True, timeout=300)
    commit = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    data = json.load(open(os.path.join(repo, "dataset", "pybughive_current.json")))
    return data, commit


def main() -> None:
    args = sys.argv[1:]
    manifest = json.load(open(MANIFEST))
    admitted = list(manifest["admitted_ids"])
    fmap = json.load(open(MAP_PATH))["family_map"]
    scope = {t["task_id"]: t for t in json.load(open(SCOPE_PATH))["tasks"]}

    if "--all" in args:
        ids = list(admitted)
    elif "--gate" in args or not args:
        ids = list(GATE_IDS)
    else:
        ids = args

    workdir = tempfile.mkdtemp(prefix="s2_wire_")
    dataset, dataset_commit = _load_dataset(workdir)
    issue_by_id = {f"{p['repository']}-{iss['id']}": (p, iss)
                   for p in dataset for iss in p["issues"]}

    results = json.load(open(OUT)).get("tasks", {}) if os.path.exists(OUT) else {}
    print(f"=== wiring {len(ids)} bug(s): {ids} ===  (model-free, $0)")
    for tid in ids:
        proj, iss = issue_by_id[tid]
        sc = scope[tid]
        task, rep = reproduce_bug(
            tid, proj["repository"], proj["username"], iss, fmap[tid],
            sc["allowed_source_files"], sc["repair_scope"], workdir)
        entry = {"task_id": tid, "family": fmap[tid], "repair_scope": sc["repair_scope"],
                 "status": rep.status, "gates": rep.gates, "detail": rep.detail,
                 "install_s": rep.install_s, "test_s": rep.test_s, "timed_out": rep.timed_out}
        if task is not None:
            entry.update({
                "project": task.project, "repo_url": task.repo_url,
                "buggy_rev": task.buggy_rev, "fixed_rev": task.fixed_rev,
                "allowed_source_files": task.allowed_source_files,
                "buggy_source_hash": _sha(task.buggy_source),
                "reference_fix_hash": _sha(task.reference_fix),
                "f2p_plan": task.f2p_plan, "p2p_count": len(task.p2p_nodes),
                "sanitized_statement": task.sanitized_statement})
        results[tid] = entry
        print(f"  {tid:16s} {rep.status:26s} {rep.detail}")

    by_status = Counter(e["status"] for e in results.values())
    doc = {
        "corpus": "s2 real repo-backed corpus (target-file-set-given repair)",
        "corpus_manifest_sha256": manifest["admitted_sha256"],
        "scope_content_hash": json.load(open(SCOPE_PATH))["scope_content_hash"],
        "dataset_commit": dataset_commit,
        "counts_by_status": dict(by_status),
        "wired_total": len(results),
        "tasks": results,
    }
    json.dump(doc, open(OUT, "w"), indent=2)

    print("\n--- status breakdown ---")
    for st in [ReproStatus.REPRODUCED, ReproStatus.NON_REPRODUCIBLE,
               ReproStatus.HARNESS_DEPENDENCY_FAILURE, ReproStatus.INVALID_F2P,
               ReproStatus.INVALID_P2P, ReproStatus.LEAKAGE_REJECTED]:
        print(f"  {st:28s} {by_status.get(st, 0)}")
    print(f"  wired manifest → {os.path.relpath(OUT, HERE)}")

    gate = [tid for tid in GATE_IDS if tid in results]
    if set(ids) == set(GATE_IDS) and gate:
        ok = all(results[tid]["status"] == ReproStatus.REPRODUCED for tid in gate)
        print(f"\nGATE ({', '.join(GATE_IDS)}): {'PASS ✓ — proceed to all 27' if ok else 'FAIL ✗ — stop and diagnose'}")


if __name__ == "__main__":
    main()
