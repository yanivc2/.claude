"""The execution plan, its lifecycle, and the transition rules that guard it.

The central invariant of the whole module lives here: **a plan may not reach
``EXECUTING`` from ``AWAITING_APPROVAL``.** It must pass through ``APPROVED``, and
that step requires a valid, recorded :class:`~.approval.ApprovalDecision`. The §2
apparatus enforced the same separation between "the design is fundable" (the Gate-1
anchor) and "this specific call may be sent" (a separately minted execution grant),
after concluding that one artifact doing both jobs is what lets spend start by
accident.

Nothing here executes anything. ``can_transition`` is a pure predicate over states.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .estimates import CostEstimate, EstimatorVersion, TimeEstimateRange, TokenEstimateRange
from .money import Money
from .scope import EstimateAssumptions, StageKind


class ExecutionMode(str, Enum):
    """How a plan proposes to get the work done.

    The first three are required of every estimator: the user must always be able to
    compare "the engine does it all", "you do some of it", and "we spend less". The
    remainder are declared so a later estimator can offer them without a contract
    change; P0 implements none of them.
    """

    AUTOMATIC = "automatic"
    HUMAN_ASSISTED = "human_assisted"
    LOW_COST = "low_cost"

    FASTEST = "fastest"
    HIGHEST_QUALITY = "highest_quality"
    HIGHEST_CONFIDENCE = "highest_confidence"
    LOCAL_ONLY = "local_only"


#: Modes an estimator must always be able to offer.
REQUIRED_EXECUTION_MODES: frozenset[ExecutionMode] = frozenset({
    ExecutionMode.AUTOMATIC,
    ExecutionMode.HUMAN_ASSISTED,
    ExecutionMode.LOW_COST,
})


class StopConditionKind(str, Enum):
    BUDGET_EXCEEDED = "budget_exceeded"
    TIME_EXCEEDED = "time_exceeded"
    ROUNDS_EXHAUSTED = "rounds_exhausted"
    VERIFICATION_FAILED = "verification_failed"
    USER_CANCELLED = "user_cancelled"
    APPROVAL_EXPIRED = "approval_expired"
    PLAN_CHANGED = "plan_changed"
    EXTERNAL_DEPENDENCY = "external_dependency"


class StopCondition(BaseModel):
    """A pre-declared reason the run must halt. Approved together with the plan."""

    model_config = ConfigDict(frozen=True)

    kind: StopConditionKind
    description: str
    #: Whether hitting this halts outright or pauses for a decision.
    halts: bool = True


class PlanStatus(str, Enum):
    DRAFT = "DRAFT"
    AWAITING_SCOPE_CONFIRMATION = "AWAITING_SCOPE_CONFIRMATION"
    READY_FOR_ESTIMATE = "READY_FOR_ESTIMATE"
    ESTIMATED = "ESTIMATED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    EXECUTING = "EXECUTING"
    PAUSED_BUDGET = "PAUSED_BUDGET"
    PAUSED_USER_INPUT = "PAUSED_USER_INPUT"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL_STATUSES: frozenset[PlanStatus] = frozenset({
    PlanStatus.COMPLETED, PlanStatus.FAILED, PlanStatus.CANCELLED,
})

#: The complete transition table. Anything absent is forbidden — note especially that
#: AWAITING_APPROVAL does NOT reach EXECUTING, and that APPROVED falls back to
#: ESTIMATED when the plan changes underneath it (re-approval required).
ALLOWED_TRANSITIONS: dict[PlanStatus, frozenset[PlanStatus]] = {
    PlanStatus.DRAFT: frozenset({
        PlanStatus.AWAITING_SCOPE_CONFIRMATION, PlanStatus.CANCELLED,
    }),
    PlanStatus.AWAITING_SCOPE_CONFIRMATION: frozenset({
        PlanStatus.READY_FOR_ESTIMATE, PlanStatus.DRAFT, PlanStatus.CANCELLED,
    }),
    PlanStatus.READY_FOR_ESTIMATE: frozenset({
        PlanStatus.ESTIMATED, PlanStatus.DRAFT, PlanStatus.CANCELLED,
    }),
    PlanStatus.ESTIMATED: frozenset({
        PlanStatus.AWAITING_APPROVAL, PlanStatus.READY_FOR_ESTIMATE, PlanStatus.CANCELLED,
    }),
    PlanStatus.AWAITING_APPROVAL: frozenset({
        PlanStatus.APPROVED, PlanStatus.REJECTED, PlanStatus.CANCELLED,
    }),
    PlanStatus.APPROVED: frozenset({
        PlanStatus.EXECUTING, PlanStatus.ESTIMATED, PlanStatus.CANCELLED,
    }),
    PlanStatus.REJECTED: frozenset({
        PlanStatus.DRAFT, PlanStatus.CANCELLED,
    }),
    PlanStatus.EXECUTING: frozenset({
        PlanStatus.PAUSED_BUDGET, PlanStatus.PAUSED_USER_INPUT,
        PlanStatus.COMPLETED, PlanStatus.FAILED, PlanStatus.CANCELLED,
    }),
    PlanStatus.PAUSED_BUDGET: frozenset({
        PlanStatus.AWAITING_APPROVAL,   # an over-cap continuation needs fresh approval
        PlanStatus.FAILED, PlanStatus.CANCELLED,
    }),
    PlanStatus.PAUSED_USER_INPUT: frozenset({
        PlanStatus.EXECUTING, PlanStatus.FAILED, PlanStatus.CANCELLED,
    }),
    PlanStatus.COMPLETED: frozenset(),
    PlanStatus.FAILED: frozenset(),
    PlanStatus.CANCELLED: frozenset(),
}


def can_transition(src: PlanStatus, dst: PlanStatus) -> bool:
    """Pure predicate: is ``src -> dst`` a legal move?"""
    return dst in ALLOWED_TRANSITIONS[src]


def assert_transition(src: PlanStatus, dst: PlanStatus) -> None:
    """Raise :class:`~.errors.IllegalTransitionError` if the move is not permitted."""
    from .errors import IllegalTransitionError

    if not can_transition(src, dst):
        raise IllegalTransitionError(src.value, dst.value)


def requires_approval_record(src: PlanStatus, dst: PlanStatus) -> bool:
    """Which legal transition additionally demands a valid ApprovalDecision.

    Only one does. Naming it here keeps the rule in the contract rather than in
    whichever caller happens to drive the machine.
    """
    return src is PlanStatus.APPROVED and dst is PlanStatus.EXECUTING


class StageEstimate(BaseModel):
    """One stage of the breakdown with its estimates attached."""

    model_config = ConfigDict(frozen=True)

    item_id: str
    kind: StageKind
    depends_on: list[str] = Field(default_factory=list)
    tokens: TokenEstimateRange
    cost: CostEstimate
    duration: TimeEstimateRange
    blocking: bool = True
    parallelizable: bool = True
    #: What this stage would cost the user in their own time under HUMAN_ASSISTED.
    human_minutes: int = 0


class ExecutionPlan(BaseModel):
    """A costed, reviewable proposal for doing the work one particular way.

    One scope yields several plans — one per :class:`ExecutionMode` — and the user
    approves exactly one. ``plan_hash`` binds an approval to the plan it was granted
    against, so an edited plan cannot inherit an old approval.
    """

    model_config = ConfigDict(frozen=True)

    plan_id: str
    scope_id: str
    mode: ExecutionMode
    plan_version: int = 1
    status: PlanStatus = PlanStatus.DRAFT

    stages: list[StageEstimate]
    total_cost: CostEstimate
    total_duration: TimeEstimateRange
    assumptions: EstimateAssumptions
    estimator: EstimatorVersion

    #: Registry model ids this plan intends to use.
    model_ids: list[str] = Field(default_factory=list)
    stop_conditions: list[StopCondition] = Field(default_factory=list)
    #: What this plan deliberately does not deliver. Users judge a quote by this.
    exclusions: list[str] = Field(default_factory=list)
    #: For HUMAN_ASSISTED: what the user must do, and what it saves.
    human_tasks: list[str] = Field(default_factory=list)
    #: What is given up relative to AUTOMATIC. Required for LOW_COST — a cheaper plan
    #: that does not say what it sacrifices is not a comparison, it is a sales pitch.
    tradeoffs: list[str] = Field(default_factory=list)

    #: Content hash over the semantic plan. Approvals bind to it.
    plan_hash: str = ""

    @model_validator(mode="after")
    def _well_formed(self) -> "ExecutionPlan":
        if not self.stages:
            raise ValueError("ExecutionPlan must contain at least one stage")
        ids = [s.item_id for s in self.stages]
        if len(ids) != len(set(ids)):
            raise ValueError("StageEstimate item_ids must be unique within a plan")
        known = set(ids)
        for stage in self.stages:
            unknown = set(stage.depends_on) - known
            if unknown:
                raise ValueError(f"stage {stage.item_id!r} depends on unknown: {sorted(unknown)}")
        if self.plan_version < 1:
            raise ValueError("plan_version starts at 1")
        if self.mode is ExecutionMode.LOW_COST and not self.tradeoffs:
            raise ValueError("a LOW_COST plan must state what it gives up")
        if self.mode is ExecutionMode.HUMAN_ASSISTED and not self.human_tasks:
            raise ValueError("a HUMAN_ASSISTED plan must state what the user has to do")
        if self.total_cost.range.currency != self.stages[0].cost.range.currency:
            raise ValueError("plan total and stage costs must share one currency")
        return self

    @property
    def expected_cost(self) -> Money:
        return self.total_cost.expected

    @property
    def worst_reasonable_cost(self) -> Money:
        return self.total_cost.worst_reasonable

    def total_human_minutes(self) -> int:
        return sum(s.human_minutes for s in self.stages)

    def blocking_stages(self) -> list[str]:
        return [s.item_id for s in self.stages if s.blocking]
