"""What the estimator is given. Facts collected elsewhere — it reads nothing itself.

No filesystem, no repository, no network, no API. Whatever gathered these numbers did
the reading; keeping the estimator downstream of that is what makes it deterministic
and testable, and is why estimation cannot silently start costing money.

When something material is missing the request says so. The estimator then marks the
result **partial** and attaches clarifying questions, rather than inventing a value
and presenting it as though it had been supplied.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.plan import ExecutionMode
from ..contracts.scope import StageKind
from .metrics import ContentMetrics, RequestOverheads


class CallKind(str, Enum):
    """What a call is for. Kept apart so retries and verification never hide inside
    a blanket multiplier — the estimate has to show what each contributed."""

    PRIMARY = "primary"
    VERIFIER = "verifier"
    RETRY = "retry"
    REPAIR = "repair"
    SYNTHESIS = "synthesis"
    USER_CLARIFICATION = "user_clarification"


class StageInput(BaseModel):
    """One stage of the plan, with everything measured about it."""

    model_config = ConfigDict(frozen=True)

    stage_id: str
    kind: StageKind
    depends_on: list[str] = Field(default_factory=list)

    #: Content the model is shown for this stage.
    inputs: list[ContentMetrics] = Field(default_factory=list)
    #: Fixed per-call overheads (system prompt, tool schemas).
    overheads: RequestOverheads = Field(default_factory=RequestOverheads)

    #: Primary model calls this stage makes, before retries and verification.
    primary_calls: int = 1
    #: Hard ceiling on retries. ``None`` means unbounded, which the estimator refuses
    #: to price — an unbounded worst case is not a worst case.
    max_retries: Optional[int] = 0
    #: Verifier passes planned for this stage.
    verification_rounds: int = 0
    #: Rework rounds planned after a failed verification.
    max_rework_rounds: int = 0

    #: The output profile to use, by id. Resolved against the estimator's registry.
    output_profile_id: str = "default_short"
    #: Explicit per-call output cap, if the plan sets one.
    output_cap_tokens: Optional[int] = None
    #: Number of artefacts this stage produces (files, documents, alternatives).
    artifact_count: int = 1

    #: Whether a human performs this stage instead of the model.
    performed_by_human: bool = False
    #: Expected human minutes. Only meaningful when ``performed_by_human``.
    human_minutes: int = 0
    #: Whether human-supplied output still needs a model review pass.
    human_output_needs_review: bool = False

    blocking: bool = True
    parallelizable: bool = True

    @model_validator(mode="after")
    def _coherent(self) -> "StageInput":
        for field in ("primary_calls", "verification_rounds", "max_rework_rounds",
                      "artifact_count", "human_minutes"):
            if getattr(self, field) < 0:
                raise ValueError(f"StageInput.{field} cannot be negative")
        if self.max_retries is not None and self.max_retries < 0:
            raise ValueError("max_retries cannot be negative")
        if self.output_cap_tokens is not None and self.output_cap_tokens < 0:
            raise ValueError("output_cap_tokens cannot be negative")
        if not self.performed_by_human and self.human_minutes:
            raise ValueError(
                f"{self.stage_id!r} is not performed by a human but claims "
                f"{self.human_minutes} human minutes")
        if self.performed_by_human and self.primary_calls and not self.human_output_needs_review:
            # A human stage that still makes model calls is legitimate only when the
            # plan says the output is reviewed; otherwise the two contradict.
            raise ValueError(
                f"{self.stage_id!r} is performed by a human yet makes "
                f"{self.primary_calls} model call(s) without a stated review step")
        return self

    @property
    def has_unbounded_retries(self) -> bool:
        return self.max_retries is None


class EstimationRequest(BaseModel):
    """The complete input to one estimate."""

    model_config = ConfigDict(frozen=True)

    request_id: str
    scope_id: str
    plan_id: str
    plan_version: int
    plan_hash: str
    mode: ExecutionMode

    stages: list[StageInput]

    #: Registry model ids to project cost against. Empty means no cost projection.
    candidate_model_ids: list[str] = Field(default_factory=list)
    #: Whether prompt caching is expected to hit. Affects nothing in P1b beyond being
    #: recorded and flagged — no cache rate exists to price it with.
    expects_cache_hit: bool = False
    #: Whether the repeated context is genuinely shared between calls.
    shares_context_between_calls: bool = True

    #: Named inputs the caller knows are missing. Each becomes a clarifying question
    #: and forces the estimate to be reported as partial.
    missing_inputs: list[str] = Field(default_factory=list)
    #: Assumptions the caller is making, recorded with the estimate.
    stated_assumptions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _well_formed(self) -> "EstimationRequest":
        if not self.stages:
            raise ValueError("an estimation request needs at least one stage")
        ids = [s.stage_id for s in self.stages]
        if len(set(ids)) != len(ids):
            raise ValueError("stage ids must be unique within a request")
        known = set(ids)
        for stage in self.stages:
            unknown = set(stage.depends_on) - known
            if unknown:
                raise ValueError(
                    f"stage {stage.stage_id!r} depends on unknown: {sorted(unknown)}")
        if self.plan_version < 1:
            raise ValueError("plan_version starts at 1")
        if not self.plan_hash.strip():
            raise ValueError("an estimation request must name the plan hash it prices")
        return self

    def stage(self, stage_id: str) -> StageInput:
        for s in self.stages:
            if s.stage_id == stage_id:
                return s
        raise KeyError(stage_id)
