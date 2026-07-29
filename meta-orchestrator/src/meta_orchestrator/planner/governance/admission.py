"""Governed admission — the guard, extended with everything an approval binds to.

The P1c guard answered "is there room?". This answers the question an approval
actually needs: *for this purpose, against this budget snapshot, at this plan version,
on this price, under this reserve policy — may this be committed, and what did the
approver have to accept in order to say yes?*

The result is a :class:`GovernedAdmission`: content-hashed, so an approval can bind to
it, and carrying its conditions so nothing is waved through implicitly.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..budget.reserve import ReservedAmount, ReservePolicy, apply_reserve
from ..contracts.budget import HardBudgetCap
from ..contracts.money import Money
from ..estimation.entities import UsageEstimate
from ..estimation.projection import ModelCostProjection
from ..pricing.entities import PriceTrust
from .canonical import CanonicalMixin
from .conditions import ConditionCode, ConditionSet
from .freshness import PriceFreshnessPolicy, check_freshness
from .purpose import SpendPurpose, eligibility_markers, trust_permitted
from .snapshots import BudgetSnapshot, PlanSnapshot


class GovernedAdmission(BaseModel, CanonicalMixin):
    """One admission decision, with everything that shaped it."""

    model_config = ConfigDict(frozen=True)

    admission_id: str
    purpose: SpendPurpose
    plan_snapshot_hash: str
    budget_snapshot_hash: str
    reserve_policy_hash: str
    model_id: str
    currency: str

    requested: ReservedAmount
    encumbered_before: Money
    encumbered_after: Money
    effective_cap: Money
    remaining_after: Money
    crossed_thresholds: list[Decimal] = Field(default_factory=list)

    conditions: ConditionSet = ConditionSet()
    markers: list[str] = Field(default_factory=list)
    evaluated_at: str = ""

    @property
    def admitted(self) -> bool:
        """Admitted only when nothing blocking stands. Warnings do not block."""
        return self.conditions.is_clear

    @property
    def blocking_codes(self) -> list[str]:
        return [c.code.value for c in self.conditions.blocking]

    def canonical_payload(self) -> dict:
        return {
            "admission_id": self.admission_id,
            "purpose": self.purpose.value,
            "plan_snapshot_hash": self.plan_snapshot_hash,
            "budget_snapshot_hash": self.budget_snapshot_hash,
            "reserve_policy_hash": self.reserve_policy_hash,
            "model_id": self.model_id,
            "currency": self.currency,
            "quoted": self.requested.quoted,
            "reserve": self.requested.reserve,
            "reserve_basis": self.requested.basis.value,
            "encumbered_before": self.encumbered_before,
            "encumbered_after": self.encumbered_after,
            "effective_cap": self.effective_cap,
            "crossed_thresholds": [str(t) for t in self.crossed_thresholds],
            "conditions": self.conditions.canonical_payload(),
            "markers": sorted(self.markers),
        }


class GovernedBudgetGuard:
    """Admission control that produces a bindable artifact.

    Stateless. Everything it reasons about arrives as arguments, so it can be asked
    hypothetical questions without side effects.
    """

    def __init__(self, reserve_policy: Optional[ReservePolicy] = None,
                 freshness: Optional[PriceFreshnessPolicy] = None) -> None:
        #: Default NONE — a contingency nobody chose is a contingency nobody decided on.
        self._reserve = reserve_policy or ReservePolicy.none()
        self._freshness = freshness or PriceFreshnessPolicy()

    @property
    def reserve_policy(self) -> ReservePolicy:
        return self._reserve

    @property
    def freshness_policy(self) -> PriceFreshnessPolicy:
        return self._freshness

    def admit(self, *, admission_id: str, purpose: SpendPurpose,
              plan: PlanSnapshot, snapshot: BudgetSnapshot,
              projection: ModelCostProjection, estimate: Optional[UsageEstimate] = None,
              cap: Optional[HardBudgetCap] = None, as_of: str = "",
              evaluated_at: str = "") -> GovernedAdmission:
        """Evaluate one admission and record every condition it raises."""
        conditions = ConditionSet()

        # --- reserve policy eligibility ---
        if purpose.is_real and not self._reserve.permitted_for_real_spend():
            conditions = conditions.with_condition(
                ConditionCode.RESERVE_MODE_NOT_PERMITTED,
                f"reserve policy {self._reserve.policy_name!r} "
                f"(basis {self._reserve.basis.value}"
                f"{', experimental' if self._reserve.experimental else ''}) may not "
                "size a real-spend admission")

        # --- price availability and trust ---
        if not projection.available or projection.range is None:
            conditions = conditions.with_condition(
                ConditionCode.WORST_COST_UNAVAILABLE,
                f"no price for {projection.model_id!r}: "
                f"{projection.unavailable_reason}")
            return self._blocked(
                admission_id=admission_id, purpose=purpose, plan=plan,
                snapshot=snapshot, projection=projection, conditions=conditions,
                evaluated_at=evaluated_at)

        trust = projection.price_trust or PriceTrust.UNVERIFIED
        if not trust_permitted(purpose, trust):
            code = (ConditionCode.FICTIONAL_PRICE_IN_REAL_SPEND
                    if trust is PriceTrust.FICTIONAL
                    else ConditionCode.NON_AUTHORITATIVE_PRICE)
            conditions = conditions.with_condition(
                code, f"price for {projection.model_id!r} is {trust.value}, which "
                      f"cannot back {purpose.value}")
        elif trust is not PriceTrust.PROVIDER_VERIFIED:
            conditions = conditions.with_condition(
                ConditionCode.PRICE_NOT_PROVIDER_VERIFIED,
                f"price for {projection.model_id!r} is {trust.value}: traceable "
                "in-repo but never re-checked against the provider")

        # --- freshness ---
        freshness_code = check_freshness(
            self._freshness, model_id=projection.model_id,
            verified_at=projection.price_verified_at or "", as_of=as_of or evaluated_at)
        if freshness_code is not None:
            detail = (f"price for {projection.model_id!r} verified "
                      f"{projection.price_verified_at or 'never'}"
                      if freshness_code is ConditionCode.PRICE_TOO_OLD
                      else "no price freshness policy is configured; this price was "
                           "not verified against the provider at execution time")
            conditions = conditions.with_condition(freshness_code, detail)

        # --- estimate quality ---
        if estimate is not None:
            if estimate.partial and purpose.is_real:
                conditions = conditions.with_condition(
                    ConditionCode.PARTIAL_ESTIMATE_IN_REAL_SPEND,
                    "the underlying usage estimate is partial")
            if estimate.unbounded:
                conditions = conditions.with_condition(
                    ConditionCode.UNBOUNDED_ESTIMATE,
                    "the usage estimate has no bounded worst case")
            conditions = conditions.with_condition(
                ConditionCode.CONFIDENCE_UNKNOWN,
                "estimate confidence is UNKNOWN and has never been calibrated")
            conditions = conditions.with_condition(
                ConditionCode.HEURISTIC_ESTIMATOR,
                f"produced by {estimate.estimator_id}@{estimate.estimator_version} "
                f"({estimate.ruleset_version}); every coefficient is a heuristic")

        # --- money ---
        requested = apply_reserve(self._reserve,
                                  expected=projection.range.expected,
                                  worst=projection.range.worst)
        if requested.currency != snapshot.currency:
            conditions = conditions.with_condition(
                ConditionCode.CURRENCY_MISMATCH,
                f"quote is {requested.currency}, budget is {snapshot.currency}; "
                "no conversion exists at this layer")
            return self._blocked(
                admission_id=admission_id, purpose=purpose, plan=plan,
                snapshot=snapshot, projection=projection, conditions=conditions,
                requested=requested, evaluated_at=evaluated_at)

        before = snapshot.encumbered
        after = before + requested.total
        if after > snapshot.effective_cap:
            conditions = conditions.with_condition(
                ConditionCode.BUDGET_BREACH,
                f"{requested.quoted} + reserve {requested.reserve} on top of {before} "
                f"reaches {after}, past the effective cap of {snapshot.effective_cap}")

        if requested.reserve.amount > 0:
            conditions = conditions.with_condition(
                ConditionCode.RESERVE_APPLIED,
                f"{requested.reserve} contingency under policy "
                f"{self._reserve.policy_name!r}: {self._reserve.rationale}")

        crossed: list[Decimal] = []
        if cap is not None and snapshot.effective_cap.amount > 0:
            used_before = before.amount / snapshot.effective_cap.amount
            used_after = after.amount / snapshot.effective_cap.amount
            crossed = [t for t in cap.warn_thresholds
                       if used_after >= t > used_before]
            for threshold in crossed:
                conditions = conditions.with_condition(
                    ConditionCode.THRESHOLD_CROSSED,
                    f"crosses {threshold * 100:.0f}% of the effective cap")

        # --- deliverables ---
        if purpose.is_real and not plan.deliverables:
            conditions = conditions.with_condition(
                ConditionCode.MISSING_DELIVERABLES,
                f"plan {plan.plan_id!r} names no deliverables and is not marked as "
                "producing no artifact")

        markers = eligibility_markers(purpose)
        if markers:
            conditions = conditions.with_condition(
                ConditionCode.SIMULATION_ARTIFACT,
                "produced under SIMULATION; not eligible for real spend")

        return GovernedAdmission(
            admission_id=admission_id, purpose=purpose,
            plan_snapshot_hash=plan.content_hash(),
            budget_snapshot_hash=snapshot.content_hash(),
            reserve_policy_hash=self._reserve.content_hash(),
            model_id=projection.model_id, currency=snapshot.currency,
            requested=requested, encumbered_before=before, encumbered_after=after,
            effective_cap=snapshot.effective_cap,
            remaining_after=snapshot.effective_cap - after,
            crossed_thresholds=crossed, conditions=conditions, markers=markers,
            evaluated_at=evaluated_at)

    def _blocked(self, *, admission_id: str, purpose: SpendPurpose,
                 plan: PlanSnapshot, snapshot: BudgetSnapshot,
                 projection: ModelCostProjection, conditions: ConditionSet,
                 requested: Optional[ReservedAmount] = None,
                 evaluated_at: str = "") -> GovernedAdmission:
        zero = Money.zero(snapshot.currency)
        placeholder = requested or ReservedAmount(
            quoted=zero, reserve=zero, basis=self._reserve.basis,
            rationale="no priceable amount")
        return GovernedAdmission(
            admission_id=admission_id, purpose=purpose,
            plan_snapshot_hash=plan.content_hash(),
            budget_snapshot_hash=snapshot.content_hash(),
            reserve_policy_hash=self._reserve.content_hash(),
            model_id=projection.model_id, currency=snapshot.currency,
            requested=placeholder, encumbered_before=snapshot.encumbered,
            encumbered_after=snapshot.encumbered,
            effective_cap=snapshot.effective_cap,
            remaining_after=snapshot.remaining,
            conditions=conditions, markers=eligibility_markers(purpose),
            evaluated_at=evaluated_at)
