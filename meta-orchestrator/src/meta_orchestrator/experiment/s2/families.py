"""Semantic primary-sub family set for §2 (single source of truth).

The families are exactly those the corpus qualifier assigns (``primary_sub_fingerprint``),
so folds, placebo routing, and the lesson bank all speak the same taxonomy the GATE1
decision froze. Nothing here reads a diff — it only lists the label space and hashes a map.
"""
from __future__ import annotations

import hashlib
import json

from ...corpus.pybughive_qual import _PRIMARY_ORDER

# The 6 specificity-ordered families + the `other_logic` fallback (see GATE1_DECISION.md).
SEMANTIC_FAMILIES: list[str] = [name for name, _ in _PRIMARY_ORDER] + ["other_logic"]


def is_known_family(family: str) -> bool:
    return family in SEMANTIC_FAMILIES


def family_map_hash(family_map: dict[str, str]) -> str:
    """Content hash of a task_id → family assignment (order-independent)."""
    payload = json.dumps(family_map, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
