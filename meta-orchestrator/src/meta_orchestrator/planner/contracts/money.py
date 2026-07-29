"""Money — the one shape every cost figure in the Planner travels in.

``Decimal``, never ``float``. The frozen §2 pricing artifact learned this the hard
way and says so in its own docstring ("Decimal-only… no float, no local rate"); the
product-side ``ModelSpec`` still carries ``price_per_1k_in/out`` as ``float``, so the
two halves of this repo currently disagree on the type of money. Contracts here take
the research side, because a budget cap enforced against binary-float arithmetic is a
cap that can be crossed by rounding.

Amounts are held as a ``Decimal`` plus an explicit ``currency``. No conversion happens
here and none is defined: multi-currency display is a P1+ concern, and picking an FX
source now would be exactly the kind of irreversible choice P0 is meant to avoid.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

#: Internal accounting currency. Provider prices are published in USD, so estimates and
#: ledgers are kept in USD and any other presentation currency is a rendering concern.
DEFAULT_CURRENCY = "USD"

#: Provider prices run to ~1e-8 per token; costs are accumulated before being rounded
#: for display, so the stored scale must be finer than any figure ever shown.
MONEY_SCALE = Decimal("0.00000001")


class Money(BaseModel):
    """An exact amount in one currency. Immutable; arithmetic returns new instances."""

    model_config = ConfigDict(frozen=True)

    amount: Decimal
    currency: str = DEFAULT_CURRENCY

    @field_validator("amount", mode="before")
    @classmethod
    def _coerce(cls, v: Any) -> Decimal:
        # str and int are exact; float is not, and silently accepting one would
        # reintroduce the very defect this type exists to prevent.
        if isinstance(v, float):
            raise TypeError("Money.amount must not be built from float — pass str or Decimal")
        return v if isinstance(v, Decimal) else Decimal(str(v))

    @field_validator("currency")
    @classmethod
    def _currency_shape(cls, v: str) -> str:
        if len(v) != 3 or not v.isalpha() or not v.isupper():
            raise ValueError(f"currency must be a 3-letter uppercase code, got {v!r}")
        return v

    @classmethod
    def zero(cls, currency: str = DEFAULT_CURRENCY) -> "Money":
        return cls(amount=Decimal(0), currency=currency)

    def _same_currency(self, other: "Money") -> None:
        if self.currency != other.currency:
            raise ValueError(
                f"refusing to combine {self.currency} with {other.currency} — "
                "no conversion is defined at this layer"
            )

    def __add__(self, other: "Money") -> "Money":
        self._same_currency(other)
        return Money(amount=self.amount + other.amount, currency=self.currency)

    def __sub__(self, other: "Money") -> "Money":
        self._same_currency(other)
        return Money(amount=self.amount - other.amount, currency=self.currency)

    def __mul__(self, factor: Decimal | int | str) -> "Money":
        if isinstance(factor, float):
            raise TypeError("refusing to scale Money by a float")
        f = factor if isinstance(factor, Decimal) else Decimal(str(factor))
        return Money(amount=self.amount * f, currency=self.currency)

    def __lt__(self, other: "Money") -> bool:
        self._same_currency(other)
        return self.amount < other.amount

    def __le__(self, other: "Money") -> bool:
        self._same_currency(other)
        return self.amount <= other.amount

    def __gt__(self, other: "Money") -> bool:
        return other < self

    def __ge__(self, other: "Money") -> bool:
        return other <= self

    def quantized(self, scale: Decimal = MONEY_SCALE) -> "Money":
        """Round to the stored scale. For display/persistence, not for accumulation."""
        return Money(amount=self.amount.quantize(scale, rounding=ROUND_HALF_UP),
                     currency=self.currency)

    def is_negative(self) -> bool:
        return self.amount < 0

    def __str__(self) -> str:
        return f"{self.amount.normalize()} {self.currency}"


class MoneyRange(BaseModel):
    """A best / expected / worst triple. Never collapse this to one number.

    The §2 closeout is the standing argument for carrying the spread: its headline
    figure was a point estimate whose interval covered zero, and the interval is what
    made the honest reading possible.
    """

    model_config = ConfigDict(frozen=True)

    best: Money
    expected: Money
    worst: Money

    @model_validator(mode="after")
    def _ordered_and_consistent(self) -> "MoneyRange":
        if not (self.best.currency == self.expected.currency == self.worst.currency):
            raise ValueError("MoneyRange bounds must share one currency")
        if not (self.best <= self.expected <= self.worst):
            raise ValueError(
                f"MoneyRange must satisfy best <= expected <= worst, got "
                f"{self.best} / {self.expected} / {self.worst}"
            )
        return self

    @property
    def currency(self) -> str:
        return self.expected.currency

    @property
    def spread(self) -> Money:
        """worst − best. A wide spread is a signal to widen, not hide, the estimate."""
        return self.worst - self.best
