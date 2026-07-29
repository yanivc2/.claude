"""Approval contracts — the record that makes execution legitimate.

An :class:`ApprovalDecision` is append-only evidence, not mutable state. It binds to a
specific plan *version* and *hash*, a specific estimate, a specific cap and a specific
execution mode; if any of those change the approval no longer applies and must be
sought again. ``covers()`` is where that rule lives, so no caller has to remember it.

This module defines the rule. It does not wire it to the orchestrator — that is P1.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .money import Money
from .plan import ExecutionMode, StopCondition


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    REVOKED = "revoked"
    SUPERSEDED = "superseded"   # the plan changed underneath it


class ApproverKind(str, Enum):
    HUMAN = "human"
    #: An automated approver is only ever legitimate below an operator-set threshold,
    #: and the record still has to say that is what happened.
    AUTOMATED_POLICY = "automated_policy"


class ApprovalRequest(BaseModel):
    """What the user is shown before deciding. The quote, in full.

    Everything a reasonable person needs in order to say yes or no — including what is
    *not* included, which is the field most often omitted and most often disputed.
    """

    model_config = ConfigDict(frozen=True)

    request_id: str
    plan_id: str
    plan_version: int
    plan_hash: str

    summary: str
    deliverables: list[str] = Field(default_factory=list)
    mode: ExecutionMode
    model_ids: list[str] = Field(default_factory=list)

    expected_cost: Money
    worst_reasonable_cost: Money
    proposed_cap: Money
    expected_duration_ms: int
    worst_duration_ms: int

    confidence_basis: str
    risks: list[str] = Field(default_factory=list)
    exclusions: list[str] = Field(default_factory=list)
    stop_conditions: list[StopCondition] = Field(default_factory=list)
    #: Actions that will require a *further* approval even after this one is granted.
    requires_further_approval: list[str] = Field(default_factory=list)
    #: Other plans the user could pick instead. An approval with no alternative
    #: presented is a decision the user was not really given.
    alternative_plan_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _complete(self) -> "ApprovalRequest":
        if not self.summary.strip():
            raise ValueError("ApprovalRequest.summary must not be empty")
        if not self.plan_hash.strip():
            raise ValueError("an approval request must name the plan hash it describes")
        if self.worst_reasonable_cost < self.expected_cost:
            raise ValueError("worst reasonable cost cannot be below the expected cost")
        if self.proposed_cap < self.expected_cost:
            raise ValueError(
                "a cap below the expected cost would guarantee a mid-run halt — "
                "raise the cap or re-plan before asking for approval"
            )
        if self.worst_duration_ms < self.expected_duration_ms:
            raise ValueError("worst duration cannot be below the expected duration")
        return self


class ApprovalDecision(BaseModel):
    """The immutable answer. Never edited — a changed mind is a new record.

    ``covers()`` is the gate: it answers whether *this* decision authorises *this*
    plan, at this version and hash, under this cap and mode, right now.
    """

    model_config = ConfigDict(frozen=True)

    decision_id: str
    request_id: str
    plan_id: str
    #: Bound tightly: an approval is for one version of one plan, not for a plan "in
    #: general". Re-planning after approval invalidates it by construction.
    plan_version: int
    plan_hash: str
    estimator_ref: str

    status: ApprovalStatus
    approver_kind: ApproverKind = ApproverKind.HUMAN
    approved_by: str
    decided_at: str                     # ISO-8601
    #: When the approval stops being valid. ``None`` means it does not expire on its own.
    valid_until: str | None = None

    approved_cap: Money
    approved_mode: ExecutionMode
    stop_conditions: list[StopCondition] = Field(default_factory=list)
    #: Mandatory when the status is REJECTED or REVOKED.
    reason: str = ""

    @model_validator(mode="after")
    def _accountable(self) -> "ApprovalDecision":
        if not self.approved_by.strip():
            raise ValueError("an approval decision must name who decided")
        if not self.plan_hash.strip():
            raise ValueError("an approval decision must bind to a plan hash")
        if self.status in (ApprovalStatus.REJECTED, ApprovalStatus.REVOKED) \
                and not self.reason.strip():
            raise ValueError(f"a {self.status.value} decision must record why")
        if self.approved_cap.is_negative():
            raise ValueError("approved cap cannot be negative")
        return self

    def is_effective(self, *, now: str | None = None) -> bool:
        """Approved, not expired, not revoked or superseded.

        ``now`` is an ISO-8601 string; comparison is lexicographic, which is correct
        for that format. Time is injected rather than read so this stays a pure
        predicate and the tests stay deterministic.
        """
        if self.status is not ApprovalStatus.APPROVED:
            return False
        if self.valid_until is None:
            return True
        if now is None:
            raise ValueError("this decision expires — pass `now` to evaluate it")
        return now <= self.valid_until

    def covers(self, *, plan_id: str, plan_version: int, plan_hash: str,
               mode: ExecutionMode, projected_cost: Money,
               now: str | None = None) -> bool:
        """Whether this decision authorises the run about to start.

        Every clause is a way a real run drifts away from what was approved: a
        different plan, an edited plan, a re-costed plan, a different execution mode,
        or a projection that has grown past the approved cap.
        """
        return (
            self.is_effective(now=now)
            and self.plan_id == plan_id
            and self.plan_version == plan_version
            and self.plan_hash == plan_hash
            and self.approved_mode is mode
            and projected_cost <= self.approved_cap
        )


def assert_may_execute(decision: ApprovalDecision | None, *, plan_id: str,
                       plan_version: int, plan_hash: str, mode: ExecutionMode,
                       projected_cost: Money, now: str | None = None) -> None:
    """Fail closed unless a valid approval covers this exact run.

    The absent-decision case is deliberately first: no record means no permission, and
    the failure is loud rather than a default-allow.
    """
    from .errors import ApprovalRequiredError

    if decision is None:
        raise ApprovalRequiredError(plan_id, "no approval decision on record")
    if not decision.covers(plan_id=plan_id, plan_version=plan_version,
                           plan_hash=plan_hash, mode=mode,
                           projected_cost=projected_cost, now=now):
        raise ApprovalRequiredError(
            plan_id,
            f"approval {decision.decision_id!r} does not cover this run "
            f"(status={decision.status.value}, approved_mode={decision.approved_mode.value}, "
            f"approved_cap={decision.approved_cap})",
        )
