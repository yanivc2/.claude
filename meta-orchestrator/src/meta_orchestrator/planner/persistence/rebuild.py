"""Rebuilding domain artifacts from stored canonical payloads.

Every function here reconstructs through the artifact's **own constructor**, so domain
validation runs on the way back in. A payload that survived the hash check but no
longer satisfies the rules is refused, which is the whole point of rebuilding rather
than returning the dict.

One honest limitation, stated where it belongs: fields deliberately excluded from an
artifact's canonical payload are **not recovered**, because they were excluded for
being informational and volatile. `BudgetSnapshot.provider_credits` is the case — it is
operator-reported runtime state, kept out of the identity so it cannot invalidate
approvals, and therefore not part of what a restore restores. `taken_at` is recovered
from the row's own timestamp column rather than the payload.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from ..contracts.money import Money
from ..contracts.plan import ExecutionMode, StopCondition, StopConditionKind
from ..governance.authorization import ExecutionAuthorization, UsageCeiling
from ..governance.binding import ApprovalBinding
from ..governance.conditions import Acknowledgement, ConditionCode
from ..governance.events import GovernanceEvent, GovernanceEventType
from ..governance.override import BudgetOverride
from ..governance.purpose import SpendPurpose
from ..governance.reservation import (
    SettlementResult,
    SpendReservation,
    SpendReservationStatus,
)
from ..governance.snapshots import BudgetSnapshot


def money(raw: Any) -> Optional[Money]:
    """Rebuild a Money from its canonical rendering, or ``None``."""
    if raw is None:
        return None
    return Money(amount=Decimal(raw["amount"]), currency=raw["currency"])


def _stop_conditions(raw: list[str]) -> list[StopCondition]:
    """``"kind:description"`` back to a StopCondition. Split once — descriptions
    legitimately contain colons."""
    out = []
    for item in raw:
        kind, _, description = item.partition(":")
        out.append(StopCondition(kind=StopConditionKind(kind), description=description))
    return out


def budget_snapshot(payload: dict, *, taken_at: str = "") -> BudgetSnapshot:
    """``provider_credits`` is not restored — see the module docstring."""
    return BudgetSnapshot(
        budget_id=payload["budget_id"],
        policy_id=payload["policy_id"],
        policy_hash=payload["policy_hash"],
        currency=payload["currency"],
        hard_cap=money(payload["hard_cap"]),
        effective_cap=money(payload["effective_cap"]),
        actual_spend=money(payload["actual_spend"]),
        committed_spend=money(payload["committed_spend"]),
        approved_override_ids=list(payload["approved_override_ids"]),
        snapshot_version=payload["snapshot_version"],
        taken_at=taken_at,
    )


def approval_binding(payload: dict) -> ApprovalBinding:
    return ApprovalBinding(
        plan_hash=payload["plan_hash"],
        plan_version=payload["plan_version"],
        estimate_audit_hash=payload["estimate_audit_hash"],
        estimator_version=payload["estimator_version"],
        ruleset_version=payload["ruleset_version"],
        projection_hash=payload["projection_hash"],
        price_card_id=payload["price_card_id"],
        price_card_content_hash=payload["price_card_content_hash"],
        pricing_catalog_version=payload["pricing_catalog_version"],
        budget_policy_hash=payload["budget_policy_hash"],
        budget_snapshot_hash=payload["budget_snapshot_hash"],
        admission_hash=payload["admission_hash"],
        purpose=SpendPurpose(payload["purpose"]),
        execution_mode=ExecutionMode(payload["execution_mode"]),
        reserve_policy_hash=payload["reserve_policy_hash"],
        approved_commitment=payload.get("approved_commitment"),
    )


def acknowledgements(raw: list[dict]) -> list[Acknowledgement]:
    return [Acknowledgement(code=ConditionCode(a["code"]),
                            acknowledged_by=a["acknowledged_by"],
                            acknowledged_at=a["acknowledged_at"],
                            note=a.get("note", "")) for a in raw]


def governed_approval(payload: dict):
    """Imported lazily: the gate module imports persistence-free domain types only."""
    from ..governance.gate import GovernedApproval

    return GovernedApproval(
        decision_id=payload["decision_id"],
        request_id=payload["request_id"],
        approved=payload["approved"],
        approved_by=payload["approved_by"],
        decided_at=payload["decided_at"],
        binding=approval_binding(payload["binding"]),
        approved_commitment=money(payload["approved_commitment"]),
        acknowledgements=acknowledgements(payload["acknowledgements"]),
        valid_until=payload["valid_until"],
        reason=payload["reason"],
        markers=list(payload["markers"]),
    )


def execution_authorization(payload: dict) -> ExecutionAuthorization:
    ceiling = payload["usage_ceiling"]
    return ExecutionAuthorization(
        authorization_id=payload["authorization_id"],
        purpose=SpendPurpose(payload["purpose"]),
        binding=approval_binding(payload["binding"]),
        plan_id=payload["plan_id"],
        plan_version=payload["plan_version"],
        approval_decision_id=payload["approval_decision_id"],
        admission_id=payload["admission_id"],
        budget_snapshot_hash=payload["budget_snapshot_hash"],
        budget_id=payload.get("budget_id", ""),
        approved_commitment=money(payload["approved_commitment"]),
        reserve_amount=money(payload["reserve_amount"]),
        currency=payload["currency"],
        permitted_provider=payload["permitted_provider"],
        permitted_model_id=payload["permitted_model_id"],
        permitted_mode=ExecutionMode(payload["permitted_mode"]),
        usage_ceiling=UsageCeiling(**ceiling),
        stop_conditions=_stop_conditions(payload["stop_conditions"]),
        valid_from=payload["valid_from"],
        expires_at=payload["expires_at"],
        acknowledgements=acknowledgements(payload["acknowledgements"]),
        markers=list(payload["markers"]),
        issued_by=payload.get("issued_by", ""),
    )


def spend_reservation(payload: dict) -> SpendReservation:
    return SpendReservation(
        reservation_id=payload["reservation_id"],
        idempotency_key=payload["idempotency_key"],
        authorization_id=payload["authorization_id"],
        budget_id=payload["budget_id"],
        plan_id=payload["plan_id"],
        amount=money(payload["amount"]),
        reserve_component=money(payload["reserve_component"]),
        currency=payload["currency"],
        status=SpendReservationStatus(payload["status"]),
        settled_amount=money(payload["settled_amount"]),
        note=payload.get("note", ""),
        overrun=money(payload["overrun"]),
    )


def settlement_result(payload: dict) -> SettlementResult:
    return SettlementResult(
        reservation_id=payload["reservation_id"],
        reserved=money(payload["reserved"]),
        actual=money(payload["actual"]),
        overrun=money(payload["overrun"]),
        review_required=payload["review_required"],
        detail=payload["detail"],
    )


def budget_override(payload: dict) -> BudgetOverride:
    return BudgetOverride(
        override_id=payload["override_id"],
        actor=payload["actor"],
        reason=payload["reason"],
        business_value=payload["business_value"],
        original_cap=money(payload["original_cap"]),
        new_cap=money(payload["new_cap"]),
        currency=payload["currency"],
        bound_plan_hash=payload["bound_plan_hash"],
        bound_admission_hash=payload["bound_admission_hash"],
        approval_decision_id=payload["approval_decision_id"],
        granted_at=payload["granted_at"],
        expires_at=payload["expires_at"],
    )


def governance_event(payload: dict) -> GovernanceEvent:
    return GovernanceEvent(
        event_type=GovernanceEventType(payload["event_type"]),
        occurred_at=payload["occurred_at"],
        purpose=SpendPurpose(payload["purpose"]),
        plan_id=payload["plan_id"],
        budget_id=payload["budget_id"],
        actor=payload["actor"],
        subject_hashes=dict(payload["subject_hashes"]),
        amount=money(payload["amount"]),
        condition_codes=list(payload["condition_codes"]),
        detail=payload["detail"],
        markers=list(payload["markers"]),
    )
