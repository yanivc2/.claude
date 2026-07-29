"""The governed approval gate — from admission to a scoped, bindable authorization.

Adds to the P1c gate the things an approval actually has to carry:

* **Full binding.** An approval names the plan, estimate, projection, price card,
  policy, budget snapshot, admission, purpose, mode and reserve policy it was granted
  against. Any one of them changing means it no longer describes what is about to
  happen, and ``diff`` reports *which*.
* **Acknowledgements.** Acknowledgeable risks must be signed for by name; blocking
  conditions cannot be signed away at all.
* **Stale-state refusal.** The budget snapshot at authorization is compared with the
  one that was approved. Different hash, no authorization. This is *logical* protection
  — it detects that state moved, and does not serialise concurrent writers.
* **A separate artifact.** Authorization yields an ``ExecutionAuthorization``, not a
  decision id: a scoped grant naming the model, mode, ceilings, amount and window an
  executor may work within.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.money import Money
from ..contracts.plan import ExecutionPlan, StopCondition
from ..estimation.entities import UsageEstimate
from ..estimation.projection import ModelCostProjection
from .admission import GovernedAdmission
from .authorization import ExecutionAuthorization, UsageCeiling
from .binding import ApprovalBinding
from .canonical import CanonicalMixin
from .conditions import Acknowledgement, ConditionCode, ConditionSet
from .errors import (
    BlockedByConditionError,
    MissingAcknowledgementError,
    StaleSnapshotError,
)
from .events import GovernanceEvent, GovernanceEventLog, GovernanceEventType
from .purpose import SpendPurpose, eligibility_markers
from .snapshots import BudgetSnapshot, PlanSnapshot


class GovernedApprovalRequest(BaseModel, CanonicalMixin):
    """What a person decides on, with every identity it is tied to."""

    model_config = ConfigDict(frozen=True)

    request_id: str
    purpose: SpendPurpose
    binding: ApprovalBinding
    plan_id: str
    plan_version: int
    summary: str
    deliverables: list[str] = Field(default_factory=list)
    produces_no_artifact: bool = False

    expected_cost: Money
    worst_reasonable_cost: Money
    reserve_amount: Money
    proposed_commitment: Money
    currency: str

    conditions: ConditionSet = ConditionSet()
    stop_conditions: list[StopCondition] = Field(default_factory=list)
    alternative_plan_ids: list[str] = Field(default_factory=list)
    markers: list[str] = Field(default_factory=list)

    @property
    def required_acknowledgements(self) -> list[ConditionCode]:
        return [c.code for c in self.conditions.acknowledgeable]

    @property
    def is_complete(self) -> bool:
        """False when the request cannot honestly be decided on as it stands."""
        return bool(self.deliverables) or self.produces_no_artifact

    def canonical_payload(self) -> dict:
        return {
            "request_id": self.request_id,
            "purpose": self.purpose.value,
            "binding": self.binding.canonical_payload(),
            "plan_id": self.plan_id,
            "plan_version": self.plan_version,
            "summary": self.summary,
            "deliverables": list(self.deliverables),
            "produces_no_artifact": self.produces_no_artifact,
            "expected_cost": self.expected_cost,
            "worst_reasonable_cost": self.worst_reasonable_cost,
            "reserve_amount": self.reserve_amount,
            "proposed_commitment": self.proposed_commitment,
            "currency": self.currency,
            "conditions": self.conditions.canonical_payload(),
            "stop_conditions": sorted(f"{c.kind.value}:{c.description}"
                                      for c in self.stop_conditions),
            "alternative_plan_ids": sorted(self.alternative_plan_ids),
            "markers": sorted(self.markers),
        }


class GovernedApproval(BaseModel, CanonicalMixin):
    """A recorded decision: who said yes, to exactly what, having accepted what."""

    model_config = ConfigDict(frozen=True)

    decision_id: str
    request_id: str
    approved: bool
    approved_by: str
    decided_at: str
    binding: ApprovalBinding
    approved_commitment: Money
    acknowledgements: list[Acknowledgement] = Field(default_factory=list)
    valid_until: Optional[str] = None
    reason: str = ""
    markers: list[str] = Field(default_factory=list)

    def canonical_payload(self) -> dict:
        return {
            "decision_id": self.decision_id,
            "request_id": self.request_id,
            "approved": self.approved,
            "approved_by": self.approved_by,
            "decided_at": self.decided_at,
            "binding": self.binding.canonical_payload(),
            "approved_commitment": self.approved_commitment,
            "acknowledgements": [a.canonical_payload() for a in
                                 sorted(self.acknowledgements,
                                        key=lambda a: a.code.value)],
            "valid_until": self.valid_until,
            "reason": self.reason,
            "markers": sorted(self.markers),
        }


def build_binding(*, admission: GovernedAdmission, plan: PlanSnapshot,
                  estimate: UsageEstimate, projection: ModelCostProjection,
                  snapshot: BudgetSnapshot, pricing_catalog_version: str,
                  reserve_policy_hash: str) -> ApprovalBinding:
    """Collect every identity an approval is granted against."""
    expected = projection.expected_quote
    if expected is None:
        raise BlockedByConditionError(
            [ConditionCode.WORST_COST_UNAVAILABLE.value],
            "cannot bind an approval without a priced projection")
    return ApprovalBinding(
        plan_hash=plan.content_hash(),
        plan_version=plan.plan_version,
        estimate_audit_hash=estimate.audit_hash(),
        estimator_version=estimate.estimator_version,
        ruleset_version=estimate.ruleset_version,
        projection_hash=admission.content_hash(),
        price_card_id=expected.card_id,
        price_card_content_hash=expected.card_content_hash,
        pricing_catalog_version=pricing_catalog_version,
        budget_policy_hash=snapshot.policy_hash,
        budget_snapshot_hash=snapshot.content_hash(),
        admission_hash=admission.content_hash(),
        purpose=admission.purpose,
        execution_mode=plan.mode,
        reserve_policy_hash=reserve_policy_hash,
        approved_commitment=str(admission.requested.total.amount),
    )


class GovernedApprovalGate:
    """Presents, records and authorises. Immutable — every call returns a new gate."""

    def __init__(self, requests: Optional[list[GovernedApprovalRequest]] = None,
                 decisions: Optional[list[GovernedApproval]] = None,
                 events: Optional[GovernanceEventLog] = None) -> None:
        self._requests = list(requests or [])
        self._decisions = list(decisions or [])
        self._events = events or GovernanceEventLog()

    @property
    def events(self) -> GovernanceEventLog:
        return self._events

    @property
    def decisions(self) -> list[GovernedApproval]:
        return list(self._decisions)

    def _with(self, *, requests=None, decisions=None,
              events=None) -> "GovernedApprovalGate":
        return GovernedApprovalGate(
            requests if requests is not None else self._requests,
            decisions if decisions is not None else self._decisions,
            events if events is not None else self._events)

    def request(self, request_id: str) -> GovernedApprovalRequest:
        for r in self._requests:
            if r.request_id == request_id:
                return r
        raise KeyError(request_id)

    def decision_for(self, request_id: str) -> Optional[GovernedApproval]:
        for d in reversed(self._decisions):
            if d.request_id == request_id:
                return d
        return None

    # --- present ---
    def present(self, *, request_id: str, admission: GovernedAdmission,
                plan: ExecutionPlan, plan_snapshot: PlanSnapshot,
                estimate: UsageEstimate, projection: ModelCostProjection,
                snapshot: BudgetSnapshot, pricing_catalog_version: str,
                reserve_policy_hash: str, occurred_at: str,
                alternatives: Optional[list[str]] = None
                ) -> tuple["GovernedApprovalGate", GovernedApprovalRequest]:
        """Build the quote a person decides on. Blocking conditions are carried, not hidden."""
        if projection.range is None:
            raise BlockedByConditionError(
                [ConditionCode.WORST_COST_UNAVAILABLE.value],
                "cannot present an unpriced plan")

        binding = build_binding(
            admission=admission, plan=plan_snapshot, estimate=estimate,
            projection=projection, snapshot=snapshot,
            pricing_catalog_version=pricing_catalog_version,
            reserve_policy_hash=reserve_policy_hash)

        request = GovernedApprovalRequest(
            request_id=request_id, purpose=admission.purpose, binding=binding,
            plan_id=plan.plan_id, plan_version=plan.plan_version,
            summary=(f"{plan.mode.value} plan over {len(plan.stages)} stage(s) "
                     f"for {admission.purpose.value}"),
            deliverables=list(plan.deliverables),
            produces_no_artifact=plan.produces_no_artifact,
            expected_cost=projection.range.expected,
            worst_reasonable_cost=projection.range.worst,
            reserve_amount=admission.requested.reserve,
            proposed_commitment=admission.requested.total,
            currency=admission.currency,
            conditions=admission.conditions,
            stop_conditions=list(plan.stop_conditions),
            alternative_plan_ids=list(alternatives or []),
            markers=eligibility_markers(admission.purpose))

        event = GovernanceEvent(
            event_type=GovernanceEventType.APPROVAL_REQUESTED,
            occurred_at=occurred_at, purpose=admission.purpose,
            plan_id=plan.plan_id, budget_id=snapshot.budget_id,
            subject_hashes={"admission_hash": admission.content_hash(),
                            "plan_hash": plan_snapshot.content_hash(),
                            "budget_snapshot_hash": snapshot.content_hash()},
            amount=admission.requested.total,
            condition_codes=[c.code.value for c in admission.conditions.conditions],
            markers=request.markers)
        return (self._with(requests=[*self._requests, request],
                           events=self._events.append(event)), request)

    # --- decide ---
    def approve(self, *, request: GovernedApprovalRequest, decision_id: str,
                approved_by: str, decided_at: str,
                acknowledgements: Optional[list[Acknowledgement]] = None,
                valid_until: Optional[str] = None
                ) -> tuple["GovernedApprovalGate", GovernedApproval]:
        """Record a yes. Refuses if anything blocking stands or an ack is missing."""
        given = list(acknowledgements or [])

        if request.conditions.blocking:
            raise BlockedByConditionError(
                [c.code.value for c in request.conditions.blocking],
                "these cannot be acknowledged away; they have to be resolved")

        missing = request.conditions.missing_acknowledgements(given)
        if missing:
            raise MissingAcknowledgementError([c.value for c in missing])

        if request.purpose.is_real and not request.is_complete:
            raise BlockedByConditionError(
                [ConditionCode.MISSING_DELIVERABLES.value],
                "a real-spend approval needs deliverables, or an explicit statement "
                "that the plan produces no artifact")

        if not approved_by.strip():
            raise ValueError("an approval must name who decided")

        decision = GovernedApproval(
            decision_id=decision_id, request_id=request.request_id, approved=True,
            approved_by=approved_by, decided_at=decided_at, binding=request.binding,
            approved_commitment=request.proposed_commitment,
            acknowledgements=given, valid_until=valid_until,
            markers=list(request.markers))
        event = GovernanceEvent(
            event_type=GovernanceEventType.APPROVAL_GRANTED,
            occurred_at=decided_at, purpose=request.purpose, plan_id=request.plan_id,
            actor=approved_by,
            subject_hashes={"binding_hash": request.binding.content_hash(),
                            "decision_hash": decision.content_hash()},
            amount=request.proposed_commitment, markers=decision.markers)
        return (self._with(decisions=[*self._decisions, decision],
                           events=self._events.append(event)), decision)

    def reject(self, *, request: GovernedApprovalRequest, decision_id: str,
               approved_by: str, decided_at: str, reason: str
               ) -> tuple["GovernedApprovalGate", GovernedApproval]:
        if not reason.strip():
            raise ValueError("a rejection must record why")
        decision = GovernedApproval(
            decision_id=decision_id, request_id=request.request_id, approved=False,
            approved_by=approved_by, decided_at=decided_at, binding=request.binding,
            approved_commitment=Money.zero(request.currency), reason=reason,
            markers=list(request.markers))
        event = GovernanceEvent(
            event_type=GovernanceEventType.APPROVAL_REJECTED,
            occurred_at=decided_at, purpose=request.purpose, plan_id=request.plan_id,
            actor=approved_by, detail=reason,
            subject_hashes={"decision_hash": decision.content_hash()})
        return (self._with(decisions=[*self._decisions, decision],
                           events=self._events.append(event)), decision)

    # --- authorise ---
    def authorise(self, *, decision: GovernedApproval,
                  current_snapshot: BudgetSnapshot,
                  current_binding: ApprovalBinding,
                  authorization_id: str, purpose: SpendPurpose,
                  plan: ExecutionPlan, projection: ModelCostProjection,
                  reserve_amount: Money, usage_ceiling: UsageCeiling,
                  valid_from: str, expires_at: Optional[str] = None,
                  issued_by: str = "") -> tuple["GovernedApprovalGate",
                                                ExecutionAuthorization]:
        """Issue a scoped grant, or refuse and say precisely why."""
        if not decision.approved:
            raise BlockedByConditionError(
                ["approval_not_granted"], f"decision {decision.decision_id!r} was a no")

        # Stale-state: the budget must not have moved since approval.
        current_hash = current_snapshot.content_hash()
        if decision.binding.budget_snapshot_hash != current_hash:
            self._refuse(purpose, plan.plan_id, valid_from,
                         ConditionCode.STALE_BUDGET_SNAPSHOT)
            raise StaleSnapshotError(decision.binding.budget_snapshot_hash,
                                     current_hash)

        # Everything else the approval was granted against.
        decision.binding.assert_covers(current_binding)

        authorization = ExecutionAuthorization(
            authorization_id=authorization_id, purpose=purpose,
            binding=decision.binding,
            plan_id=plan.plan_id, plan_version=plan.plan_version,
            approval_decision_id=decision.decision_id,
            admission_id=decision.binding.admission_hash,
            budget_snapshot_hash=current_hash,
            approved_commitment=decision.approved_commitment,
            reserve_amount=reserve_amount,
            currency=decision.approved_commitment.currency,
            permitted_provider=projection.expected_quote.provider,   # type: ignore[union-attr]
            permitted_model_id=projection.model_id,
            permitted_mode=plan.mode,
            usage_ceiling=usage_ceiling,
            stop_conditions=list(plan.stop_conditions),
            valid_from=valid_from, expires_at=expires_at,
            acknowledgements=list(decision.acknowledgements),
            markers=eligibility_markers(purpose), issued_by=issued_by)

        event = GovernanceEvent(
            event_type=GovernanceEventType.AUTHORIZATION_ISSUED,
            occurred_at=valid_from, purpose=purpose, plan_id=plan.plan_id,
            actor=issued_by,
            subject_hashes={"authorization_hash": authorization.content_hash(),
                            "budget_snapshot_hash": current_hash},
            amount=decision.approved_commitment, markers=authorization.markers)
        return self._with(events=self._events.append(event)), authorization

    def _refuse(self, purpose: SpendPurpose, plan_id: str, at: str,
                code: ConditionCode) -> None:
        """Record a refusal. Kept side-effecting on the log only, never on a decision."""
        self._events = self._events.append(GovernanceEvent(
            event_type=GovernanceEventType.AUTHORIZATION_REFUSED,
            occurred_at=at, purpose=purpose, plan_id=plan_id,
            condition_codes=[code.value]))
