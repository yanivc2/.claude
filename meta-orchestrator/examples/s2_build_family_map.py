"""Derive the REAL §2 family map from the frozen qualification corpus — $0, NO model.

Each admitted task's family is computed purely by ``primary_sub_fingerprint`` over its
reference source diff (the same model-free signal qualification used). No manual editing, no
bug-specific override. The map is frozen with provenance (fingerprinter version + source hash,
corpus manifest sha256, dataset commit, per-task qualification record) and then validated:
27 tasks, no dup/missing, 9/9/9 stratified folds, every task held-out once, and — critically —
every family that appears in a fold's held-out TEST is also represented in that fold's TRAIN.

Run:  python examples/s2_build_family_map.py [path/to/pybughive_current.json]

Emits corpus/s2_family_map.json (synthetic:false) and prints a short report. Runs NO model and
does NOT wire real bugs — that is the next, separate blocker.
"""
from __future__ import annotations

import datetime
import hashlib
import inspect
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

from meta_orchestrator.corpus.pybughive_qual import _PRIMARY_ORDER, primary_sub_fingerprint
from meta_orchestrator.experiment.s2 import (PlaceboRouter, family_map_hash, stratified_folds,
                                             train_representation_gaps, validate_folds)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(HERE, "pybughive_gate1_manifest.json")
QUAL_REPORT = os.path.join(HERE, "pybughive_report_post_f2p_fix.json")
OUT = os.path.join(HERE, "corpus", "s2_family_map.json")
PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"
FINGERPRINTER_VERSION = "primary-sub-v1"
K_FOLDS = 3


def _fingerprinter_source_hash() -> str:
    """Content hash of the labeller so a silent change to the taxonomy is detectable."""
    patterns = "|".join(f"{n}:{p.pattern}" for n, p in _PRIMARY_ORDER)
    payload = f"{FINGERPRINTER_VERSION}|{patterns}|{inspect.getsource(primary_sub_fingerprint)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _src_patch_text(issue: dict) -> str:
    commit = issue["commits"][0]
    files = commit["stat"].get("files", [])
    src = [f for f in files if not f["filename"].endswith((".md", ".rst", ".txt"))
           and "test" not in f["filename"].lower()]
    return "\n".join(f.get("patch", "") for f in src)


def _load_dataset(path: str | None) -> tuple[dict, str]:
    if path and os.path.exists(path):
        return json.load(open(path)), "local:" + os.path.basename(path)
    work = tempfile.mkdtemp(prefix="pbh_fammap_")
    repo = os.path.join(work, "pbh")
    subprocess.run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, repo],
                   check=True, timeout=300)
    commit = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=True).stdout.strip()
    data = json.load(open(os.path.join(repo, "dataset", "pybughive_current.json")))
    return data, commit


def main() -> None:
    manifest = json.load(open(MANIFEST))
    admitted = list(manifest["admitted_ids"])
    corpus_sha = manifest["admitted_sha256"]
    qual = {c["candidate_id"]: c for c in json.load(open(QUAL_REPORT))["candidates"]}

    dataset, dataset_commit = _load_dataset(sys.argv[1] if len(sys.argv) > 1 else None)
    patch_by_id = {f"{p['repository']}-{iss['id']}": _src_patch_text(iss)
                   for p in dataset for iss in p["issues"]}

    missing = [i for i in admitted if i not in patch_by_id]
    if missing:
        raise SystemExit(f"FATAL: {len(missing)} admitted ids absent from dataset: {missing}")

    # --- derive labels purely from primary_sub_fingerprint (no manual mapping) ---
    tasks = []
    family_map: dict[str, str] = {}
    for tid in sorted(admitted):
        fam = primary_sub_fingerprint(patch_by_id[tid])
        family_map[tid] = fam
        rec = qual.get(tid, {})
        tasks.append({
            "task_id": tid,
            "primary_sub": fam,
            "fingerprinter_version": FINGERPRINTER_VERSION,
            "provenance": {
                "qualification_report": os.path.basename(QUAL_REPORT),
                "admitted": rec.get("admitted"),
                "legacy_fingerprint": rec.get("fingerprint"),
                "patch_metrics": rec.get("patch"),
                "dataset_issue": tid,
            },
        })

    # --- validation ---
    assert len(family_map) == 27, f"expected 27, got {len(family_map)}"
    assert len(set(family_map)) == len(admitted), "duplicate task id"
    folds = stratified_folds(family_map, K_FOLDS)
    validate_folds(folds, sorted(family_map))              # each task held-out exactly once
    sizes = [len(f.test_ids) for f in folds]
    gaps = train_representation_gaps(folds, family_map)

    counts = dict(Counter(family_map.values()).most_common())
    content_hash = family_map_hash(family_map)
    frozen = gaps == [] and sizes == [9, 9, 9]

    # B1 placebo — derived deterministically from the PRESENT families only (no model,
    # no reference patch). Frozen alongside the map so B1 routing is auditable.
    present_families = sorted(set(family_map.values()))
    placebo = PlaceboRouter.build(present_families)
    b1_fixed_points = [f for f in present_families if placebo.route(f) == f]

    doc = {
        "synthetic": False,
        "frozen": frozen,
        "frozen_at": datetime.datetime.utcnow().isoformat() + "Z",
        "taxonomy": "semantic primary-sub",
        "fingerprinter": {"version": FINGERPRINTER_VERSION,
                          "source_hash": _fingerprinter_source_hash()},
        "corpus_manifest_sha256": corpus_sha,
        "family_map_content_hash": content_hash,
        "split_version": 1,
        "k_folds": K_FOLDS,
        "dataset_provenance": {"repo": PYBUGHIVE_REPO,
                               "file": "dataset/pybughive_current.json",
                               "commit": dataset_commit},
        "family_counts": counts,
        "fold_split": [{"index": f.index, "n_train": len(f.train_ids),
                        "n_test": len(f.test_ids), "test_ids": f.test_ids} for f in folds],
        "train_representation_gaps": gaps,
        "b1_placebo": {"over_families": present_families, "mapping": placebo.mapping,
                       "map_hash": placebo.map_hash(), "fixed_points": b1_fixed_points},
        "tasks": tasks,
        "family_map": family_map,
    }
    if not frozen:
        doc["frozen"] = False
        doc["freeze_blocked_reason"] = (
            f"sizes={sizes} (want 9/9/9); gaps={gaps} — regenerate split under a new "
            "split_version via the frozen stratifier; do NOT hand-edit any task.")

    json.dump(doc, open(OUT, "w"), indent=2)

    # --- report ---
    print("=" * 74)
    print(f"§2 REAL FAMILY MAP — synthetic=False frozen={frozen}")
    print("=" * 74)
    print(f"tasks: {len(family_map)}  missing/dup: none")
    print(f"family distribution: {counts}")
    print(f"fold sizes (test): {sizes}   every task held-out exactly once: True")
    for f in folds:
        tc = dict(Counter(family_map[t] for t in f.test_ids).most_common())
        print(f"  fold {f.index}: test n={len(f.test_ids)} families={tc}")
    print(f"train-representation gaps: {gaps if gaps else 'NONE (every test family present in train)'}")
    print(f"B1 placebo (over {len(present_families)} present families): {placebo.mapping}")
    print(f"  fixed points: {b1_fixed_points if b1_fixed_points else 'NONE'}  map_hash={placebo.map_hash()}")
    print("hashes:")
    print(f"  family_map_content_hash : {content_hash}")
    print(f"  corpus_manifest_sha256  : {corpus_sha[:16]}…")
    print(f"  fingerprinter           : {FINGERPRINTER_VERSION} / {_fingerprinter_source_hash()}")
    print(f"  dataset_commit          : {dataset_commit}")
    print(f"\nwritten → {os.path.relpath(OUT, HERE)}")
    print("STOP — no model run; real-bug wiring is the next separate blocker."
          if frozen else "NOT FROZEN — split regeneration required before proceeding.")


if __name__ == "__main__":
    main()
