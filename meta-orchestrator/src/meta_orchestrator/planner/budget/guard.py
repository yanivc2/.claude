"""Admission control — may this cost be incurred?

Asked **before** money moves, never after. A check that runs once the response has
arrived has already lost: the tokens are billed whatever it decides.

Three rules the implementation exists to hold:

* **Measured against ``committed + actual``.** Never ``actual`` alone, or two calls in
  flight each see room only one of them has.
* **A non-authoritative price cannot back a real budget.** Fictional and unverified
  rates produce clean arithmetic and a meaningless answer; admitting on one is the
  worst kind of pass.
* **Contingency is a separate, visible addend.** ``quoted + reserve``, never a padded
  rate. That was G2 and it is not coming back through this door.

The guard decides. It does not execute, does not spend, and is not wired to the
orchestrator.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.budget import (
    AdmitDecision,
    AdmitResult,
    BreachAction,
    BudgetPolicy,
    BudgetState,
)
from ..contracts.money import Money
from ..estimation.projection import ModelCostProjection
from .errors import NonAuthoritativePriceError
from .reserve import ReservePolicy, ReservedAmount, apply_reserve


class AdmissionReport(BaseModel):
    """The full answer, not just yes or no.

    Carries what was asked for, what the contingency added, where the position stands
    and which warning thresholds this admission would cross — so a caller can explain
    the decision without recomputing it.
    """

    model_config = ConfigDict(frozen=True)

    result: AdmitResult
    requested: Optional[ReservedAmount] = None
    encumbered_before: Optional[Money] = None
    encumbered_after: Optional[Money] = None
    cap: Optional[Money] = None
    newly_crossed_thresholds: list[Decimal] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    @property
    def allowed(self) -> bool:
        return self.result.allowed


class BudgetGuard:
    """Implements the ``BudgetGuard`` port over the budget contracts.

    Stateless. The live position lives in a :class:`~.ledger.ReservationLedger`, which
    is passed in — so the guard can be asked hypothetical questions without a side
    effect on anything.
    """

    def __init__(self, reserve_policy: Optional[ReservePolicy] = None) -> None:
        self._reserve = reserve_policy or ReservePolicy()

    @property
    def reserve_policy(self) -> ReservePolicy:
        return self._reserve

    # --- the port ---
    def admit(self, projection: ModelCostProjection, policy: BudgetPolicy,
              state: BudgetState, *, allow_non_authoritative: bool = False
              ) -> AdmissionReport:
        """Decide whether a plan's projected cost may be committed.

        ``allow_non_authoritative`` exists for tests and dry runs. It defaults to
        ``False``, so a fictional price blocks unless someone explicitly says the
        budget is not real either.
        """
        if not projection.available or projection.range is None:
            return self._blocked(
                policy, state,
                f"no price available for {projection.model_id!r}: "
                f"{projection.unavailable_reason}")

        if not projection.authoritative_for_real_spend and not allow_non_authoritative:
            trust = projection.price_trust.value if projection.price_trust else "unknown"
            raise NonAuthoritativePriceError(projection.model_id, trust)

        requested = apply_reserve(self._reserve,
                                  expected=projection.range.expected,
                                  worst=projection.range.worst)
        return self._decide(policy, state, requested,
                            allow_non_authoritative=allow_non_authoritative,
                            projection=projection)

    def checkpoint(self, policy: BudgetPolicy, state: BudgetState,
                   additional: Money) -> AdmissionReport:
        """Mid-run check for an incremental amount. No contingency is re-added.

        The reserve was already taken at admission; adding it again per call would
        compound it silently, which is the same class of error as burying it in a rate.
        """
        requested = ReservedAmount(
            quoted=additional, reserve=Money.zero(additional.currency),
            basis=self._reserve.basis,
            rationale="incremental checkpoint; contingency was taken at admission")
        return self._decide(policy, state, requested)

    # --- internals ---
    def _decide(self, policy: BudgetPolicy, state: BudgetState,
                requested: ReservedAmount, *, allow_non_authoritative: bool = False,
                projection: Optional[ModelCostProjection] = None) -> AdmissionReport:
        cap = policy.cap
        if requested.currency != cap.limit.currency:
            return self._blocked(
                policy, state,
                f"currency mismatch: request is {requested.currency}, cap is "
                f"{cap.limit.currency} — no conversion exists at this layer")

        before = state.encumbered
        after = before + requested.total
        already = set(state.crossed_thresholds(cap))

        warnings: list[str] = []
        if projection is not None and not projection.authoritative_for_real_spend:
            warnings.append(
                f"admitted against a {projection.price_trust.value if projection.price_trust else 'non-authoritative'} "
                "price because allow_non_authoritative was set — this is not a real budget")
        if requested.reserve.amount > 0:
            warnings.append(
                f"includes an explicit contingency of {requested.reserve} "
                f"({requested.basis.value}: {requested.rationale})")

        if after > cap.limit:
            reason = (f"projected {requested.quoted} + reserve {requested.reserve} on "
                      f"top of {before} would reach {after}, past the cap of {cap.limit}")
            if policy.on_breach is BreachAction.ASK and policy.override_allowed:
                reason += " — an override decision is required to proceed"
            elif policy.on_breach is BreachAction.DEGRADE:
                reason += " — fall back to a cheaper approved plan"
            return self._blocked(policy, state, reason, requested=requested,
                                 after=after, warnings=warnings)

        after_state = BudgetState(plan_id=state.plan_id, policy_id=state.policy_id,
                                  committed=state.committed + requested.total,
                                  actual=state.actual)
        newly = sorted(set(after_state.crossed_thresholds(cap)) - already)

        decision = AdmitDecision.WARN_AND_ADMIT if newly else AdmitDecision.ADMIT
        if newly:
            warnings.append(
                "crosses warning threshold(s): "
                + ", ".join(f"{t * 100:.0f}%" for t in newly))

        return AdmissionReport(
            result=AdmitResult(
                decision=decision,
                reason=(f"{requested.total} admitted; {cap.limit - after} of "
                        f"{cap.limit} remains"),
                crossed_thresholds=newly,
                remaining=cap.limit - after),
            requested=requested,
            encumbered_before=before, encumbered_after=after, cap=cap.limit,
            newly_crossed_thresholds=newly, warnings=warnings,
        )

    def _blocked(self, policy: BudgetPolicy, state: BudgetState, reason: str, *,
                 requested: Optional[ReservedAmount] = None,
                 after: Optional[Money] = None,
                 warnings: Optional[list[str]] = None) -> AdmissionReport:
        return AdmissionReport(
            result=AdmitResult(decision=AdmitDecision.BLOCK, reason=reason,
                               remaining=policy.cap.limit - state.encumbered),
            requested=requested,
            encumbered_before=state.encumbered, encumbered_after=after,
            cap=policy.cap.limit, warnings=warnings or [],
        )

    # --- credits, which are not a budget ---
    @staticmethod
    def credits_cover(policy: BudgetPolicy, exposure: Money) -> Optional[bool]:
        """Whether reported provider credits cover an exposure.

        Deliberately separate from :meth:`admit`, and returns ``None`` when no credit
        figure was reported. Credits are operator-reported runtime state — they are not
        a cap, and a healthy balance is not authorisation to spend it.
        """
        if policy.reported_provider_credits is None:
            return None
        return policy.reported_provider_credits >= exposure
