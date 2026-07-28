"""Pricing error contracts. Every one of these blocks a quote rather than degrading it.

The rule this module exists to enforce: **an unknown price is never zero.** A missing
rate must stop a budget-bearing calculation, not silently contribute nothing to a
total that then looks authoritative.
"""
from __future__ import annotations

from ..contracts.errors import PlannerError


class PricingError(PlannerError):
    """Base for every pricing failure."""


class PriceCardNotFoundError(PricingError):
    """No card in the catalog covers this model at this version."""

    def __init__(self, model_id: str, detail: str = "") -> None:
        self.model_id = model_id
        suffix = f" ({detail})" if detail else ""
        super().__init__(f"no price card for model {model_id!r}{suffix}")


class MissingRateError(PricingError):
    """Tokens were billed in a category whose rate is not known.

    Raised instead of returning zero. Zero is only ever a legitimate cost when the
    source states the rate is zero — see ``RateStatus.KNOWN`` with a zero amount.
    """

    def __init__(self, model_id: str, category: str, status: str) -> None:
        self.model_id, self.category, self.status = model_id, category, status
        super().__init__(
            f"cannot price {category} for {model_id!r}: rate is {status} — "
            "refusing to assume zero"
        )


class UnsupportedUsageError(PricingError):
    """The provider does not offer this usage category for this model."""

    def __init__(self, model_id: str, category: str) -> None:
        self.model_id, self.category = model_id, category
        super().__init__(f"{model_id!r} does not support {category}")


class CurrencyMismatchError(PricingError):
    """Two amounts in one quote disagree on currency. No conversion exists here."""

    def __init__(self, expected: str, found: str) -> None:
        self.expected, self.found = expected, found
        super().__init__(
            f"currency mismatch in one quote: expected {expected}, found {found} — "
            "conversion is a separate module and is not part of pricing"
        )


class CatalogIntegrityError(PricingError):
    """The catalog is internally inconsistent — overlapping or malformed cards."""
