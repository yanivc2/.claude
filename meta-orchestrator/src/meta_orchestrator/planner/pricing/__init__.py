"""Product-owned pricing (P1a).

Answers one question — *what does this usage cost?* — and deliberately not the other
one, *how much usage will there be?* That belongs to a future estimator; keeping the
two apart means a wrong price and a wrong token count stay distinguishable bugs.

    TokenUsage + PriceCard -> CostQuote

Properties this module holds to:

* ``Decimal`` everywhere on the money path. The single float boundary is ``compat``,
  and it is documented as narrowing rather than closing that risk.
* An unknown rate is never zero, never a sibling model's rate, never an average. It
  raises when tokens are billed against it.
* A quote is single-model. Comparison happens over whole quotes, never by combining
  one model's input rate with another's output rate — that was G2.
* ``total`` is always the sum of ``components``, at full precision. Rounding is a
  presentation step.
* Everything is versioned and content-addressed, so a historical quote re-derives.

No network, no clock, no randomness, and no dependency on ``experiment/s2`` — the §2
pricing module is read as a reference and corroborating document, never imported.
"""
from __future__ import annotations

from .calculator import CostCalculator
from .catalog import (
    CATALOG_VERSION,
    PRICING_VERSION,
    PricingCatalog,
    default_price_cards,
)
from .compat import LEGACY_BOUNDARY_NOTE, price_card_from_model_spec
from .entities import (
    BILLABLE_TRUST,
    DISPLAY_HASH_CHARS,
    TOKENS_PER_MTOK,
    PriceCard,
    PriceRate,
    PricingUnit,
    PriceTrust,
    RateStatus,
    TokenUsage,
    UsageCategory,
    display_hash,
    full_sha256,
)
from .errors import (
    CatalogIntegrityError,
    CurrencyMismatchError,
    MissingRateError,
    PriceCardNotFoundError,
    PricingError,
    UnsupportedUsageError,
)
from .quote import (
    ComponentStatus,
    CostComponent,
    CostQuote,
    QuoteSet,
    RoundingPolicy,
)

__all__ = [
    "CostCalculator",
    "PricingCatalog", "default_price_cards", "PRICING_VERSION", "CATALOG_VERSION",
    "PriceCard", "PriceRate", "PricingUnit", "RateStatus", "TokenUsage",
    "UsageCategory", "TOKENS_PER_MTOK", "PriceTrust", "BILLABLE_TRUST",
    "full_sha256", "display_hash", "DISPLAY_HASH_CHARS",
    "CostQuote", "CostComponent", "ComponentStatus", "QuoteSet", "RoundingPolicy",
    "price_card_from_model_spec", "LEGACY_BOUNDARY_NOTE",
    "PricingError", "PriceCardNotFoundError", "MissingRateError",
    "UnsupportedUsageError", "CurrencyMismatchError", "CatalogIntegrityError",
]
