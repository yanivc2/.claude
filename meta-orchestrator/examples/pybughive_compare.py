"""Pre/post F2P-detector-fix comparison (v2-corpus): full table + transition matrix.

Run:  python examples/pybughive_compare.py <pre.json> <post.json>
Objective, deterministic, model-free. Joins candidates by id; shows every status change,
the F2P test selection before/after, and the transition matrix requested by the reviewer.
"""
from __future__ import annotations

import json
import sys
from collections import Counter


def status(c: dict) -> str:
    return "admitted" if c.get("admitted") else (c.get("reject_reason") or "unknown")


def sel(c: dict) -> str:
    s = c.get("f2p_selection") or []
    return "; ".join(s) if s else "(fix .py test files)"


def main() -> None:
    pre_path = sys.argv[1] if len(sys.argv) > 1 else "pybughive_report_pre_f2p_detector_fix.json"
    post_path = sys.argv[2] if len(sys.argv) > 2 else "pybughive_report_post_f2p_fix.json"
    pre = {c["candidate_id"]: c for c in json.load(open(pre_path))["candidates"]}
    post = {c["candidate_id"]: c for c in json.load(open(post_path))["candidates"]}
    ids = sorted(set(pre) | set(post), key=lambda x: (x.split("-")[0], x))

    print("=== PRE/POST STATUS (changed candidates only) ===")
    changed = 0
    for cid in ids:
        a, b = pre.get(cid), post.get(cid)
        sa = status(a) if a else "(absent)"
        sb = status(b) if b else "(absent)"
        if sa == sb:
            continue
        changed += 1
        pm = b.get("patch") or (a.get("patch") if a else None)
        pmt = f"{pm['files']}f/{pm['changed_lines']}l/{pm['hunks']}h" if pm else "?"
        print(f"\n  {cid}   {sa}  ->  {sb}")
        print(f"      fp={b.get('fingerprint') if b else '-'}  patch={pmt}  "
              f"repro={b.get('reproducible') if b else '-'}  runtime={b.get('runtime_s') if b else '-'}s")
        print(f"      F2P selection PRE : {sel(a) if a else '-'}")
        print(f"      F2P selection POST: {sel(b) if b else '-'}")
    if not changed:
        print("  (no status changes)")

    print(f"\n=== TRANSITION MATRIX ({len(ids)} candidates) ===")
    trans = Counter((status(pre[c]) if c in pre else "(absent)",
                     status(post[c]) if c in post else "(absent)") for c in ids)
    unchanged = sum(v for (x, y), v in trans.items() if x == y)
    print(f"  unchanged: {unchanged}")
    for (x, y), v in sorted(trans.items(), key=lambda kv: -kv[1]):
        if x != y:
            print(f"  {x:38s} -> {y:38s} : {v}")

    # Highlighted transitions the reviewer asked for.
    def count(pred):
        return sum(1 for c in ids if c in pre and c in post and pred(status(pre[c]), status(post[c])))
    print("\n  highlighted:")
    print(f"    likely_harness_gap -> admitted/reproducible : "
          f"{count(lambda x, y: x == 'likely_harness_gap' and y in ('admitted',))}"
          f" admitted  (+reproducible-not-admitted: "
          f"{sum(1 for c in ids if c in pre and c in post and status(pre[c]) == 'likely_harness_gap' and post[c].get('reproducible') and not post[c].get('admitted'))})")
    print(f"    likely_harness_gap -> confirmed_non_reproducible : "
          f"{count(lambda x, y: x == 'likely_harness_gap' and y == 'confirmed_non_reproducible')}")
    print(f"    likely_harness_gap -> still likely_harness_gap   : "
          f"{count(lambda x, y: x == 'likely_harness_gap' and y == 'likely_harness_gap')}")
    print(f"    admitted -> rejected (REGRESSION)                : "
          f"{count(lambda x, y: x == 'admitted' and y != 'admitted')}")
    print(f"    rejected -> admitted                             : "
          f"{count(lambda x, y: x != 'admitted' and y == 'admitted')}")

    # Residual harness gap — the reviewer's gate on giving any final verdict.
    resid = sum(1 for c in post.values() if c.get("reject_reason") == "likely_harness_gap")
    print(f"\n  RESIDUAL likely_harness_gap (post-fix): {resid}/{len(post)}  "
          f"({resid / len(post):.0%})")


if __name__ == "__main__":
    main()
