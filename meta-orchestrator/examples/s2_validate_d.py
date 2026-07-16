"""Validate + freeze an independent author's D submission. Run LATER, on the real submission.

Run:  python examples/s2_validate_d.py <submission.json>

Loads the author's DSubmission, validates it against the blind schema + leak scan + slot budget
(using the frozen family map's present families), and — only if clean — freezes it into
``corpus/d_playbook.frozen.json`` with a content hash and author provenance. NO model, NO corpus
answers are consulted. This script writes NO advice of its own; it only checks and freezes what
an independent author wrote. (Not run yet — D has not been authored.)
"""
from __future__ import annotations

import json
import os
import sys

from meta_orchestrator.experiment.s2.playbook_d import (DSubmission, DValidationError, freeze_d,
                                                        submission_hash, validate_d_submission)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_PATH = os.path.join(HERE, "corpus", "s2_family_map.json")
OUT = os.path.join(HERE, "corpus", "d_playbook.frozen.json")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: s2_validate_d.py <submission.json>")
    fam_doc = json.load(open(MAP_PATH))
    if fam_doc.get("synthetic", True):
        raise SystemExit("family map is still synthetic — freeze the real map first")
    present = sorted(set(fam_doc["family_map"].values()))

    sub = DSubmission.model_validate_json(open(sys.argv[1]).read())
    errors = validate_d_submission(sub, present)
    if errors:
        print("D REJECTED — do not freeze:")
        for e in errors:
            print(f"  - {e}")
        raise SystemExit(1)

    pb = freeze_d(sub, present)
    frozen = {
        "author": pb.author,
        "author_frozen": pb.author_frozen,
        "submission_hash": submission_hash(sub),
        "content_hash": pb.content_hash(),
        "present_families": present,
        "by_family": pb.by_family,
    }
    json.dump(frozen, open(OUT, "w"), indent=2)
    print(f"D VALIDATED + FROZEN → {os.path.relpath(OUT, HERE)}")
    print(f"  author={pb.author}  content_hash={pb.content_hash()}  submission_hash={submission_hash(sub)}")


if __name__ == "__main__":
    main()
