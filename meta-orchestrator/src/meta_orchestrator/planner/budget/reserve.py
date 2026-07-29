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


#: Bases a real-spend admission may use. ``FRACTION_OF_EXPECTED`` is absent on
#: purpose: sizing head-room from the *expected* case leaves the worst case
#: systematically under-covered, which is the opposite of what a contingency is for.
REAL_SPEND_BASES: frozenset[ReserveBasis] = frozenset({
    ReserveBasis.NONE,
    ReserveBasis.FIXED_AMOUNT,
    ReserveBasis.FRACTION_OF_WORST,
})

#: The name the §2-derived figure travels under, so nobody reads it as a product
#: default or as a calibrated value.
S2_DERIVED_25_PERCENT_HEURISTIC = "S2_DERIVED_25_PERCENT_HEURISTIC"


class ReservePolicy(BaseModel):
    """How much head-room to add on top of a quote, and why.

    **The default is NONE.** A quote is used as quoted unless somebody explicitly
    chooses otherwise. A contingency that appears by default is a contingency nobody
    decided on, and within a week it reads as part of the price.

    ``experimental`` marks a basis that may be used to explore but not to authorise
    real money.
    """

    model_config = ConfigDict(frozen=True)

    policy_name: str = "NONE"
    basis: ReserveBasis = ReserveBasis.NONE
    #: Decimal string, e.g. "0.25" for 25%. Unused when the basis is FIXED_AMOUNT.
    fraction: str = "0"
    #: Used only when the basis is FIXED_AMOUNT.
    fixed_amount: Money | None = None
    experimental: bool = False
    rationale: str = "no contingency; the quote is used as quoted"

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
        if not self.policy_name.strip():
            raise ValueError("a reserve policy must be named, so it can be cited")
        if self.basis is ReserveBasis.FRACTION_OF_EXPECTED and not self.experimental:
            raise ValueError(
                "FRACTION_OF_EXPECTED under-covers the worst case and is experimental; "
                "mark it experimental=True and use it in SIMULATION only")
        return self

    def permitted_for_real_spend(self) -> bool:
        """Whether this policy may size a real-money admission."""
        return self.basis in REAL_SPEND_BASES and not self.experimental

    def content_hash(self) -> str:
        """Full 64-hex identity. Changing a reserve policy invalidates prior approvals."""
        from ..governance.canonical import content_hash

        return content_hash({
            "policy_name": self.policy_name,
            "basis": self.basis.value,
            "fraction": self.fraction,
            "fixed_amount": self.fixed_amount,
            "experimental": self.experimental,
        })

    @classmethod
    def none(cls) -> "ReservePolicy":
        """The default. Explicit for callers that want to say so."""
        return cls()

    @classmethod
    def s2_derived_25_percent_heuristic(cls) -> "ReservePolicy":
        """25% of the quoted worst case — opt-in, and a heuristic, not a calibration.

        The figure comes from the reserve fraction §2's budget projection was
        authorised under. That was a **different workload**: one frozen Haiku model,
        two rounds per task, a $50 global cap. Nothing has measured it against product
        traffic, and the name carries that so it cannot quietly become "the standard
        25%".
        """
        return cls(
            policy_name=S2_DERIVED_25_PERCENT_HEURISTIC,
            basis=ReserveBasis.FRACTION_OF_WORST, fraction="0.25",
            rationale=("25% of the quoted worst case, taken from the reserve fraction "
                       "the §2 budget projection was authorised under — a different "
                       "workload (single frozen Haiku model, two rounds, $50 cap). "
                       "Heuristic, opt-in, never measured against product traffic"))

    @classmethod
    def fixed(cls, amount: Money, *, rationale: str,
              policy_name: str = "FIXED") -> "ReservePolicy":
        return cls(policy_name=policy_name, basis=ReserveBasis.FIXED_AMOUNT,
                   fixed_amount=amount, rationale=rationale)

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
