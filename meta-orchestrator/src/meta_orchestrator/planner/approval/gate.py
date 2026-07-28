"""The approval gate — turning a costed plan into a decision, and a decision into
permission.

Two things it enforces that nothing else can:

* **Nothing executes without a record that covers the exact run.** Same plan, same
  version, same hash, same mode, projection still inside the approved cap, not expired.
  ``authorise`` fails closed on every one of those.
* **Editing an approved plan withdraws its approval.** Not by policy — by construction.
  The approval binds to a plan hash, so a changed plan simply is not covered, and the
  gate can mark the old decision superseded rather than letting it drift.

The §2 apparatus made the same split: a Gate-1 anchor proved the design was fundable,
and a separately minted execution grant permitted one specific call. One artifact doing
both jobs is how spend starts by accident.

The gate decides and records. It does not execute, and is not wired to the orchestrator.
"""
from __future__ import annotations

from typing import Optional

from ..contracts.approval import (
    ApprovalDecision,
    ApprovalRequest,
    ApprovalStatus,
    ApproverKind,
    assert_may_execute,
)
from ..contracts.money import Money
from ..contracts.plan import (
    ExecutionMode,
    ExecutionPlan,
    PlanStatus,
    assert_transition,
    requires_approval_record,
)
from ..estimation.projection import ModelCostProjection
from .errors import DecisionMismatchError, UnknownApprovalRequestError
from .store import ApprovalLog


class ApprovalGate:
    """Implements the ``ApprovalGate`` port over an append-only :class:`ApprovalLog`.

    Immutable in the same way the ledger is: every operation returns a new gate, so
    the history cannot be edited by holding a reference to an old one.
    """

    def __init__(self, log: Optional[ApprovalLog] = None) -> None:
        self._log = log or ApprovalLog()

    @property
    def log(self) -> ApprovalLog:
        return self._log

    # --- presenting ---
    def present(self, plan: ExecutionPlan, projection: ModelCostProjection, *,
                request_id: str, proposed_cap: Money,
                alternatives: Optional[list[ExecutionPlan]] = None,
                risks: Optional[list[str]] = None,
                expected_duration_ms: int = 0, worst_duration_ms: int = 0,
                requires_further_approval: Optional[list[str]] = None,
                ) -> tuple["ApprovalGate", ApprovalRequest]:
        """Build the quote a person actually decides on.

        The cost figures come from the *projection*, not from the plan's own estimate,
        so what is approved is what was priced. Alternatives are carried through
        because an approval offered without one is not really a choice.
        """
        if not projection.available or projection.range is None:
            raise DecisionMismatchError(
                f"cannot present plan {plan.plan_id!r}: no price is available for "
                f"{projection.model_id!r} ({projection.unavailable_reason})")

        warnings = list(projection.warnings)
        if not projection.authoritative_for_real_spend:
            warnings.append(
                "the price behind this request cannot back a real budget")

        request = ApprovalRequest(
            request_id=request_id,
            plan_id=plan.plan_id,
            plan_version=plan.plan_version,
            plan_hash=plan.plan_hash,
            summary=f"{plan.mode.value} plan over {len(plan.stages)} stage(s)",
            deliverables=list(plan.exclusions and [] or []),
            mode=plan.mode,
            model_ids=list(plan.model_ids),
            expected_cost=projection.range.expected,
            worst_reasonable_cost=projection.range.worst,
            proposed_cap=proposed_cap,
            expected_duration_ms=expected_duration_ms,
            worst_duration_ms=worst_duration_ms,
            confidence_basis=plan.total_cost.confidence.basis,
            risks=(risks or []) + warnings,
            exclusions=list(plan.exclusions),
            stop_conditions=list(plan.stop_conditions),
            requires_further_approval=list(requires_further_approval or []),
            alternative_plan_ids=[p.plan_id for p in (alternatives or [])],
        )
        return ApprovalGate(self._log.with_request(request)), request

    # --- recording ---
    def record(self, decision: ApprovalDecision) -> "ApprovalGate":
        """Append a decision, checking it actually answers its request."""
        try:
            request = self._log.request(decision.request_id)
        except UnknownApprovalRequestError:
            raise
        if decision.plan_id != request.plan_id:
            raise DecisionMismatchError(
                f"decision names plan {decision.plan_id!r}, request was for "
                f"{request.plan_id!r}")
        if decision.plan_hash != request.plan_hash:
            raise DecisionMismatchError(
                "decision binds to a different plan hash than the request described")
        if decision.plan_version != request.plan_version:
            raise DecisionMismatchError(
                f"decision is for version {decision.plan_version}, request was for "
                f"{request.plan_version}")
        if (decision.status is ApprovalStatus.APPROVED
                and decision.approved_cap < request.expected_cost):
            raise DecisionMismatchError(
                f"approved cap {decision.approved_cap} is below the expected cost "
                f"{request.expected_cost} — approving this guarantees a mid-run halt")
        return ApprovalGate(self._log.with_decision(decision))

    def supersede(self, plan_id: str, *, reason: str, at: str,
                  by: str) -> "ApprovalGate":
        """Withdraw live approvals for a plan, by appending supersession records.

        Called when a plan is re-estimated or edited. The old records stay readable.
        """
        return ApprovalGate(self._log.with_superseded(plan_id, reason=reason, at=at,
                                                      by=by))

    # --- reading ---
    def effective_decision(self, plan_id: str, *,
                           now: Optional[str] = None) -> Optional[ApprovalDecision]:
        return self._log.effective_for(plan_id, now=now)

    # --- the gate itself ---
    def authorise(self, plan: ExecutionPlan, projection: ModelCostProjection, *,
                  now: Optional[str] = None) -> ApprovalDecision:
        """Permit this exact run, or raise.

        Fails closed at every step: no decision on record, a decision that does not
        cover this plan/version/hash/mode, a projection that has grown past the
        approved cap, or an expired approval.
        """
        if not projection.available or projection.range is None:
            from ..contracts.errors import ApprovalRequiredError

            raise ApprovalRequiredError(
                plan.plan_id,
                f"cannot authorise without a price ({projection.unavailable_reason})")

        decision = self.effective_decision(plan.plan_id, now=now)
        assert_may_execute(
            decision, plan_id=plan.plan_id, plan_version=plan.plan_version,
            plan_hash=plan.plan_hash, mode=plan.mode,
            projected_cost=projection.range.worst, now=now)
        assert decision is not None       # assert_may_execute would have raised
        return decision

    def may_transition(self, plan: ExecutionPlan, src: PlanStatus, dst: PlanStatus,
                       projection: ModelCostProjection, *,
                       now: Optional[str] = None) -> None:
        """Check a lifecycle move, including the approval it may additionally need.

        The transition table alone forbids ``AWAITING_APPROVAL -> EXECUTING``. This
        adds the second half: ``APPROVED -> EXECUTING`` also needs a decision that
        covers the run, which the table cannot express on its own.
        """
        assert_transition(src, dst)
        if requires_approval_record(src, dst):
            self.authorise(plan, projection, now=now)


def approve(request: ApprovalRequest, *, decision_id: str, approved_by: str,
            decided_at: str, approved_cap: Money,
            estimator_ref: str, valid_until: Optional[str] = None,
            approver_kind: ApproverKind = ApproverKind.HUMAN,
            mode: Optional[ExecutionMode] = None) -> ApprovalDecision:
    """Build an APPROVED decision that answers ``request``. Convenience, not policy."""
    return ApprovalDecision(
        decision_id=decision_id, request_id=request.request_id,
        plan_id=request.plan_id, plan_version=request.plan_version,
        plan_hash=request.plan_hash, estimator_ref=estimator_ref,
        status=ApprovalStatus.APPROVED, approver_kind=approver_kind,
        approved_by=approved_by, decided_at=decided_at, valid_until=valid_until,
        approved_cap=approved_cap, approved_mode=mode or request.mode,
        stop_conditions=list(request.stop_conditions))


def reject(request: ApprovalRequest, *, decision_id: str, approved_by: str,
           decided_at: str, reason: str, estimator_ref: str) -> ApprovalDecision:
    """Build a REJECTED decision. A rejection must say why — the contract enforces it."""
    return ApprovalDecision(
        decision_id=decision_id, request_id=request.request_id,
        plan_id=request.plan_id, plan_version=request.plan_version,
        plan_hash=request.plan_hash, estimator_ref=estimator_ref,
        status=ApprovalStatus.REJECTED, approved_by=approved_by,
        decided_at=decided_at, approved_cap=Money.zero(request.proposed_cap.currency),
        approved_mode=request.mode, reason=reason)
