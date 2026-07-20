"""Semantic primary-sub family set for §2 (single source of truth).

The families are exactly those the corpus qualifier assigns (``primary_sub_fingerprint``),
so folds, placebo routing, and the lesson bank all speak the same taxonomy the GATE1
decision froze. Nothing here reads a diff — it only lists the label space and hashes a map.
"""
from __future__ import annotations

import hashlib
import json
import os

from ...corpus.pybughive_qual import _PRIMARY_ORDER
from .gate_error import GateError

# The 6 specificity-ordered families + the `other_logic` fallback (see GATE1_DECISION.md).
SEMANTIC_FAMILIES: list[str] = [name for name, _ in _PRIMARY_ORDER] + ["other_logic"]


def is_known_family(family: str) -> bool:
    return family in SEMANTIC_FAMILIES


class TaskFamilyBindingError(GateError):
    """A task's family is empty / null / not in the frozen taxonomy / mismatched across components.
    An APPARATUS/INFRA failure (defect 5) — must block BEFORE any reservation or messages.create; no
    model call, no write-gate, no bank mutation, no curriculum advancement."""


def assert_task_family_valid(task_family: str | None) -> str:
    """Fail-closed: a task family MUST be a non-empty member of the frozen taxonomy."""
    if not task_family or not is_known_family(task_family):
        raise TaskFamilyBindingError(
            f"task_family {task_family!r} is empty or not in the frozen taxonomy {SEMANTIC_FAMILIES}")
    return task_family


def resolve_task_family(corpus_dir: str, task_id: str) -> str:
    """Load a task's family from the FROZEN, authoritative family map and validate it (fail-closed)."""
    fm = json.load(open(os.path.join(corpus_dir, "s2_family_map.json")))["family_map"]
    if task_id not in fm:
        raise TaskFamilyBindingError(f"{task_id}: not present in the frozen family map")
    return assert_task_family_valid(fm[task_id])


def family_map_hash(family_map: dict[str, str]) -> str:
    """Content hash of a task_id → family assignment (order-independent)."""
    payload = json.dumps(family_map, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def taxonomy_hash() -> str:
    """Content hash of the frozen family LABEL SPACE (order-preserving — specificity order matters)."""
    payload = json.dumps(SEMANTIC_FAMILIES, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def load_family_map(corpus_dir: str) -> dict[str, str]:
    """Load the frozen task_id → family map (raw dict, unvalidated per-entry)."""
    return json.load(open(os.path.join(corpus_dir, "s2_family_map.json")))["family_map"]


def audit_family_bindings(corpus_dir: str) -> list[dict]:
    """$0 audit of ``task_id → family`` over the authoritative task universe (the scope metadata).

    For every task returns whether its family exists, is non-empty, is in the frozen taxonomy, is
    present in the frozen corpus, and (when the corpus record declares one) agrees with it. A row is
    ``valid`` iff all of those hold. Pure/offline — no model call, no network.
    """
    fmap = load_family_map(corpus_dir)
    scope = json.load(open(os.path.join(corpus_dir, "s2_scope_metadata.json")))["tasks"]
    corpus_tasks = json.load(open(os.path.join(corpus_dir, "s2_real_corpus.json")))["tasks"]
    rows: list[dict] = []
    for tid in sorted(t["task_id"] for t in scope):
        fam = fmap.get(tid)
        known = bool(fam) and is_known_family(fam)
        in_corpus = tid in corpus_tasks
        rec = corpus_tasks.get(tid, {})
        declared = rec.get("family") or rec.get("task_family")           # may be absent
        agrees = declared is None or declared == fam
        rows.append({"task_id": tid, "family": fam, "in_map": tid in fmap,
                     "in_taxonomy": known, "in_corpus": in_corpus,
                     "corpus_family": declared, "agrees_with_corpus": agrees,
                     "valid": bool(known and in_corpus and agrees and tid in fmap)})
    return rows
