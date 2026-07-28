"""What the user asked for, what is missing, and how the work breaks down.

The Planner refuses to price a scope it does not understand. ``ProjectScope`` therefore
carries an explicit record of what is *not* known (``open_questions``), and the
architecture forbids issuing a final estimate while blocking questions are unanswered
— a rule enforced in the plan state machine, not by convention.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class QualityTarget(str, Enum):
    DRAFT = "draft"
    STANDARD = "standard"
    HIGH = "high"
    PUBLICATION = "publication"


class RiskTolerance(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class StageKind(str, Enum):
    """The unit of work an estimate is attached to.

    Deliberately coarse and task-agnostic: the meta-orchestrator is not a code-fix
    tool, and a taxonomy built around the seed task would not survive contact with
    research or document work.
    """

    REQUIREMENTS = "requirements"
    RESEARCH = "research"
    READ_SOURCES = "read_sources"
    ANALYZE = "analyze"
    DESIGN = "design"
    GENERATE = "generate"
    VERIFY = "verify"
    INDEPENDENT_REVIEW = "independent_review"
    REWORK = "rework"
    SYNTHESIZE = "synthesize"
    PERSIST_MEMORY = "persist_memory"


class ClarifyingQuestion(BaseModel):
    """Something the Planner needs answered before it will commit to a figure."""

    model_config = ConfigDict(frozen=True)

    question_id: str
    question: str
    #: Blocking questions prevent the scope from reaching READY_FOR_ESTIMATE.
    blocking: bool = True
    why_it_matters: str = ""

    @model_validator(mode="after")
    def _populated(self) -> "ClarifyingQuestion":
        if not self.question.strip():
            raise ValueError("ClarifyingQuestion.question must not be empty")
        return self


class ProjectScope(BaseModel):
    """The characterised request. Input to estimation, never produced by it."""

    model_config = ConfigDict(frozen=True)

    scope_id: str
    description: str
    goal: str = ""
    deliverables: list[str] = Field(default_factory=list)
    quality_target: QualityTarget = QualityTarget.STANDARD
    deadline: str | None = None                       # ISO-8601
    risk_tolerance: RiskTolerance = RiskTolerance.MEDIUM

    #: Registry model ids the operator permits. Empty means "unconstrained" — which
    #: the estimator must treat as a reason to lower confidence, not to guess.
    allowed_model_ids: list[str] = Field(default_factory=list)
    allowed_tool_ids: list[str] = Field(default_factory=list)

    #: Whether parts may be handed to a human or an outside tool. Gates the
    #: HUMAN_ASSISTED execution mode.
    human_work_available: bool = False
    external_tools_available: bool = False

    existing_assets: list[str] = Field(default_factory=list)
    open_questions: list[ClarifyingQuestion] = Field(default_factory=list)

    @model_validator(mode="after")
    def _populated(self) -> "ProjectScope":
        if not self.description.strip():
            raise ValueError("ProjectScope.description must not be empty")
        ids = [q.question_id for q in self.open_questions]
        if len(ids) != len(set(ids)):
            raise ValueError("ClarifyingQuestion ids must be unique within a scope")
        return self

    def blocking_questions(self) -> list[ClarifyingQuestion]:
        return [q for q in self.open_questions if q.blocking]

    def is_ready_for_estimate(self) -> bool:
        """True only when nothing blocking is outstanding."""
        return not self.blocking_questions()


class EstimateAssumptions(BaseModel):
    """The assumptions an estimate stands on, recorded so it can be re-derived.

    Kept beside the estimate rather than inside the estimator: when an actual comes in
    far from the estimate, the first question is which assumption broke, and that is
    unanswerable if the assumptions were never written down.
    """

    model_config = ConfigDict(frozen=True)

    #: Characters per token used to convert text size to tokens.
    chars_per_token: int = 4
    #: Fraction of stages expected to need a rework round, 0..1, as a decimal string.
    rework_rate: str = "0.25"
    #: Retries budgeted per call.
    retries_per_call: int = 1
    #: Whether prompt caching is assumed to hit.
    assumes_cache_hit: bool = False
    #: Anything else that materially shaped the numbers.
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _sane(self) -> "EstimateAssumptions":
        if self.chars_per_token < 1:
            raise ValueError("chars_per_token must be >= 1")
        if self.retries_per_call < 0:
            raise ValueError("retries_per_call cannot be negative")
        return self


class WorkItem(BaseModel):
    """One stage in the breakdown, before any estimate is attached."""

    model_config = ConfigDict(frozen=True)

    item_id: str
    kind: StageKind
    description: str
    depends_on: list[str] = Field(default_factory=list)
    #: A blocking item stops the plan if it fails; a non-blocking one degrades it.
    blocking: bool = True
    #: Whether a human or external tool could take this item instead of the engine.
    delegable: bool = False


class WorkBreakdown(BaseModel):
    """The stage graph for a scope. A graph, not a list — stages run in parallel."""

    model_config = ConfigDict(frozen=True)

    scope_id: str
    items: list[WorkItem]

    @model_validator(mode="after")
    def _well_formed(self) -> "WorkBreakdown":
        if not self.items:
            raise ValueError("WorkBreakdown must contain at least one item")
        ids = [i.item_id for i in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("WorkItem ids must be unique within a breakdown")
        known = set(ids)
        for item in self.items:
            unknown = set(item.depends_on) - known
            if unknown:
                raise ValueError(f"{item.item_id!r} depends on unknown item(s): {sorted(unknown)}")
            if item.item_id in item.depends_on:
                raise ValueError(f"{item.item_id!r} depends on itself")
        self._assert_acyclic()
        return self

    def _assert_acyclic(self) -> None:
        remaining = {i.item_id: set(i.depends_on) for i in self.items}
        done: set[str] = set()
        while remaining:
            ready = {k for k, deps in remaining.items() if deps <= done}
            if not ready:
                raise ValueError(f"cycle detected among: {sorted(remaining)}")
            done |= ready
            for k in ready:
                del remaining[k]

    def levels(self) -> list[list[str]]:
        """Dependency levels; every id within a level may run in parallel."""
        remaining = {i.item_id: set(i.depends_on) for i in self.items}
        done: set[str] = set()
        out: list[list[str]] = []
        while remaining:
            ready = sorted(k for k, deps in remaining.items() if deps <= done)
            out.append(ready)
            done |= set(ready)
            for k in ready:
                del remaining[k]
        return out
