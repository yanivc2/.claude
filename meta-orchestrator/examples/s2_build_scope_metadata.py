"""Freeze §2 target-file-set scope metadata ($0, model-free, outcome-blind).

Per the scope amendment (A): §2 is target-file-set-given repair. For each admitted task the
agent receives exactly the source file(s) the REFERENCE repair modified — 1 for the 23
single-file tasks, 2–5 for the 4 multi-file tasks — and may write ONLY that frozen set (a
write outside it is a verifier failure). This script derives that set deterministically from
the reference patch (no manual edit, no outcome data), audits the multi-file distribution
across the frozen folds/families, and freezes it — WITHOUT touching the manifest, family map,
folds, or D.

Run:  python examples/s2_build_scope_metadata.py [path/to/pybughive_current.json]
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

from meta_orchestrator.experiment.s2 import stratified_folds

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "pybughive_gate1_manifest.json")
MAP_PATH = os.path.join(HERE, "corpus", "s2_family_map.json")
OUT = os.path.join(HERE, "corpus", "s2_scope_metadata.json")
PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"


def _load_dataset(path):
    if path and os.path.exists(path):
        return json.load(open(path)), "local:" + os.path.basename(path)
    work = tempfile.mkdtemp(prefix="pbh_scope_")
    repo = os.path.join(work, "pbh")
    subprocess.run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, repo],
                   check=True, timeout=300)
    commit = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    return json.load(open(os.path.join(repo, "dataset", "pybughive_current.json"))), commit


def _src_files(issue: dict) -> list[str]:
    """Exactly the source files the reference repair modified (docs + tests excluded), sorted."""
    files = issue["commits"][0]["stat"].get("files", [])
    return sorted(f["filename"] for f in files
                  if not f["filename"].endswith((".md", ".rst", ".txt"))
                  and "test" not in f["filename"].lower())


def main() -> None:
    manifest = json.load(open(MANIFEST))
    admitted = list(manifest["admitted_ids"])
    fam_doc = json.load(open(MAP_PATH))
    fmap = fam_doc["family_map"]
    if fam_doc.get("synthetic", True):
        raise SystemExit("family map is still synthetic — freeze the real map first")

    folds = stratified_folds(fmap, fam_doc["k_folds"])
    fold_of = {t: f.index for f in folds for t in f.test_ids}

    dataset, dataset_commit = _load_dataset(sys.argv[1] if len(sys.argv) > 1 else None)
    src_by_id = {f"{p['repository']}-{iss['id']}": _src_files(iss)
                 for p in dataset for iss in p["issues"]}

    tasks = []
    for tid in sorted(admitted):
        files = src_by_id[tid]
        scope = "multi_file" if len(files) > 1 else "single_file"
        tasks.append({"task_id": tid, "family": fmap[tid], "fold": fold_of[tid],
                      "n_source_files": len(files), "allowed_source_files": files,
                      "repair_scope": scope})

    multi = [t for t in tasks if t["repair_scope"] == "multi_file"]
    # --- distribution audit (outcome-blind) ---
    per_fold = dict(sorted(Counter(t["fold"] for t in multi).items()))
    per_family = dict(Counter(t["family"] for t in multi))
    fam_total = Counter(t["family"] for t in tasks)
    # concentration flags: a fold holding all 4, or a family (n>=4) that is majority multi-file
    one_fold_holds_all = any(c >= len(multi) for c in per_fold.values()) and len(multi) > 0
    majority_family = [f for f, c in per_family.items() if fam_total[f] >= 4 and c / fam_total[f] > 0.5]
    concentration_ok = not one_fold_holds_all and not majority_family

    content = json.dumps([{k: t[k] for k in ("task_id", "allowed_source_files", "repair_scope")}
                          for t in tasks], sort_keys=True, separators=(",", ":"))
    content_hash = hashlib.sha256(content.encode()).hexdigest()[:12]

    doc = {
        "amendment": "target-file-set-given repair (scope amendment A)",
        "frozen": True,
        "frozen_at": datetime.datetime.utcnow().isoformat() + "Z",
        "corpus_manifest_sha256": manifest["admitted_sha256"],
        "family_map_content_hash": fam_doc["family_map_content_hash"],
        "dataset_provenance": {"repo": PYBUGHIVE_REPO, "commit": dataset_commit},
        "scope_content_hash": content_hash,
        "counts": {"total": len(tasks),
                   "single_file": sum(1 for t in tasks if t["repair_scope"] == "single_file"),
                   "multi_file": len(multi)},
        "audit": {"multi_file_ids": [t["task_id"] for t in multi],
                  "per_fold": per_fold, "per_family": per_family,
                  "family_multi_share": {f: f"{per_family[f]}/{fam_total[f]}" for f in per_family},
                  "one_fold_holds_all_multi": one_fold_holds_all,
                  "family_majority_multi": majority_family,
                  "concentration_ok": concentration_ok},
        "enforcement": "the repo-backed verifier fails any write outside a task's "
                       "allowed_source_files; hidden (F2P) + public (P2P) tests unchanged.",
        "tasks": tasks,
    }
    json.dump(doc, open(OUT, "w"), indent=2)

    print("=" * 74)
    print(f"§2 SCOPE METADATA — target-file-set-given repair   frozen={doc['frozen']}")
    print("=" * 74)
    print(f"tasks: {doc['counts']}   scope_content_hash={content_hash}")
    print(f"manifest_sha256={manifest['admitted_sha256'][:16]}…  family_map_hash={fam_doc['family_map_content_hash']}")
    print(f"multi_file ids: {[t['task_id'] for t in multi]}")
    print(f"  per fold : {per_fold}   per family: {per_family}")
    print(f"  family multi-share: {doc['audit']['family_multi_share']}")
    print(f"  one fold holds all 4: {one_fold_holds_all}   family majority multi: {majority_family or 'none'}")
    print(f"  CONCENTRATION_OK: {concentration_ok} → "
          f"{'keep folds unchanged (reasonable spread)' if concentration_ok else 'DECLARE concentration + add sensitivity analysis'}")
    print(f"\nwritten → {os.path.relpath(OUT, HERE)}")
    print("D, manifest, family map, and folds are UNCHANGED. No model run.")


if __name__ == "__main__":
    main()
