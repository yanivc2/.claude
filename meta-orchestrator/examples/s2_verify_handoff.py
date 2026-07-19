"""Verify the §2 pilot handoff bundle — the FIRST command to run in the pinned pilot env.

Exit 0 is the precondition for standing up the environment and running the suite. Any tamper /
transfer error / missing-or-extra critical file / unclean worktree / carried-authorization →
nonzero exit. No network / paid call.

Usage:
  python examples/s2_verify_handoff.py \
    --manifest corpus/S2_PILOT_HANDOFF_MANIFEST.json \
    --seal corpus/S2_PILOT_HANDOFF_MANIFEST.sha256
"""
from __future__ import annotations

import argparse
import os
import sys

from meta_orchestrator.experiment.s2.handoff import verify_handoff

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="corpus/S2_PILOT_HANDOFF_MANIFEST.json")
    ap.add_argument("--seal", default="corpus/S2_PILOT_HANDOFF_MANIFEST.sha256")
    ap.add_argument("--repo-root", default=_ROOT)
    args = ap.parse_args()

    res = verify_handoff(args.repo_root, os.path.join(args.repo_root, args.manifest),
                         os.path.join(args.repo_root, args.seal))
    print("=" * 78)
    print(f"§2 HANDOFF VERIFICATION — {'OK' if res.ok else 'FAILED'}")
    print("=" * 78)
    if res.ok:
        print("bundle intact; worktree clean; status UNAUTHORIZED_FOR_MESSAGES; no paid call.")
        print("→ safe to stand up the pinned pilot env and run the full suite (0 skips required).")
    else:
        print("BLOCKED — do not proceed. Reasons:")
        for r in res.reasons:
            print(f"  - {r}")
    print("=" * 78)
    return 0 if res.ok else 1


if __name__ == "__main__":
    sys.exit(main())
