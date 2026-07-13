"""Shared domain types used across the orchestrator (Milestone A onward).

These pydantic models are also the persistence-facing shapes: the ``Store``
serialises/deserialises them to/from the backing DB.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------- #
# Taxonomy breadth dimensions (SPEC §2)
# --------------------------------------------------------------------------- #
class Verifiable(str, Enum):
    YES = "yes"
    NO = "no"
    PARTIAL = "partial"


class Risk(str, Enum):
    LOW = "low"
    MED = "med"
    HIGH = "high"


class BreadthDims(BaseModel):
    """Cross-cutting dimensions tagged on every task (SPEC §2)."""

    verifiable: Verifiable = Verifiable.YES
    risk: Risk = Risk.LOW
    needs_live_data: bool = False
    latency_tolerance: str = "normal"  # low | normal | high
    context_size: str = "small"        # small | medium | large
    subjective_dimension: bool = False


class TaskClassification(BaseModel):
    """Multi-label classification of a task (SPEC §2, §8).

    ``provisional`` marks the classification as a reversible best-guess that the
    graph may re-classify mid-run (SPEC §8).
    """

    labels: list[str] = Field(default_factory=list)  # e.g. ["Software", "Software:Debug"]
    breadth: BreadthDims = Field(default_factory=BreadthDims)
    confidence: float = 0.5
    provisional: bool = True

    def playbook_key(self) -> str:
        """Memory is keyed on (task type + relevant breadth dims) — SPEC §2."""
        leaf = self.labels[-1] if self.labels else "Unknown"
        return f"{leaf}|risk:{self.breadth.risk.value}|verifiable:{self.breadth.verifiable.value}"


class TaxonomyNode(BaseModel):
    """A single node in the (minimal) task taxonomy."""

    label: str
    parent: Optional[str] = None
    kind: str = "category"  # "category" | "breadth"
    description: str = ""


# --------------------------------------------------------------------------- #
# Model Registry (SPEC §9) — provenance-carrying eval scores
# --------------------------------------------------------------------------- #
class EvalScore(BaseModel):
    """A model's score on a task_type, WITH provenance (SPEC §9).

    A score with no source is worthless — every field here is mandatory context.
    """

    task_type: str
    score: float
    n_samples: int
    date: str
    source: str


class ModelSpec(BaseModel):
    """Registry entry for a model. Model *names* live only here (SPEC §6, §9)."""

    model_config = ConfigDict(protected_namespaces=())  # allow the `model_id` field name

    model_id: str
    provider: str
    capabilities: list[str] = Field(default_factory=list)
    price_per_1k_in: float = 0.0
    price_per_1k_out: float = 0.0
    latency_ms: int = 0
    context_limit: int = 8192
    tool_support: bool = False
    availability: bool = True
    fallback_model: Optional[str] = None
    last_verified: Optional[str] = None
    eval_scores: list[EvalScore] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Memory: Playbook (SPEC §5.1, §5.9) + Decision Records (SPEC §5.8)
# --------------------------------------------------------------------------- #
class PlaybookEntry(BaseModel):
    """Tier-1 compact playbook row per task-type (SPEC §5.1).

    ``content`` holds the compact "what worked / models / tools / cost / avoid"
    summary that is read INSTEAD of full history (the token saving). Carries
    ``confidence``, ``expiry`` (staleness, §5.9) and ``version`` (rollback, §5.9).
    """

    key: str
    content: dict[str, Any] = Field(default_factory=dict)
    confidence: float = 0.0
    expiry: Optional[str] = None
    version: int = 1
    updated_at: Optional[str] = None


class DecisionRecord(BaseModel):
    """Why a path was chosen on a run (SPEC §5.8) — the audit trail for regressions."""

    run_id: str
    node: str
    chosen: str
    utility: float
    alternatives: list[dict[str, Any]] = Field(default_factory=list)
    reason: str = ""
    created_at: Optional[str] = None
