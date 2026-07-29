"""$0 audit of the frozen task_id → family binding for every §2 task (defect-5 apparatus check).

Offline / no model call. For all tasks in the scope metadata it asserts each family exists, is
non-empty, is a member of the frozen taxonomy, is present in the frozen corpus, and agrees with any
family the corpus record declares. Prints the per-task table + the family distribution + the frozen
family-map / taxonomy hashes, and exits non-zero unless every task is valid (27/27).

Usage: python examples/s2_family_binding_audit.py
"""
from __future__ import annotations

import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "src"))

from meta_orchestrator.experiment.s2.families import (  # noqa: E402
    SEMANTIC_FAMILIES, audit_family_bindings, family_map_hash, load_family_map, taxonomy_hash)


def main() -> None:
    corpus = os.path.join(HERE, "corpus")
    rows = audit_family_bindings(corpus)
    print(f"taxonomy ({len(SEMANTIC_FAMILIES)}): {SEMANTIC_FAMILIES}")
    print(f"family_map_hash={family_map_hash(load_family_map(corpus))}  taxonomy_hash={taxonomy_hash()}")
    print("-" * 84)
    for r in rows:
        flag = "OK " if r["valid"] else "BAD"
        print(f"  {flag} {r['task_id']:<16} {r['family']:<22} "
              f"in_map={r['in_map']} in_taxonomy={r['in_taxonomy']} in_corpus={r['in_corpus']} "
              f"agrees={r['agrees_with_corpus']}")
    dist = Counter(r["family"] for r in rows)
    valid = sum(1 for r in rows if r["valid"])
    print("-" * 84)
    print(f"family distribution: {dict(dist)}")
    print(f"AUDIT: {valid}/{len(rows)} valid")
    if valid != len(rows):
        raise SystemExit(f"FAMILY BINDING AUDIT FAILED — {len(rows) - valid} task(s) invalid")
    print("all task families are non-empty, in the frozen taxonomy, and agree with the corpus.")


if __name__ == "__main__":
    main()
