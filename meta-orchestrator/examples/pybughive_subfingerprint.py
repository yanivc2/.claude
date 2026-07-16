"""Axis C: decompose the coarse `Logic` fingerprint of ADMITTED bugs into objective,
multi-label semantic sub-categories, to test whether real semantic diversity already
exists inside black. Model-free, $0. Does NOT change the main taxonomy or any gate.

Run:  python examples/pybughive_subfingerprint.py [report.json]
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

from meta_orchestrator.corpus.pybughive_qual import sub_fingerprints

PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"


def _src_patch_text(issue: dict) -> str:
    commit = issue["commits"][0]
    files = commit["stat"].get("files", [])
    src = [f for f in files if not f["filename"].endswith((".md", ".rst", ".txt"))
           and "test" not in f["filename"].lower()]
    return "\n".join(f.get("patch", "") for f in src)


def main() -> None:
    report = sys.argv[1] if len(sys.argv) > 1 else "pybughive_report_post_f2p_fix.json"
    admitted = [c for c in json.load(open(report))["candidates"]
                if c.get("admitted") and c.get("fingerprint") == "Logic"]
    ids = {c["candidate_id"] for c in admitted}
    print(f"=== Axis C: sub-fingerprints of {len(admitted)} admitted 'Logic' bugs ===")

    work = tempfile.mkdtemp(prefix="pbh_subfp_")
    repo = os.path.join(work, "pbh")
    subprocess.run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, repo],
                   check=True, timeout=300)
    data = json.load(open(os.path.join(repo, "dataset", "pybughive_current.json")))
    patch_by_id = {f"{p['repository']}-{iss['id']}": _src_patch_text(iss)
                   for p in data for iss in p["issues"]}

    label_counter: Counter = Counter()
    per_bug = []
    for cid in sorted(ids):
        labels = sub_fingerprints(patch_by_id.get(cid, ""))
        per_bug.append((cid, labels))
        label_counter.update(labels)
        print(f"  {cid:16s} -> {labels}")

    distinct = len(label_counter)
    top = label_counter.most_common(1)[0] if label_counter else ("-", 0)
    top_share = top[1] / len(admitted) if admitted else 0.0
    print(f"\n  sub-fingerprint distribution (multi-label): {dict(label_counter.most_common())}")
    print(f"  distinct sub-fingerprints: {distinct}")
    print(f"  most common: {top[0]} in {top[1]}/{len(admitted)} bugs ({top_share:.0%})")
    print("\n  interpretation: if the 'Logic' bugs spread across several sub-categories, "
          "the diversity deficit is partly a TAXONOMY-granularity artifact, not a real "
          "corpus limitation. (Descriptive only — main taxonomy and gates unchanged.)")


if __name__ == "__main__":
    main()
