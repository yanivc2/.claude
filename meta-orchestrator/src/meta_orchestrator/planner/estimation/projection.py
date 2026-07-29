"""Cost projection — the seam between a token estimate and a price.

Deliberately a separate object from the estimator. The estimator does not know prices
and the calculator does not know how many tokens there will be; this is the only place
the two meet, and it meets them through the public pricing surface rather than by
reaching inside it.

The rule that matters here: **a missing price must not destroy a good token estimate.**
When a rate is unknown the projection reports itself unavailable, with a reason, and
the ``UsageEstimate`` stands untouched. A token count is useful on its own.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.money import Money, MoneyRange
from ..pricing import CostCalculator, CostQuote, PriceTrust, PricingError, TokenUsage
from .entities import Band, UsageEstimate


class ModelCostProjection(BaseModel):
    """Projected cost of one estimate on one model.

    Three whole quotes — best, expected, worst — each priced on the same card. Never a
    blend: the G2 rule holds here as it does in the calculator.
    """

    model_config = ConfigDict(frozen=True)

    model_id: str
    available: bool
    #: Present only when ``available``.
    range: Optional[MoneyRange] = None
    best_quote: Optional[CostQuote] = None
    expected_quote: Optional[CostQuote] = None
    worst_quote: Optional[CostQuote] = None
    price_trust: Optional[PriceTrust] = None
    authoritative_for_real_spend: bool = False
    #: When the price behind this projection was last verified (ISO-8601 date).
    #: Carried up from the card so a freshness policy has something to check.
    price_verified_at: str = ""
    price_card_id: str = ""
    unavailable_reason: str = ""
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _coherent(self) -> "ModelCostProjection":
        if self.available:
            if self.range is None or self.expected_quote is None:
                raise ValueError("an available projection must carry a range and quotes")
        else:
            if not self.unavailable_reason.strip():
                raise ValueError("an unavailable projection must say why")
            if self.range is not None:
                raise ValueError("an unavailable projection must not carry a range")
        return self

    @property
    def expected(self) -> Optional[Money]:
        return self.range.expected if self.range else None


class CostProjection(BaseModel):
    """Projections across every candidate model, kept whole and comparable."""

    model_config = ConfigDict(frozen=True)

    estimate_audit_hash: str
    pricing_ref: str
    projections: list[ModelCostProjection]

    @property
    def available(self) -> list[ModelCostProjection]:
        return [p for p in self.projections if p.available]

    @property
    def billable(self) -> list[ModelCostProjection]:
        """Projections that could back a real budget — real prices only."""
        return [p for p in self.available if p.authoritative_for_real_spend]

    def cheapest(self) -> Optional[ModelCostProjection]:
        priced = self.available
        if not priced:
            return None
        return min(priced, key=lambda p: p.range.expected.amount)   # type: ignore[union-attr]

    def dearest(self) -> Optional[ModelCostProjection]:
        priced = self.available
        if not priced:
            return None
        return max(priced, key=lambda p: p.range.worst.amount)      # type: ignore[union-attr]

    def for_model(self, model_id: str) -> ModelCostProjection:
        for p in self.projections:
            if p.model_id == model_id:
                return p
        raise KeyError(model_id)


class EstimateProjector:
    """Prices a :class:`UsageEstimate` through the pricing module's public surface."""

    def __init__(self, calculator: Optional[CostCalculator] = None) -> None:
        self._calc = calculator or CostCalculator()

    @staticmethod
    def _usage_at(estimate: UsageEstimate, pick) -> TokenUsage:
        """Build a usage from one corner of the bands.

        Cache tokens are zero: no cache rate is known for any model, so claiming cache
        usage would only make the projection fail. The estimate records the caching
        expectation separately.
        """
        return TokenUsage(
            input_tokens=pick(estimate.input_tokens),
            output_tokens=pick(estimate.output_tokens),
        )

    def project(self, estimate: UsageEstimate, *, model_ids: list[str],
                at: Optional[str] = None) -> CostProjection:
        projections: list[ModelCostProjection] = []

        for model_id in model_ids:
            try:
                best = self._calc.quote(
                    self._usage_at(estimate, lambda b: b.best), model_id=model_id, at=at)
                expected = self._calc.quote(
                    self._usage_at(estimate, lambda b: b.expected), model_id=model_id, at=at)
                worst = self._calc.quote(
                    self._usage_at(estimate, lambda b: b.worst), model_id=model_id, at=at)
            except PricingError as exc:
                # The token estimate remains valid — only the money is unavailable.
                projections.append(ModelCostProjection(
                    model_id=model_id, available=False,
                    unavailable_reason=str(exc)))
                continue

            warnings: list[str] = []
            if not expected.authoritative_for_real_spend:
                warnings.append(
                    f"price trust is {expected.price_trust.value}: this projection may "
                    "not back a real budget")
            if estimate.partial:
                warnings.append(
                    "the underlying token estimate is partial; the cost inherits that")

            projections.append(ModelCostProjection(
                model_id=model_id,
                available=True,
                range=MoneyRange(best=best.total, expected=expected.total,
                                 worst=worst.total),
                best_quote=best, expected_quote=expected, worst_quote=worst,
                price_trust=expected.price_trust,
                authoritative_for_real_spend=expected.authoritative_for_real_spend,
                price_verified_at=self._calc.catalog.card_by_hash(
                    expected.card_content_hash).source_verified_at,
                price_card_id=expected.card_id,
                warnings=warnings,
            ))

        return CostProjection(
            estimate_audit_hash=estimate.audit_hash(),
            pricing_ref=self._calc.pricing_ref(),
            projections=projections,
        )
