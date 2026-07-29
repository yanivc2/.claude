"""Validate + freeze an independent author's D submission. Run LATER, on the real submission.

Run:  python examples/s2_validate_d.py <submission.json> [--attest-independent]

Loads the author's DSubmission (schema-only JSON), validates it against the blind schema + leak
scan + slot budget (using the frozen family map's present families), and — only if clean —
freezes it into ``corpus/d_playbook.frozen.json`` with a content hash and author provenance.

Policy (per the frozen authoring process):
- On FAILURE: print ONLY the technical schema/validation messages. These are the ONLY thing to
  return to the author — never a content hint about the corpus, bugs, or expected advice.
- Do NOT hand-edit the author's content. If it fails, the author revises and resubmits.
- NO model, NO corpus answers are consulted here. This script writes no advice of its own.
"""
from __future__ import annotations

import json
import os
import sys

from meta_orchestrator.experiment.s2.playbook_d import (DSubmission, freeze_d, submission_hash,
                                                        validate_d_submission)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_PATH = os.path.join(HERE, "corpus", "s2_family_map.json")
OUT = os.path.join(HERE, "corpus", "d_playbook.frozen.json")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    attest_independent = "--attest-independent" in sys.argv
    if not args:
        raise SystemExit("usage: s2_validate_d.py <submission.json> [--attest-independent]")

    fam_doc = json.load(open(MAP_PATH))
    if fam_doc.get("synthetic", True):
        raise SystemExit("family map is still synthetic — freeze the real map first")
    present = sorted(set(fam_doc["family_map"].values()))

    sub = DSubmission.model_validate_json(open(args[0]).read())
    errors = validate_d_submission(sub, present)
    if errors:
        print("D REJECTED — return ONLY these technical messages to the author (no content hints):")
        for e in errors:
            print(f"  - {e}")
        raise SystemExit(1)

    pb = freeze_d(sub, present)
    frozen = {
        "author_type": sub.author_type,
        "author_name": sub.author_name,
        "author": pb.author,
        "author_frozen": pb.author_frozen,
        "independence_attested_by_operator": attest_independent,
        "submission_hash": submission_hash(sub),
        "content_hash": pb.content_hash(),
        "present_families": present,
        "family_map_content_hash": fam_doc.get("family_map_content_hash"),
        "by_family": pb.by_family,          # the ONLY injected content (author metadata excluded)
    }
    json.dump(frozen, open(OUT, "w"), indent=2)
    print(f"D VALIDATED + FROZEN → {os.path.relpath(OUT, HERE)}")
    print(f"  author={pb.author}  content_hash={pb.content_hash()}  submission_hash={submission_hash(sub)}")
    if not attest_independent:
        print("  NOTE: operator did not pass --attest-independent; record author independence "
              "before the run (author must not have seen the corpus/tasks/results/C lessons).")


if __name__ == "__main__":
    main()
