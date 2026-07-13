"""Minimal task taxonomy (SPEC §2) — Phase 1 covers only the seed task.

Kept deliberately small: just enough hierarchy + breadth nodes to classify and
key memory for the ``Software:Debug`` seed task. Extend per SPEC §2 in later phases.
"""
from __future__ import annotations

from .models import BreadthDims, Risk, TaskClassification, TaxonomyNode, Verifiable

# Hierarchy + breadth nodes persisted into the `taxonomy` table (A3).
SEED_TAXONOMY: list[TaxonomyNode] = [
    # --- hierarchy (categories) ---
    TaxonomyNode(label="Software", kind="category", description="Software engineering tasks"),
    TaxonomyNode(
        label="Software:Debug",
        parent="Software",
        kind="category",
        description="Fix a bug so a failing test suite passes (the seed task).",
    ),
    # --- breadth dimensions (cross-cutting, SPEC §2) ---
    TaxonomyNode(label="verifiable", kind="breadth", description="yes | no | partial"),
    TaxonomyNode(label="risk", kind="breadth", description="low | med | high"),
    TaxonomyNode(label="needs_live_data", kind="breadth", description="bool"),
    TaxonomyNode(label="subjective_dimension", kind="breadth", description="bool"),
]

# The single task type Phase 1 proves learning on.
SEED_TASK_TYPE = "Software:Debug"


def classify_seed_task() -> TaskClassification:
    """Provisional classification for the code-fix seed task (SPEC §8: reversible).

    The full Router lives in a later milestone; for Phase 1 the seed corpus is a
    single known task type, so this returns its labels + breadth directly.
    """
    return TaskClassification(
        labels=["Software", "Software:Debug"],
        breadth=BreadthDims(
            verifiable=Verifiable.YES,
            risk=Risk.LOW,
            needs_live_data=False,
            subjective_dimension=False,
        ),
        confidence=0.9,
        provisional=True,
    )
