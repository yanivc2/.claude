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

from meta_orchestrator.corpus.pybughive_qual import primary_sub_fingerprint, sub_fingerprints

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

    multi: Counter = Counter()
    primary: Counter = Counter()
    for cid in sorted(ids):
        diff = patch_by_id.get(cid, "")
        pl = primary_sub_fingerprint(diff)
        multi.update(sub_fingerprints(diff))
        primary.update([pl])
        print(f"  {cid:16s} primary={pl:22s} multi={sub_fingerprints(diff)}")

    n = len(admitted)
    p_distinct = len(primary)
    p_top = primary.most_common(1)[0] if primary else ("-", 0)
    p_top_share = p_top[1] / n if n else 0.0
    print(f"\n  MULTI-label distribution : {dict(multi.most_common())}")
    print(f"  PRIMARY-label distribution: {dict(primary.most_common())}")
    print(f"  PRIMARY distinct families : {p_distinct}")
    print(f"  PRIMARY top family        : {p_top[0]} = {p_top[1]}/{n} ({p_top_share:.0%})")
    print("\n  READ:")
    if p_distinct >= 3 and p_top_share <= 0.70:
        print(f"    The coarse 'Logic' 85% DISSOLVES under a tight primary label: {p_distinct} families, "
              f"top {p_top_share:.0%}. => the deficit was a MEASUREMENT artifact (coarse main taxonomy), "
              "NOT a real corpus limitation. Real intra-Logic diversity exists.")
    elif p_distinct >= 3:
        print(f"    {p_distinct} families appear, but one still dominates ({p_top[0]} {p_top_share:.0%}). "
              "Partial artifact: some real diversity, but a genuine concentration remains.")
    else:
        print(f"    Even under a tight primary label the bugs collapse to {p_distinct} families "
              f"({p_top[0]} {p_top_share:.0%}). => the concentration is REAL, not a measurement artifact.")


if __name__ == "__main__":
    main()
