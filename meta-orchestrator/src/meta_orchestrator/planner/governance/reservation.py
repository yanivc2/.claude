"""Spend reservations — a hardened lifecycle with idempotency.

Two things a naive ledger silently gets wrong:

* **Illegal transitions.** Settling twice, releasing after settling, committing twice —
  each is a distinct way to spend or free the same money twice. Each raises.
* **Retries.** A retried request with an identical payload returns the original
  reservation. The *same key with different content* is a bug — the caller believes it
  is retrying and is in fact asking for something else — and it raises.

Overruns are recorded, never absorbed. Settling above the reservation does not quietly
widen the cap; it produces a result flagged for review.

In-memory, and **logical protection only**: nothing here serialises concurrent writers.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.money import Money
from .canonical import CanonicalMixin, content_hash
from .errors import IdempotencyConflictError, InvalidReservationTransitionError


class SpendReservationStatus(str, Enum):
    PROPOSED = "proposed"
    COMMITTED = "committed"
    RELEASED = "released"
    SETTLED = "settled"
    EXPIRED = "expired"
    #: May or may not have been billed. Never auto-released.
    AMBIGUOUS = "ambiguous"


#: The complete transition table. Anything absent raises.
_ALLOWED: dict[SpendReservationStatus, frozenset[SpendReservationStatus]] = {
    SpendReservationStatus.PROPOSED: frozenset({
        SpendReservationStatus.COMMITTED, SpendReservationStatus.RELEASED,
        SpendReservationStatus.EXPIRED}),
    SpendReservationStatus.COMMITTED: frozenset({
        SpendReservationStatus.SETTLED, SpendReservationStatus.RELEASED,
        SpendReservationStatus.AMBIGUOUS, SpendReservationStatus.EXPIRED}),
    SpendReservationStatus.AMBIGUOUS: frozenset({
        SpendReservationStatus.SETTLED, SpendReservationStatus.RELEASED}),
    SpendReservationStatus.SETTLED: frozenset(),
    SpendReservationStatus.RELEASED: frozenset(),
    SpendReservationStatus.EXPIRED: frozenset(),
}

#: Statuses that still encumber budget.
OPEN_STATUSES = frozenset({SpendReservationStatus.PROPOSED,
                           SpendReservationStatus.COMMITTED,
                           SpendReservationStatus.AMBIGUOUS})


def can_transition(src: SpendReservationStatus,
                   dst: SpendReservationStatus) -> bool:
    return dst in _ALLOWED[src]


class SpendReservation(BaseModel, CanonicalMixin):
    """One reservation, bound to the authorization that permitted it."""

    model_config = ConfigDict(frozen=True)

    reservation_id: str
    idempotency_key: str
    authorization_id: str
    budget_id: str
    plan_id: str
    amount: Money
    reserve_component: Money
    currency: str
    status: SpendReservationStatus = SpendReservationStatus.PROPOSED
    settled_amount: Optional[Money] = None
    note: str = ""
    #: Set when settlement came in above the reservation.
    overrun: Optional[Money] = None

    @model_validator(mode="after")
    def _coherent(self) -> "SpendReservation":
        for name in ("amount", "reserve_component"):
            money: Money = getattr(self, name)
            if money.currency != self.currency:
                raise ValueError(f"{name} must be in the reservation's currency")
            if money.is_negative():
                raise ValueError(f"{name} cannot be negative")
        if self.reserve_component > self.amount:
            raise ValueError("the reserve component cannot exceed the reservation")
        if not self.idempotency_key.strip():
            raise ValueError("a reservation needs an idempotency key")
        if self.status is SpendReservationStatus.SETTLED and self.settled_amount is None:
            raise ValueError("a settled reservation must record what it cost")
        return self

    @property
    def is_open(self) -> bool:
        return self.status in OPEN_STATUSES

    @property
    def quoted_component(self) -> Money:
        return self.amount - self.reserve_component

    def payload_hash(self) -> str:
        """Identity of what was asked for — what an idempotent retry must match."""
        return content_hash({
            "idempotency_key": self.idempotency_key,
            "authorization_id": self.authorization_id,
            "budget_id": self.budget_id,
            "plan_id": self.plan_id,
            "amount": self.amount,
            "reserve_component": self.reserve_component,
            "currency": self.currency,
        })

    def _to(self, dst: SpendReservationStatus, **updates) -> "SpendReservation":
        if not can_transition(self.status, dst):
            raise InvalidReservationTransitionError(
                self.reservation_id, self.status.value, dst.value)
        return self.model_copy(update={"status": dst, **updates})

    def commit(self) -> "SpendReservation":
        return self._to(SpendReservationStatus.COMMITTED)

    def release(self, *, reason: str) -> "SpendReservation":
        if not reason.strip():
            raise ValueError("releasing a reservation requires a stated reason")
        return self._to(SpendReservationStatus.RELEASED, note=reason)

    def mark_ambiguous(self, *, reason: str) -> "SpendReservation":
        if not reason.strip():
            raise ValueError("an ambiguous outcome requires a stated reason")
        return self._to(SpendReservationStatus.AMBIGUOUS, note=reason)

    def expire(self, *, reason: str = "expired") -> "SpendReservation":
        return self._to(SpendReservationStatus.EXPIRED, note=reason)

    def settle(self, actual: Money) -> "SpendReservation":
        """Record the real cost. An overrun is flagged, never absorbed."""
        if actual.currency != self.currency:
            raise ValueError("settlement must be in the reservation's currency")
        if actual.is_negative():
            raise ValueError("a settlement cannot be negative")
        overrun = actual - self.amount if actual > self.amount else None
        return self._to(SpendReservationStatus.SETTLED, settled_amount=actual,
                        overrun=overrun)

    def canonical_payload(self) -> dict:
        return {
            "reservation_id": self.reservation_id,
            "idempotency_key": self.idempotency_key,
            "authorization_id": self.authorization_id,
            "budget_id": self.budget_id,
            "plan_id": self.plan_id,
            "amount": self.amount,
            "reserve_component": self.reserve_component,
            "currency": self.currency,
            "status": self.status.value,
            "settled_amount": self.settled_amount,
            "overrun": self.overrun,
            "note": self.note,
        }


class SettlementResult(BaseModel, CanonicalMixin):
    """The outcome of settling one reservation."""

    model_config = ConfigDict(frozen=True)

    reservation_id: str
    reserved: Money
    actual: Money
    overrun: Optional[Money] = None
    review_required: bool = False
    detail: str = ""

    @model_validator(mode="after")
    def _overrun_always_needs_review(self) -> "SettlementResult":
        if self.overrun is not None and not self.review_required:
            raise ValueError(
                "an overrun always requires review — absorbing it silently is the same "
                "as having no cap")
        return self

    @classmethod
    def of(cls, reservation: SpendReservation) -> "SettlementResult":
        if reservation.settled_amount is None:
            raise ValueError("cannot build a settlement result before settling")
        overrun = reservation.overrun
        return cls(
            reservation_id=reservation.reservation_id,
            reserved=reservation.amount, actual=reservation.settled_amount,
            overrun=overrun, review_required=overrun is not None,
            detail=("settled within the reservation" if overrun is None
                    else f"settled {overrun} above the reservation — review required"))

    def canonical_payload(self) -> dict:
        return {"reservation_id": self.reservation_id, "reserved": self.reserved,
                "actual": self.actual, "overrun": self.overrun,
                "review_required": self.review_required, "detail": self.detail}


class SpendReservationBook(BaseModel):
    """Reservations for one budget, with idempotent creation. Immutable."""

    model_config = ConfigDict(frozen=True)

    budget_id: str
    currency: str
    reservations: list[SpendReservation] = Field(default_factory=list)

    def by_key(self, idempotency_key: str) -> Optional[SpendReservation]:
        for r in self.reservations:
            if r.idempotency_key == idempotency_key:
                return r
        return None

    def get(self, reservation_id: str) -> SpendReservation:
        for r in self.reservations:
            if r.reservation_id == reservation_id:
                return r
        raise KeyError(reservation_id)

    @property
    def committed(self) -> Money:
        return sum((r.amount for r in self.reservations if r.is_open),
                   Money.zero(self.currency))

    @property
    def settled(self) -> Money:
        return sum((r.settled_amount for r in self.reservations
                    if r.settled_amount is not None), Money.zero(self.currency))

    @property
    def has_unresolved_ambiguity(self) -> bool:
        return any(r.status is SpendReservationStatus.AMBIGUOUS
                   for r in self.reservations)

    @property
    def overruns(self) -> list[SpendReservation]:
        return [r for r in self.reservations if r.overrun is not None]

    def propose(self, reservation: SpendReservation
                ) -> tuple["SpendReservationBook", SpendReservation]:
        """Create, or return the existing one for an identical retry."""
        existing = self.by_key(reservation.idempotency_key)
        if existing is not None:
            if existing.payload_hash() != reservation.payload_hash():
                raise IdempotencyConflictError(reservation.idempotency_key)
            return self, existing
        return self.model_copy(update={
            "reservations": [*self.reservations, reservation]}), reservation

    def replace(self, reservation: SpendReservation) -> "SpendReservationBook":
        """Store an advanced copy of a reservation already in the book."""
        found = False
        out: list[SpendReservation] = []
        for r in self.reservations:
            if r.reservation_id == reservation.reservation_id:
                out.append(reservation)
                found = True
            else:
                out.append(r)
        if not found:
            raise KeyError(reservation.reservation_id)
        return self.model_copy(update={"reservations": out})
