"""Reservation ledger — reserve before spending, reconcile after.

The sequence is check → reserve → (spend) → reconcile, and the check is made against
``committed + actual``. Checking against ``actual`` alone is the classic double-spend:
two calls in flight each see room that only one of them has.

Modelled on the §2 call journal, which reserved a call's maximum exposure before
sending and reconciled the real cost afterwards. Its hardest-won rule is kept here:
**an ambiguous outcome does not release its reservation.** When it cannot be known
whether the provider processed and billed a request, quietly freeing the money would
let the same budget be spent twice. It stays held until a human resolves it.

Product-owned and in-memory. No file locking, no persistence — P1c is not authorised
to add either, and the semantics are what matter for review.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.budget import BudgetState
from ..contracts.money import Money
from .errors import (
    DoubleReconcileError,
    InsufficientBudgetError,
    UnknownReservationError,
)


class ReservationStatus(str, Enum):
    HELD = "held"
    RECONCILED = "reconciled"
    RELEASED = "released"
    #: The call may or may not have been billed. Never auto-released.
    AMBIGUOUS = "ambiguous"


class Reservation(BaseModel):
    """One held amount, with the identity of what it was held for."""

    model_config = ConfigDict(frozen=True)

    reservation_id: str
    plan_id: str
    stage_id: str | None = None
    amount: Money
    status: ReservationStatus = ReservationStatus.HELD
    actual: Money | None = None
    note: str = ""

    @model_validator(mode="after")
    def _coherent(self) -> "Reservation":
        if self.amount.is_negative():
            raise ValueError("a reservation cannot be negative")
        if self.status is ReservationStatus.RECONCILED and self.actual is None:
            raise ValueError("a reconciled reservation must record what was actually spent")
        if self.actual is not None and self.actual.currency != self.amount.currency:
            raise ValueError("reserved and actual amounts must share one currency")
        return self

    @property
    def is_open(self) -> bool:
        """Whether this reservation still encumbers budget."""
        return self.status in (ReservationStatus.HELD, ReservationStatus.AMBIGUOUS)


class ReservationLedger(BaseModel):
    """Live position for one plan under one policy.

    Immutable: every operation returns a new ledger. That makes the state machine
    reviewable and removes a whole class of concurrent-mutation bug by construction,
    at the cost of the caller having to keep the returned value.
    """

    model_config = ConfigDict(frozen=True)

    plan_id: str
    policy_id: str
    currency: str
    reservations: list[Reservation] = Field(default_factory=list)
    settled: Money | None = None       # reconciled spend, accumulated

    @model_validator(mode="after")
    def _coherent(self) -> "ReservationLedger":
        ids = [r.reservation_id for r in self.reservations]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate reservation id in ledger")
        for r in self.reservations:
            if r.amount.currency != self.currency:
                raise ValueError("every reservation must share the ledger's currency")
        return self

    @classmethod
    def empty(cls, *, plan_id: str, policy_id: str, currency: str) -> "ReservationLedger":
        return cls(plan_id=plan_id, policy_id=policy_id, currency=currency,
                   settled=Money.zero(currency))

    # --- position ---
    @property
    def committed(self) -> Money:
        """Held but not yet billed — including anything left ambiguous."""
        return sum((r.amount for r in self.reservations if r.is_open),
                   Money.zero(self.currency))

    @property
    def actual(self) -> Money:
        return self.settled or Money.zero(self.currency)

    def state(self) -> BudgetState:
        """The contract shape a :class:`BudgetGuard` reasons about."""
        return BudgetState(plan_id=self.plan_id, policy_id=self.policy_id,
                           committed=self.committed, actual=self.actual)

    def reservation(self, reservation_id: str) -> Reservation:
        for r in self.reservations:
            if r.reservation_id == reservation_id:
                return r
        raise UnknownReservationError(reservation_id)

    @property
    def has_unresolved_ambiguity(self) -> bool:
        """True while any call's billing status is unknown.

        A plan in this state must not be treated as safely within budget: the held
        amount may or may not have become real spend.
        """
        return any(r.status is ReservationStatus.AMBIGUOUS for r in self.reservations)

    # --- transitions ---
    def _replace(self, reservation_id: str, **updates) -> list[Reservation]:
        out = []
        for r in self.reservations:
            out.append(r.model_copy(update=updates) if r.reservation_id == reservation_id
                       else r)
        return out

    def reserve(self, *, reservation_id: str, amount: Money, cap: Money,
                stage_id: str | None = None) -> "ReservationLedger":
        """Hold ``amount`` against the cap, or refuse.

        The check is ``committed + actual + amount <= cap``. Raising here is the point
        of the class: the money is held *before* it can be spent, so a later overrun
        is not possible without this call having succeeded first.
        """
        if amount.currency != self.currency:
            raise ValueError("cannot reserve in a different currency")
        if any(r.reservation_id == reservation_id for r in self.reservations):
            raise ValueError(f"reservation {reservation_id!r} already exists")
        projected = self.committed + self.actual + amount
        if projected > cap:
            raise InsufficientBudgetError(
                self.plan_id,
                f"reserving {amount} would take the encumbered total to {projected}, "
                f"past the cap of {cap}")
        return self.model_copy(update={
            "reservations": [*self.reservations,
                             Reservation(reservation_id=reservation_id,
                                         plan_id=self.plan_id, stage_id=stage_id,
                                         amount=amount)],
        })

    def reconcile(self, reservation_id: str, actual: Money) -> "ReservationLedger":
        """Replace a held amount with what was really billed."""
        held = self.reservation(reservation_id)
        if held.status is not ReservationStatus.HELD:
            raise DoubleReconcileError(reservation_id, held.status.value)
        if actual.currency != self.currency:
            raise ValueError("cannot reconcile in a different currency")
        return self.model_copy(update={
            "reservations": self._replace(
                reservation_id, status=ReservationStatus.RECONCILED, actual=actual),
            "settled": self.actual + actual,
        })

    def release(self, reservation_id: str, *, reason: str) -> "ReservationLedger":
        """Free a hold for a call that provably never reached the provider."""
        held = self.reservation(reservation_id)
        if held.status is not ReservationStatus.HELD:
            raise DoubleReconcileError(reservation_id, held.status.value)
        if not reason.strip():
            raise ValueError("releasing a reservation requires a stated reason")
        return self.model_copy(update={
            "reservations": self._replace(
                reservation_id, status=ReservationStatus.RELEASED, note=reason),
        })

    def mark_ambiguous(self, reservation_id: str, *, reason: str) -> "ReservationLedger":
        """Record that it is unknown whether the provider billed this call.

        The hold is deliberately **not** freed. There is no auto-retry and this is not
        a failure — it is a state a human has to resolve, exactly as §2 required.
        """
        held = self.reservation(reservation_id)
        if held.status is not ReservationStatus.HELD:
            raise DoubleReconcileError(reservation_id, held.status.value)
        if not reason.strip():
            raise ValueError("an ambiguous outcome requires a stated reason")
        return self.model_copy(update={
            "reservations": self._replace(
                reservation_id, status=ReservationStatus.AMBIGUOUS, note=reason),
        })

    def resolve_ambiguous(self, reservation_id: str, *, was_billed: bool,
                          actual: Money | None = None,
                          resolved_by: str) -> "ReservationLedger":
        """Human resolution of an ambiguous call. Requires an attributed decision."""
        held = self.reservation(reservation_id)
        if held.status is not ReservationStatus.AMBIGUOUS:
            raise DoubleReconcileError(reservation_id, held.status.value)
        if not resolved_by.strip():
            raise ValueError("resolving an ambiguous call must name who decided")
        if was_billed:
            if actual is None:
                raise ValueError("a billed call must record what it cost")
            return self.model_copy(update={
                "reservations": self._replace(
                    reservation_id, status=ReservationStatus.RECONCILED, actual=actual,
                    note=f"resolved as billed by {resolved_by}"),
                "settled": self.actual + actual,
            })
        return self.model_copy(update={
            "reservations": self._replace(
                reservation_id, status=ReservationStatus.RELEASED,
                note=f"resolved as not billed by {resolved_by}"),
        })
