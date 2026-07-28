"""Contingency — an explicit line item, never a fudge inside a rate.

This module exists because of G2. The orchestrator's old pre-flight estimate priced
every token at the most expensive model's *output* rate, which inflated the figure and
could be mistaken for a safety margin. It was not a margin; it was a wrong rate that
happened to err upward. The two are different in the way that matters: a wrong rate
cannot be reasoned about, tuned, or switched off, and nobody can tell you how much
head-room it actually bought.

So a reserve here is always:

    authorised = quoted + reserve

with ``quoted`` untouched and ``reserve`` computed from a stated policy. It is visible
in the result, it is separately auditable, and setting it to zero is a supported
configuration rather than a hack.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, model_validator

from ..contracts.money import Money


class ReserveBasis(str, Enum):
    """Where the contingency figure comes from."""

    NONE = "none"
    #: A fraction of the quoted worst case.
    FRACTION_OF_WORST = "fraction_of_worst"
    #: A fraction of the quoted expected case.
    FRACTION_OF_EXPECTED = "fraction_of_expected"
    #: A flat amount, independent of the quote.
    FIXED_AMOUNT = "fixed_amount"


class ReservePolicy(BaseModel):
    """How much head-room to add on top of a quote, and why.

    §2 used a 25% reserve on its gate-binding projection. That number is carried here
    as the documented default rather than as a hidden constant, and the rationale is
    recorded so a later change is a decision rather than a drift.
    """

    model_config = ConfigDict(frozen=True)

    basis: ReserveBasis = ReserveBasis.FRACTION_OF_WORST
    #: Decimal string, e.g. "0.25" for 25%. Unused when the basis is FIXED_AMOUNT.
    fraction: str = "0.25"
    #: Used only when the basis is FIXED_AMOUNT.
    fixed_amount: Money | None = None
    rationale: str = (
        "25% of the quoted worst case, matching the reserve fraction the §2 budget "
        "projection was authorised under"
    )

    @model_validator(mode="after")
    def _coherent(self) -> "ReservePolicy":
        if self.basis is ReserveBasis.FIXED_AMOUNT:
            if self.fixed_amount is None:
                raise ValueError("a FIXED_AMOUNT reserve must carry an amount")
            if self.fixed_amount.is_negative():
                raise ValueError("a reserve cannot be negative")
        else:
            try:
                fraction = Decimal(self.fraction)
            except Exception as exc:
                raise ValueError(f"reserve fraction {self.fraction!r} is not a decimal") from exc
            if fraction < 0:
                raise ValueError("a reserve fraction cannot be negative")
            if fraction > Decimal("1"):
                raise ValueError(
                    f"a reserve of {fraction} would more than double the quote — if that "
                    "is genuinely intended, state it as a FIXED_AMOUNT so it is visible")
        if not self.rationale.strip():
            raise ValueError("a reserve policy must say where its figure came from")
        return self

    @classmethod
    def none(cls) -> "ReservePolicy":
        return cls(basis=ReserveBasis.NONE, fraction="0",
                   rationale="no contingency; the quote is used as-is")

    def compute(self, *, expected: Money, worst: Money) -> Money:
        """The contingency amount for one quote. Never folded into the quote itself."""
        if expected.currency != worst.currency:
            raise ValueError("expected and worst must share one currency")
        if self.basis is ReserveBasis.NONE:
            return Money.zero(worst.currency)
        if self.basis is ReserveBasis.FIXED_AMOUNT:
            assert self.fixed_amount is not None
            if self.fixed_amount.currency != worst.currency:
                raise ValueError("a fixed reserve must match the quote's currency")
            return self.fixed_amount
        base = worst if self.basis is ReserveBasis.FRACTION_OF_WORST else expected
        return base * Decimal(self.fraction)


class ReservedAmount(BaseModel):
    """A quote plus its contingency, kept as two visible numbers.

    ``total`` is what admission is checked against. ``quoted`` is what the pricing
    module actually said. Anyone reading this can see which is which, which is the
    whole point.
    """

    model_config = ConfigDict(frozen=True)

    quoted: Money
    reserve: Money
    basis: ReserveBasis
    rationale: str

    @model_validator(mode="after")
    def _coherent(self) -> "ReservedAmount":
        if self.quoted.currency != self.reserve.currency:
            raise ValueError("quote and reserve must share one currency")
        if self.reserve.is_negative():
            raise ValueError("a reserve cannot be negative")
        return self

    @property
    def total(self) -> Money:
        return self.quoted + self.reserve

    @property
    def currency(self) -> str:
        return self.quoted.currency


def apply_reserve(policy: ReservePolicy, *, expected: Money, worst: Money,
                  against: Money | None = None) -> ReservedAmount:
    """Attach a contingency to a quote.

    ``against`` selects which figure the reserve is added to — the worst case by
    default, since that is what a cap has to survive.
    """
    quoted = against if against is not None else worst
    return ReservedAmount(
        quoted=quoted,
        reserve=policy.compute(expected=expected, worst=worst),
        basis=policy.basis,
        rationale=policy.rationale,
    )
