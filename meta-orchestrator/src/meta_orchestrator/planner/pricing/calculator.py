"""Deterministic cost calculation: ``TokenUsage + PriceCard -> CostQuote``.

The calculator knows nothing about how many tokens a task will use. It is handed
counts and returns what they cost. Keeping estimation out of here is what makes this
module testable on its own — a wrong price and a wrong token guess are different bugs
and should not be able to hide each other.

Fail-closed rule: tokens in a category whose rate is not ``KNOWN`` raise. They are
never priced at zero, never at a sibling model's rate, never at an average.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Iterable, Optional

from ..contracts.money import Money
from .catalog import PricingCatalog
from .entities import PriceCard, RateStatus, TokenUsage, UsageCategory
from .errors import MissingRateError, UnsupportedUsageError
from .quote import ComponentStatus, CostComponent, CostQuote, QuoteSet, RoundingPolicy


class CostCalculator:
    """Prices a usage against a card. Stateless, deterministic, offline.

    No network, no clock, no randomness: the same inputs always produce the same quote
    and the same ``audit_hash``.
    """

    def __init__(self, catalog: Optional[PricingCatalog] = None) -> None:
        self._catalog = catalog or PricingCatalog.default()

    @property
    def catalog(self) -> PricingCatalog:
        return self._catalog

    def pricing_ref(self) -> str:
        return self._catalog.pricing_ref()

    # --- core ---
    def quote_with_card(self, usage: TokenUsage, card: PriceCard) -> CostQuote:
        """Price ``usage`` against exactly one card."""
        card.verify_hash()

        components: list[CostComponent] = []
        unresolved: list[UsageCategory] = []
        warnings: list[str] = []
        total = Money.zero(card.currency)

        for category, tokens in usage.by_category().items():
            rate = card.rate_for(category)

            if rate.is_known:
                # Full precision: the per-token rate is not rounded before scaling, and
                # the component is not rounded before it joins the total.
                cost = Money(amount=Decimal(tokens) * rate.per_token(),
                             currency=card.currency)
                components.append(CostComponent(
                    category=category, tokens=tokens, rate=rate,
                    cost=cost, status=ComponentStatus.PRICED))
                total = total + cost
                continue

            # Rate is not known. Non-zero tokens cannot be priced at all.
            if tokens > 0:
                if rate.status is RateStatus.UNSUPPORTED:
                    raise UnsupportedUsageError(card.model_id, category.value)
                raise MissingRateError(card.model_id, category.value, rate.status.value)

            # Zero tokens against an unknown rate: contributes nothing, but is reported
            # as not-applicable rather than as "priced at zero".
            unresolved.append(category)
            warnings.append(
                f"{category.value} rate is {rate.status.value} for {card.model_id!r}; "
                "zero tokens were billed there, so this quote is unaffected — but the "
                "same card cannot price non-zero usage in that category")
            components.append(CostComponent(
                category=category, tokens=0, rate=rate,
                cost=None, status=ComponentStatus.NOT_APPLICABLE))

        return CostQuote(
            provider=card.provider,
            model_id=card.model_id,
            provider_model_snapshot=card.provider_model_snapshot,
            currency=card.currency,
            pricing_version=card.pricing_version,
            card_id=card.card_id,
            card_content_hash=card.content_hash,
            catalog_version=self._catalog.catalog_version,
            usage=usage,
            components=components,
            total=total,
            rounding_policy=RoundingPolicy.NONE,
            warnings=warnings,
            unresolved=unresolved,
        )

    def quote(self, usage: TokenUsage, *, model_id: str,
              at: Optional[str] = None) -> CostQuote:
        """Look up the card in force for ``model_id`` and price ``usage`` against it."""
        return self.quote_with_card(usage, self._catalog.card_for(model_id, at=at))

    def quote_many(self, usage: TokenUsage, *, model_ids: Iterable[str],
                   at: Optional[str] = None) -> QuoteSet:
        """One complete quote per model.

        Each is built independently on its own card, so no figure ever combines one
        model's input rate with another's output rate. Comparison happens over whole
        quotes — see :meth:`QuoteSet.dearest`.
        """
        return QuoteSet(quotes=[self.quote(usage, model_id=mid, at=at)
                                for mid in model_ids])

    def reprice(self, quote: CostQuote) -> CostQuote:
        """Re-derive a historical quote from the exact card it was issued under.

        Uses ``card_content_hash``, not ``model_id``, so a later price change cannot
        silently rewrite what an old quote said.
        """
        card = self._catalog.card_by_hash(quote.card_content_hash)
        return self.quote_with_card(quote.usage, card)
