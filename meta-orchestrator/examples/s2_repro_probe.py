"""Real-task reproduction probe for ONE curriculum task ($0 API, no model, read-only manifest).

Gate 1 proves prompt/cost/hashes/suite — NOT that the real bug's tests actually run. Before an
execution grant for the first curriculum task, this rebuilds that task's repo-backed reproduction
environment (clone → venv → install → pytest at the pinned buggy/fixed revs) via the frozen
``reproduce_bug`` pipeline and reports the reproduction evidence:

  * status + all 6 reproduction gates (incl. gate 4 = F2P FAIL on buggy / PASS on fixed);
  * buggy_source_hash recomputed vs the frozen manifest (materialisation consistency);
  * P2P / F2P counts vs the frozen manifest;
  * install/test seconds; timed_out flag.

It NEVER writes corpus/s2_real_corpus.json (the frozen corpus is not mutated) and makes no model
call. Usage: python examples/s2_repro_probe.py <task_id> <workdir>
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile

from meta_orchestrator.experiment.s2.repro import ReproStatus, reproduce_bug

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "pybughive_gate1_manifest.json")
MAP_PATH = os.path.join(HERE, "corpus", "s2_family_map.json")
SCOPE_PATH = os.path.join(HERE, "corpus", "s2_scope_metadata.json")
CORPUS = os.path.join(HERE, "corpus", "s2_real_corpus.json")
PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"


def _sha(d: dict) -> str:
    blob = json.dumps({k: d[k] for k in sorted(d)}, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def main() -> None:
    task_id = sys.argv[1]
    workdir = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="s2_repro_")
    os.makedirs(workdir, exist_ok=True)

    fmap = json.load(open(MAP_PATH))["family_map"]
    scope = {t["task_id"]: t for t in json.load(open(SCOPE_PATH))["tasks"]}
    frozen = json.load(open(CORPUS))["tasks"][task_id]

    repo = os.path.join(workdir, "_pybughive")
    if not os.path.isdir(repo):
        subprocess.run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, repo],
                       check=True, timeout=300)
    dataset = json.load(open(os.path.join(repo, "dataset", "pybughive_current.json")))
    issue_by_id = {f"{p['repository']}-{iss['id']}": (p, iss)
                   for p in dataset for iss in p["issues"]}
    proj, iss = issue_by_id[task_id]
    sc = scope[task_id]

    print(f"=== reproducing {task_id} ({proj['repository']}) — model-free, $0 ===")
    task, rep = reproduce_bug(task_id, proj["repository"], proj["username"], iss, fmap[task_id],
                              sc["allowed_source_files"], sc["repair_scope"], workdir)

    print("status:", rep.status)
    print("gates:")
    for k, v in rep.gates.items():
        print(f"  {k}: {v}")
    print(f"install_s={rep.install_s} test_s={rep.test_s} timed_out={rep.timed_out}")
    print("detail:", rep.detail)

    reproduced = rep.status in ReproStatus.REPRODUCED
    checks = {"status_reproduced": reproduced,
              "gate4_f2p_fail_buggy_pass_fixed": bool(rep.gates.get("4_f2p_fail_on_buggy_pass_on_fixed")),
              "timed_out_false": not rep.timed_out}
    if task is not None:
        bh = _sha(task.buggy_source)
        checks["buggy_source_hash_matches_frozen"] = (bh == frozen["buggy_source_hash"])
        checks["p2p_count_matches_frozen"] = (len(task.p2p_nodes) == frozen["p2p_count"])
        checks["f2p_plan_matches_frozen"] = (
            [list(p) for p in task.f2p_plan] == [list(p) for p in frozen["f2p_plan"]])
        print(f"buggy_source_hash: computed={bh} frozen={frozen['buggy_source_hash']}")
        print(f"P2P: computed={len(task.p2p_nodes)} frozen={frozen['p2p_count']}")
        print(f"F2P plan: computed={task.f2p_plan} frozen={frozen['f2p_plan']}")

    print("\n=== REPRODUCTION EVIDENCE CHECKS ===")
    for k, v in checks.items():
        print(f"  {'PASS' if v else 'FAIL'}  {k}")
    allok = all(checks.values())
    print(f"\nREPRODUCTION {'VERIFIED ✓' if allok else 'NOT VERIFIED ✗'} for {task_id}")


if __name__ == "__main__":
    main()
