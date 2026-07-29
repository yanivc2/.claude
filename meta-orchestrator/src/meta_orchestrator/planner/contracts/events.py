"""Event contracts — the append-only record of what the Planner decided and when.

Events are evidence, not messaging. They exist so that a spend, an approval or a halt
can be reconstructed afterwards by someone who was not there; §2's append-only event
log is the precedent, and its closeout is the argument for it.

Two invariants ride on these types:

* ``execution.started`` is only ever legitimate after an ``approval.granted`` carrying
  the same ``plan_id``, ``plan_version`` and ``plan_hash``.
* ``budget.threshold.crossed`` fires once per threshold per plan. A threshold that
  re-fires is noise, and noise is how a real warning gets ignored.

No dispatcher is defined here. P0 fixes the shapes; delivery is P1.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from .actuals import ActualUsage, EstimateVariance
from .money import Money
from .plan import ExecutionMode


class EventType(str, Enum):
    SCOPE_DEFINED = "scope.defined"
    SCOPE_CLARIFICATION_NEEDED = "scope.clarification.needed"

    PLAN_ESTIMATED = "plan.estimated"
    PLAN_ROUTES_GENERATED = "plan.routes.generated"
    PLAN_REJECTED_BUDGET = "plan.rejected.budget"

    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_GRANTED = "approval.granted"
    APPROVAL_DENIED = "approval.denied"
    APPROVAL_SUPERSEDED = "approval.superseded"

    BUDGET_THRESHOLD_CROSSED = "budget.threshold.crossed"
    BUDGET_EXCEEDED = "budget.exceeded"
    BUDGET_OVERRIDE_GRANTED = "budget.override.granted"

    EXECUTION_STARTED = "execution.started"
    EXECUTION_PAUSED = "execution.paused"
    EXECUTION_FINISHED = "execution.finished"

    USAGE_RECORDED = "usage.recorded"
    VARIANCE_COMPUTED = "variance.computed"
    PRICING_DRIFT_DETECTED = "pricing.drift.detected"


class PlannerEvent(BaseModel):
    """Common envelope. ``correlation_id`` matches the orchestrator's tracing field."""

    model_config = ConfigDict(frozen=True)

    event_type: EventType
    occurred_at: str                    # ISO-8601
    correlation_id: str = ""
    plan_id: str = ""
    scope_id: str = ""
    payload: dict = Field(default_factory=dict)


class PlanEstimatedEvent(BaseModel):
    """Emitted once per costed plan. Carries the provenance to reproduce the figure."""

    model_config = ConfigDict(frozen=True)

    plan_id: str
    scope_id: str
    mode: ExecutionMode
    plan_version: int
    plan_hash: str
    expected_cost: Money
    worst_reasonable_cost: Money
    estimator_ref: str
    pricing_ref: str
    occurred_at: str


class ApprovalGrantedEvent(BaseModel):
    """The event ``execution.started`` must be able to point back to."""

    model_config = ConfigDict(frozen=True)

    plan_id: str
    plan_version: int
    plan_hash: str
    decision_id: str
    approved_by: str
    approved_cap: Money
    approved_mode: ExecutionMode
    occurred_at: str


class ExecutionStartedEvent(BaseModel):
    """Illegitimate without a matching :class:`ApprovalGrantedEvent`.

    ``authorising_decision_id`` is required precisely so that the link is a stored
    fact rather than an assumption made while reading the log.
    """

    model_config = ConfigDict(frozen=True)

    plan_id: str
    plan_version: int
    plan_hash: str
    authorising_decision_id: str
    occurred_at: str


class BudgetThresholdCrossedEvent(BaseModel):
    """One threshold, once."""

    model_config = ConfigDict(frozen=True)

    plan_id: str
    threshold: Decimal
    encumbered: Money
    cap: Money
    occurred_at: str


class UsageRecordedEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    plan_id: str
    usage: ActualUsage
    occurred_at: str


class VarianceComputedEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    plan_id: str
    variance: EstimateVariance
    occurred_at: str


def approval_covers_execution(granted: ApprovalGrantedEvent,
                              started: ExecutionStartedEvent) -> bool:
    """Whether a started execution is backed by the approval it names.

    The audit-side counterpart to ``approval.assert_may_execute``: that one blocks a
    run before it happens, this one detects a log that cannot justify one that did.
    """
    return (started.authorising_decision_id == granted.decision_id
            and started.plan_id == granted.plan_id
            and started.plan_version == granted.plan_version
            and started.plan_hash == granted.plan_hash)
