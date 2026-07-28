"""The output of pricing: a per-category breakdown and the total that follows from it.

A quote is evidence, not a number. It records the usage, the rates, the card version
and the hash it was computed under, so the same figure can be re-derived later even
after the catalog has moved on. ``total`` is always the sum of ``components`` — never
stored independently, never rounded before summation.

Rounding is a presentation concern. The core keeps full ``Decimal`` precision, because
truncating each component before adding them is how a total drifts away from the sum
of its parts.
"""
from __future__ import annotations

import json
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.money import Money
from .entities import (
    PriceRate,
    PriceTrust,
    RateStatus,
    TokenUsage,
    UsageCategory,
    display_hash,
    full_sha256,
)
from .errors import CurrencyMismatchError


class RoundingPolicy(str, Enum):
    """How a quote was rounded. ``NONE`` is the only policy the core uses."""

    NONE = "none"


class ComponentStatus(str, Enum):
    PRICED = "priced"
    #: Zero tokens in a category whose rate is not known. Contributes nothing, and is
    #: reported as not-applicable rather than as "priced at zero" — the distinction
    #: matters when the same card is later used with non-zero usage there.
    NOT_APPLICABLE = "not_applicable"


class CostComponent(BaseModel):
    """One billed category: how many tokens, at what rate, for how much."""

    model_config = ConfigDict(frozen=True)

    category: UsageCategory
    tokens: int
    rate: PriceRate
    cost: Optional[Money] = None
    status: ComponentStatus

    @model_validator(mode="after")
    def _coherent(self) -> "CostComponent":
        if self.status is ComponentStatus.PRICED:
            if self.cost is None:
                raise ValueError(f"{self.category.value} is PRICED but carries no cost")
            if not self.rate.is_known:
                raise ValueError(
                    f"{self.category.value} is PRICED against a {self.rate.status.value} rate")
        else:
            if self.tokens != 0:
                raise ValueError(
                    f"{self.category.value} has {self.tokens} tokens and cannot be "
                    "NOT_APPLICABLE — an unpriced non-zero category must fail the quote")
            if self.cost is not None:
                raise ValueError("a NOT_APPLICABLE component must not carry a cost")
        return self

    def effective_cost(self, currency: str) -> Money:
        """Contribution to the total. Zero for a not-applicable, zero-token category."""
        return self.cost if self.cost is not None else Money.zero(currency)


class CostQuote(BaseModel):
    """A deterministic, reproducible price for one model and one usage.

    Deliberately single-model: a quote never mixes rates across models. Comparison
    happens over complete quotes, after each has been built on its own card — the same
    rule the G2 fix established in the orchestrator, fixed here in the product module
    so it cannot drift back.
    """

    model_config = ConfigDict(frozen=True)

    provider: str
    model_id: str
    provider_model_snapshot: Optional[str] = None
    currency: str

    pricing_version: str
    card_id: str
    #: Full 64-hex SHA-256 of the card. The canonical binding between quote and price.
    card_content_hash: str
    catalog_version: str
    #: How far the underlying rate may be trusted.
    price_trust: PriceTrust
    #: False whenever the rate is TEST_ONLY, FICTIONAL or UNVERIFIED. A future
    #: BudgetGuard must refuse such a quote for a real budget; the flag is carried on
    #: the quote so that refusal needs no lookup back into the catalog.
    authoritative_for_real_spend: bool

    usage: TokenUsage
    components: list[CostComponent]
    total: Money

    rounding_policy: RoundingPolicy = RoundingPolicy.NONE
    warnings: list[str] = Field(default_factory=list)
    #: Categories this card has no usable rate for. Zero tokens were billed against
    #: them — non-zero usage there raises instead of producing a quote — so the total
    #: is exact regardless. Informational: it says what this card *could not* price,
    #: not that this quote is incomplete.
    unresolved: list[UsageCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def _total_is_the_sum(self) -> "CostQuote":
        if len(self.components) != len(UsageCategory):
            raise ValueError("a quote must carry one component per usage category")
        seen = [c.category for c in self.components]
        if len(set(seen)) != len(seen):
            raise ValueError("duplicate category in quote components")

        summed = Money.zero(self.currency)
        for component in self.components:
            cost = component.effective_cost(self.currency)
            if cost.currency != self.currency:
                raise CurrencyMismatchError(self.currency, cost.currency)
            summed = summed + cost
        if summed.amount != self.total.amount:
            raise ValueError(
                f"total {self.total} is not the sum of its components ({summed}) — "
                "the breakdown is the authority")
        if self.total.currency != self.currency:
            raise CurrencyMismatchError(self.currency, self.total.currency)
        return self

    def component(self, category: UsageCategory) -> CostComponent:
        for c in self.components:
            if c.category is category:
                return c
        raise KeyError(category)

    def cost_of(self, category: UsageCategory) -> Money:
        return self.component(category).effective_cost(self.currency)

    @property
    def is_fully_priced(self) -> bool:
        """True when every category carrying tokens was priced against a known rate.

        An invariant rather than a filter: the calculator raises on non-zero usage in
        an unpriced category, so a constructed quote always satisfies this. It is
        asserted here so the guarantee is checkable rather than assumed.
        """
        return all(c.status is ComponentStatus.PRICED
                   for c in self.components if c.tokens > 0)

    @property
    def has_unpriceable_categories(self) -> bool:
        """Whether the card lacks a rate for some category — cache, typically.

        Distinct from :attr:`is_fully_priced`: this quote's total is exact, but the
        same card would fail on usage in those categories.
        """
        return bool(self.unresolved)

    def canonical_payload(self) -> dict[str, Any]:
        """Stable dict for serialization and hashing.

        Amounts are rendered as strings, not floats: a canonical form that round-trips
        through binary floating point is not canonical.
        """
        return {
            "provider": self.provider,
            "model_id": self.model_id,
            "provider_model_snapshot": self.provider_model_snapshot,
            "currency": self.currency,
            "pricing_version": self.pricing_version,
            "card_id": self.card_id,
            "card_content_hash": self.card_content_hash,
            "catalog_version": self.catalog_version,
            "usage": {
                "input_tokens": self.usage.input_tokens,
                "output_tokens": self.usage.output_tokens,
                "cache_read_tokens": self.usage.cache_read_tokens,
                "cache_write_tokens": self.usage.cache_write_tokens,
            },
            "components": [
                {
                    "category": c.category.value,
                    "tokens": c.tokens,
                    "rate_status": c.rate.status.value,
                    "rate_amount": c.rate.amount,
                    "rate_unit": c.rate.unit.value,
                    "cost": str(c.cost.amount) if c.cost is not None else None,
                    "status": c.status.value,
                }
                for c in sorted(self.components, key=lambda c: c.category.value)
            ],
            "total": str(self.total.amount),
            "price_trust": self.price_trust.value,
            "authoritative_for_real_spend": self.authoritative_for_real_spend,
            "rounding_policy": self.rounding_policy.value,
            "unresolved": sorted(c.value for c in self.unresolved),
            "warnings": self.warnings,
        }

    def canonical_json(self) -> str:
        return json.dumps(self.canonical_payload(), sort_keys=True, separators=(",", ":"))

    def audit_hash(self) -> str:
        """Full 64-hex SHA-256 of the canonical form — the quote's identity."""
        return full_sha256(self.canonical_json())

    def display_audit_hash(self) -> str:
        """Short prefix for logs. Derived from the full hash; never compared on."""
        return display_hash(self.audit_hash())

    def display_total(self, places: str = "0.0001") -> Money:
        """Rounded for presentation only. Never fed back into a calculation."""
        return self.total.quantized(Decimal(places))


class QuoteSet(BaseModel):
    """Complete quotes for several models, kept whole so they can be compared safely.

    ``cheapest`` and ``dearest`` select an entire quote. They never assemble a synthetic
    price from one model's input rate and another's output rate — that was G2, and it
    is not reintroduced here.
    """

    model_config = ConfigDict(frozen=True)

    quotes: list[CostQuote]

    @model_validator(mode="after")
    def _comparable(self) -> "QuoteSet":
        if not self.quotes:
            raise ValueError("a QuoteSet needs at least one quote")
        currencies = {q.currency for q in self.quotes}
        if len(currencies) > 1:
            raise CurrencyMismatchError(self.quotes[0].currency,
                                        sorted(currencies - {self.quotes[0].currency})[0])
        ids = [q.model_id for q in self.quotes]
        if len(set(ids)) != len(ids):
            raise ValueError("a QuoteSet must hold at most one quote per model")
        return self

    @property
    def currency(self) -> str:
        return self.quotes[0].currency

    def cheapest(self) -> CostQuote:
        return min(self.quotes, key=lambda q: q.total.amount)

    def dearest(self) -> CostQuote:
        """Worst case across candidates — the whole quote, not a max over rates.

        Selecting a complete quote is the point. Taking ``max`` over each rate
        independently would price a run at one model's input rate and another's
        output rate, which is the G2 defect in a new place.
        """
        return max(self.quotes, key=lambda q: q.total.amount)

    def for_model(self, model_id: str) -> CostQuote:
        for q in self.quotes:
            if q.model_id == model_id:
                return q
        raise KeyError(model_id)
