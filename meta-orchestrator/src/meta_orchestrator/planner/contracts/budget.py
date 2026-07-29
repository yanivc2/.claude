"""Budget contracts — seven different numbers that are all called "the cost".

Keeping them apart is the whole point of this module:

===========================  ==================================================
estimated / expected          what the estimator thinks it will cost
likely range                  best..worst around that
worst reasonable              a defensible upper bound — NOT permission to spend it
approved budget               what the operator said yes to for this plan
hard budget cap               the ceiling execution may never cross
committed spend               reserved for calls in flight, not yet billed
actual spend                  reconciled against real provider usage
===========================  ==================================================

A hard cap is not advice. §2 reserved the maximum exposure of a call *before*
sending it and reconciled afterwards, because a check that runs after the response
arrives is a check that has already lost. ``BudgetState`` carries ``committed``
separately from ``actual`` for the same reason.

Provider credits are not a budget. An API account with $500 on it says nothing about
what this project was authorised to spend; §2 recorded reported credits as runtime
state with ``is_budget_cap: false`` and checked them separately.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .money import Money


class BreachAction(str, Enum):
    """What happens when the cap would be crossed."""

    STOP = "stop"          # halt, fail closed
    ASK = "ask"            # pause and request an override decision
    DEGRADE = "degrade"    # fall back to a cheaper plan, if one was approved


class HardBudgetCap(BaseModel):
    """The ceiling. Separate type from ``Money`` so it cannot be passed as an estimate."""

    model_config = ConfigDict(frozen=True)

    limit: Money
    #: Fractions of the limit at which to warn, ascending, exclusive of 1.0.
    warn_thresholds: list[Decimal] = Field(
        default_factory=lambda: [Decimal("0.50"), Decimal("0.75"), Decimal("0.90")])

    @model_validator(mode="after")
    def _sane(self) -> "HardBudgetCap":
        if self.limit.is_negative():
            raise ValueError("a budget cap cannot be negative")
        if self.warn_thresholds != sorted(self.warn_thresholds):
            raise ValueError("warn_thresholds must be ascending")
        if len(set(self.warn_thresholds)) != len(self.warn_thresholds):
            raise ValueError("warn_thresholds must be distinct")
        for t in self.warn_thresholds:
            if not (Decimal(0) < t < Decimal(1)):
                raise ValueError(f"warn threshold {t} must lie strictly in (0, 1)")
        return self

    def amount_at(self, fraction: Decimal) -> Money:
        return self.limit * fraction


class BudgetPolicy(BaseModel):
    """The operator's approved spending rules for one plan.

    Content-addressed like the §2 budget policy: changing a cap changes the hash, which
    invalidates any approval granted under the old one rather than silently widening it.
    """

    model_config = ConfigDict(frozen=True)

    policy_id: str
    cap: HardBudgetCap
    on_breach: BreachAction = BreachAction.STOP
    #: Whether a human may authorise going past the cap at all.
    override_allowed: bool = True
    #: Operator-reported provider credits. Runtime state, never a cap — recorded so a
    #: run can refuse to start when credits are below the next block's exposure.
    reported_provider_credits: Money | None = None
    policy_hash: str = ""

    @model_validator(mode="after")
    def _credits_are_not_a_cap(self) -> "BudgetPolicy":
        if (self.reported_provider_credits is not None
                and self.reported_provider_credits.currency != self.cap.limit.currency):
            raise ValueError("reported credits and the cap must share one currency")
        return self

    @property
    def currency(self) -> str:
        return self.cap.limit.currency


class BudgetState(BaseModel):
    """Live position against a policy: what is reserved, what is billed, what is left.

    ``committed`` covers calls that have been reserved but not yet reconciled. Spending
    decisions must be made against ``committed + actual``, never ``actual`` alone —
    otherwise two concurrent calls can each see room that only one of them has.
    """

    model_config = ConfigDict(frozen=True)

    plan_id: str
    policy_id: str
    committed: Money
    actual: Money

    @model_validator(mode="after")
    def _non_negative(self) -> "BudgetState":
        if self.committed.is_negative() or self.actual.is_negative():
            raise ValueError("committed and actual spend cannot be negative")
        if self.committed.currency != self.actual.currency:
            raise ValueError("committed and actual must share one currency")
        return self

    @property
    def encumbered(self) -> Money:
        """Everything spoken for: billed plus reserved."""
        return self.actual + self.committed

    def remaining(self, cap: HardBudgetCap) -> Money:
        return cap.limit - self.encumbered

    def would_exceed(self, cap: HardBudgetCap, additional: Money) -> bool:
        """Whether admitting ``additional`` would cross the cap. Checked before sending."""
        return (self.encumbered + additional) > cap.limit

    def crossed_thresholds(self, cap: HardBudgetCap) -> list[Decimal]:
        """Warning fractions already reached by the encumbered total."""
        if cap.limit.amount <= 0:
            return []
        used = self.encumbered.amount / cap.limit.amount
        return [t for t in cap.warn_thresholds if used >= t]


class AdmitDecision(str, Enum):
    ADMIT = "admit"
    WARN_AND_ADMIT = "warn_and_admit"
    BLOCK = "block"


class AdmitResult(BaseModel):
    """The answer to "may this cost be incurred?" — with its reason recorded."""

    model_config = ConfigDict(frozen=True)

    decision: AdmitDecision
    reason: str
    crossed_thresholds: list[Decimal] = Field(default_factory=list)
    remaining: Money | None = None

    @property
    def allowed(self) -> bool:
        return self.decision is not AdmitDecision.BLOCK


class BudgetOverride(BaseModel):
    """An audited decision to spend past the cap.

    Append-only, and it must name a person and a justification. §2's closeout is the
    argument for the audit trail: a spend record nobody can attribute is a spend record
    nobody can defend.
    """

    model_config = ConfigDict(frozen=True)

    override_id: str
    plan_id: str
    policy_id: str
    previous_limit: Money
    new_limit: Money
    approved_by: str
    approved_at: str
    justification: str
    business_value: str = ""

    @model_validator(mode="after")
    def _accountable(self) -> "BudgetOverride":
        if not self.approved_by.strip():
            raise ValueError("a budget override must name who approved it")
        if not self.justification.strip():
            raise ValueError("a budget override must record why it was needed")
        if self.new_limit <= self.previous_limit:
            raise ValueError("an override must raise the limit")
        return self
