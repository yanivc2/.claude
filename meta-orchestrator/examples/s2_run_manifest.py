"""Step 0 — build the locked §2 pilot Run manifest ($0, offline).

Produces one manifest binding the run to the exact commit + all frozen anchor hashes, budget
< $5, and status UNAUTHORIZED_FOR_MESSAGES. It performs NO network / paid call and cannot move
itself to an authorized status — only the Gate scripts (with production-valid, real-count
artifacts) can, and never offline.

Usage: python examples/s2_run_manifest.py [--run-id ID] [--commit SHA] [--budget 4.89] [--out PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone

from meta_orchestrator.experiment.s2 import assert_no_secrets, build_run_manifest

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _git_commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "UNKNOWN_COMMIT"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--commit", default=None)
    ap.add_argument("--budget", type=float, default=4.89)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_id = args.run_id or f"s2-pilot-{ts}"
    commit = args.commit or _git_commit()

    manifest = build_run_manifest(run_id, commit, budget_usd=args.budget, corpus_dir=_CORPUS)
    assert_no_secrets(manifest)                      # never persist a key / hidden-test datum

    doc = manifest.model_dump()
    print("=" * 78)
    print(f"§2 PILOT RUN MANIFEST — status={manifest.status}  budget=${manifest.budget_usd}")
    print("=" * 78)
    print(f"run_id : {manifest.run_id}")
    print(f"commit : {manifest.commit}")
    print("anchor hashes:")
    for k, v in sorted(manifest.hashes.items()):
        print(f"  {k}: {v}")
    print(f"manifest content_hash: {manifest.content_hash()}")
    assert manifest.budget_usd < 5.0, "budget must stay < $5 until Gate 1 justifies more"
    assert manifest.status == "UNAUTHORIZED_FOR_MESSAGES"
    print("\nstatus is UNAUTHORIZED_FOR_MESSAGES — no paid call is authorized. Gate 1 (pilot env,")
    print("real count_tokens + SDK-body green) is required before any Messages request.")
    if args.out:
        with open(args.out, "w") as f:
            json.dump(doc, f, indent=2, sort_keys=True)
        print(f"\nwrote manifest → {args.out}")
    print("=" * 78)


if __name__ == "__main__":
    main()
