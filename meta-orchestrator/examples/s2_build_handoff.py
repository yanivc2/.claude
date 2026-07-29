"""Build the §2 pilot handoff bundle + its separate seal ($0, offline).

Writes corpus/S2_PILOT_HANDOFF_MANIFEST.json (observations + per-file hashes) and
corpus/S2_PILOT_HANDOFF_MANIFEST.sha256 (the manifest's own sha256 — a manifest cannot hash
itself). No network / paid call. Run examples/s2_verify_handoff.py afterwards to confirm.

Usage: python examples/s2_build_handoff.py [--run-id ID] [--offline-passed N] [--offline-skipped N]
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone

from meta_orchestrator.experiment.s2.handoff import build_handoff_manifest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MANIFEST = os.path.join(_ROOT, "corpus", "S2_PILOT_HANDOFF_MANIFEST.json")
_SEAL = os.path.join(_ROOT, "corpus", "S2_PILOT_HANDOFF_MANIFEST.sha256")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--offline-passed", type=int, default=194)   # recorded observation
    ap.add_argument("--offline-skipped", type=int, default=2)
    args = ap.parse_args()

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_id = args.run_id or f"s2-pilot-{ts}"
    manifest, seal = build_handoff_manifest(_ROOT, run_id=run_id, bundle_id=f"handoff-{ts}",
                                            created_at=ts, offline_passed=args.offline_passed,
                                            offline_skipped=args.offline_skipped)
    with open(_MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    with open(_SEAL, "w") as f:
        f.write(seal + "  S2_PILOT_HANDOFF_MANIFEST.json\n")

    print("=" * 78)
    print("§2 PILOT HANDOFF BUNDLE — built ($0, offline)")
    print("=" * 78)
    print(f"run_id            : {manifest['run_id']}")
    print(f"git_commit        : {manifest['git_commit']}")
    print(f"clean_worktree    : {manifest['clean_worktree']}")
    print(f"files in inventory: {len(manifest['inventory'])}")
    print(f"content_inventory : {manifest['content_inventory_hash'][:16]}")
    print(f"authorization     : {manifest['authorization_state']}  paid={manifest['paid_api_called']}")
    print(f"manifest → {_MANIFEST}")
    print(f"seal     → {_SEAL}  ({seal[:16]}…)")
    print("\nFIRST command to run in the pinned pilot env (before anything else):")
    print("  python examples/s2_verify_handoff.py \\")
    print("    --manifest corpus/S2_PILOT_HANDOFF_MANIFEST.json \\")
    print("    --seal corpus/S2_PILOT_HANDOFF_MANIFEST.sha256")
    print("=" * 78)


if __name__ == "__main__":
    main()
